/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strands Connector
 * Integrates with Amazon Strands agents via Bedrock Agent Runtime API
 * Server-only: requires AWS SDK
 */

import type { TrajectoryStep, ToolCallStatus } from '@/types';
import { BaseConnector } from '@/connectors/base';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/connectors/types';

/**
 * Configuration for Strands connector
 */
export interface StrandsConfig {
  agentAliasId: string;
  region?: string;
  sessionId?: string;
  enableTrace?: boolean;
}

/**
 * Strands Connector for Amazon Bedrock Agent Runtime
 *
 * Uses InvokeAgent API to execute Strands agents and parses
 * trace events into TrajectorySteps for evaluation.
 *
 * Configuration:
 * - endpoint: The Bedrock Agent ID (e.g., "ABCDEF1234")
 * - connectorConfig.agentAliasId: Agent alias ID (e.g., "TSTALIASID")
 * - connectorConfig.region: AWS region (defaults to AWS_REGION env var)
 * - auth: AWS SigV4 credentials (or uses default provider chain)
 */
export class StrandsConnector extends BaseConnector {
  readonly type = 'strands' as const;
  readonly name = 'Amazon Strands';
  readonly supportsStreaming = true;

  buildPayload(request: ConnectorRequest): any {
    const config = (request.connectorConfig || {}) as Partial<StrandsConfig>;
    return {
      agentId: '', // Set from endpoint in execute()
      agentAliasId: config.agentAliasId || 'TSTALIASID',
      sessionId: config.sessionId || `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      inputText: request.testCase.initialPrompt,
      enableTrace: config.enableTrace !== false,
    };
  }

  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const payload = request.payload || this.buildPayload(request);
    payload.agentId = endpoint; // Agent ID is the endpoint

    const config = (request.connectorConfig || {}) as Partial<StrandsConfig>;
    const region = config.region || auth.awsRegion || process.env.AWS_REGION || 'us-east-1';

    this.debug('Executing Strands agent');
    this.debug('Agent ID:', endpoint);
    this.debug('Alias:', payload.agentAliasId);
    this.debug('Region:', region);

    // Dynamically import AWS SDK to keep module tree-shakeable
    const { BedrockAgentRuntimeClient, InvokeAgentCommand } = await import(
      '@aws-sdk/client-bedrock-agent-runtime'
    );

    const clientConfig: Record<string, any> = { region };

    // Use explicit credentials if provided via auth
    if (auth.type === 'aws-sigv4' && auth.awsAccessKeyId && auth.awsSecretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: auth.awsAccessKeyId,
        secretAccessKey: auth.awsSecretAccessKey,
        ...(auth.awsSessionToken && { sessionToken: auth.awsSessionToken }),
      };
    }

    const client = new BedrockAgentRuntimeClient(clientConfig);

    const command = new InvokeAgentCommand({
      agentId: payload.agentId,
      agentAliasId: payload.agentAliasId,
      sessionId: payload.sessionId,
      inputText: payload.inputText,
      enableTrace: payload.enableTrace,
    });

    const response = await client.send(command);
    const trajectory: TrajectoryStep[] = [];
    let finalOutput = '';

    // Process streaming response
    if (response.completion) {
      for await (const event of response.completion) {
        onRawEvent?.(event);

        if (event.chunk?.bytes) {
          const text = new TextDecoder().decode(event.chunk.bytes);
          finalOutput += text;
        }

        if (event.trace?.trace) {
          const traceSteps = this.parseTraceEvent(event.trace.trace);
          for (const step of traceSteps) {
            trajectory.push(step);
            onProgress?.(step);
          }
        }
      }
    }

    // Add final response step only if no response was already emitted from traces
    const hasResponseFromTrace = trajectory.some(s => s.type === 'response');
    if (finalOutput && !hasResponseFromTrace) {
      const responseStep = this.createStep('response', finalOutput);
      trajectory.push(responseStep);
      onProgress?.(responseStep);
    }

    return {
      trajectory,
      runId: payload.sessionId,
      metadata: {
        agentId: endpoint,
        agentAliasId: payload.agentAliasId,
        sessionId: payload.sessionId,
        region,
      },
    };
  }

  parseResponse(rawResponse: any): TrajectoryStep[] {
    if (rawResponse?.trace?.trace) {
      return this.parseTraceEvent(rawResponse.trace.trace);
    }
    if (typeof rawResponse === 'string') {
      return [this.createStep('response', rawResponse)];
    }
    return [];
  }

  /**
   * Parse a Bedrock Agent trace event into TrajectorySteps
   */
  private parseTraceEvent(trace: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // Pre-processing trace
    if (trace.preProcessingTrace) {
      const pre = trace.preProcessingTrace;
      if (pre.modelInvocationOutput?.parsedResponse?.isValid !== undefined) {
        steps.push(this.createStep('thinking',
          `Pre-processing: Input ${pre.modelInvocationOutput.parsedResponse.isValid ? 'valid' : 'invalid'}` +
          (pre.modelInvocationOutput.parsedResponse.rationale
            ? ` — ${pre.modelInvocationOutput.parsedResponse.rationale}`
            : '')
        ));
      }
    }

    // Orchestration trace (main reasoning + tool use)
    if (trace.orchestrationTrace) {
      const orch = trace.orchestrationTrace;

      // Rationale (thinking)
      if (orch.rationale?.text) {
        steps.push(this.createStep('thinking', orch.rationale.text));
      }

      // Model invocation input
      if (orch.modelInvocationInput?.text) {
        steps.push(this.createStep('thinking', `Model input: ${this.truncate(orch.modelInvocationInput.text, 500)}`));
      }

      // Tool invocation
      if (orch.invocationInput) {
        const inv = orch.invocationInput;

        if (inv.actionGroupInvocationInput) {
          const action = inv.actionGroupInvocationInput;
          steps.push(this.createStep('action', `Calling ${action.actionGroupName || 'action'}::${action.apiPath || action.function || 'invoke'}`, {
            toolName: `${action.actionGroupName || 'action'}::${action.apiPath || action.function || 'invoke'}`,
            toolArgs: action.parameters ? Object.fromEntries(
              action.parameters.map((p: any) => [p.name, p.value])
            ) : undefined,
          }));
        }

        if (inv.knowledgeBaseLookupInput) {
          steps.push(this.createStep('action', `Knowledge base lookup: ${inv.knowledgeBaseLookupInput.text}`, {
            toolName: 'knowledge_base_lookup',
            toolArgs: { query: inv.knowledgeBaseLookupInput.text },
          }));
        }
      }

      // Tool observation (result)
      if (orch.observation) {
        const obs = orch.observation;

        if (obs.actionGroupInvocationOutput?.text) {
          steps.push(this.createStep('tool_result', obs.actionGroupInvocationOutput.text, {
            status: 'SUCCESS' as ToolCallStatus,
          }));
        }

        if (obs.knowledgeBaseLookupOutput?.retrievedReferences) {
          const refs = obs.knowledgeBaseLookupOutput.retrievedReferences;
          steps.push(this.createStep('tool_result',
            `Retrieved ${refs.length} reference(s) from knowledge base`, {
            status: 'SUCCESS' as ToolCallStatus,
            toolOutput: refs.map((r: any) => ({
              content: this.truncate(r.content?.text, 200),
              location: r.location,
            })),
          }));
        }

        if (obs.finalResponse?.text) {
          steps.push(this.createStep('response', obs.finalResponse.text));
        }
      }
    }

    // Post-processing trace
    if (trace.postProcessingTrace) {
      const post = trace.postProcessingTrace;
      if (post.modelInvocationOutput?.parsedResponse?.text) {
        steps.push(this.createStep('thinking',
          `Post-processing: ${this.truncate(post.modelInvocationOutput.parsedResponse.text, 300)}`
        ));
      }
    }

    // Failure trace
    if (trace.failureTrace) {
      steps.push(this.createStep('response',
        `Agent error: ${trace.failureTrace.failureReason || 'Unknown failure'}`
      ));
    }

    return steps;
  }

  /**
   * Health check: verify the agent exists via GetAgent
   */
  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    try {
      const config = auth as any;
      const region = config.awsRegion || process.env.AWS_REGION || 'us-east-1';

      const { BedrockAgentClient, GetAgentCommand } = await import(
        '@aws-sdk/client-bedrock-agent'
      );

      const clientConfig: Record<string, any> = { region };
      if (auth.type === 'aws-sigv4' && auth.awsAccessKeyId && auth.awsSecretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: auth.awsAccessKeyId,
          secretAccessKey: auth.awsSecretAccessKey,
          ...(auth.awsSessionToken && { sessionToken: auth.awsSessionToken }),
        };
      }

      const client = new BedrockAgentClient(clientConfig);
      const result = await client.send(new GetAgentCommand({ agentId: endpoint }));
      return result.agent?.agentStatus === 'PREPARED';
    } catch (error) {
      this.error('Health check failed:', error);
      return false;
    }
  }

  private truncate(text: string | undefined, maxLen: number): string {
    if (!text) return '';
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
  }
}

export const strandsConnector = new StrandsConnector();
