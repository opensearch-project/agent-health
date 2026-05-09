/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Assistant Service - AI assistant powered by Claude CLI or fallback LLM provider
 *
 * Provides streaming conversational AI with in-memory session management.
 * Primary: spawns `claude` CLI with NDJSON streaming.
 * Fallback: uses configured LLM judge provider (Bedrock or LiteLLM).
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfigSync } from '@/lib/config/index';
import { debug } from '@/lib/debug';
import serverConfig from '@/server/config/index';
import type { AssistantMessage, AssistantContext } from '@/types';

// ============================================================================
// Constants
// ============================================================================

/** Path to the AGENT_HEALTH.md skill file */
const AGENT_HEALTH_SKILL_PATH = resolve(process.cwd(), 'docs/skills/AGENT_HEALTH.md');

/** Session TTL: 30 minutes in milliseconds */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Timeout for the claude CLI process (3 minutes) */
const CLAUDE_TIMEOUT_MS = 180_000;

/** Cleanup interval: check for expired sessions every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// ============================================================================
// Session Store
// ============================================================================

interface Session {
  messages: AssistantMessage[];
  lastAccessed: number;
}

/** In-memory session store with TTL */
const sessions = new Map<string, Session>();

/** Periodic cleanup of expired sessions */
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TTL_MS) {
      debug('Assistant', 'Expiring session:', sessionId);
      sessions.delete(sessionId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Prevent the cleanup timer from keeping the process alive
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

/**
 * Get or create a session
 */
function getSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { messages: [], lastAccessed: Date.now() };
    sessions.set(sessionId, session);
  }
  session.lastAccessed = Date.now();
  return session;
}

// ============================================================================
// System Prompt
// ============================================================================

/**
 * Load the AGENT_HEALTH.md skill content for the system prompt.
 * Returns empty string if file is not found.
 */
export function loadSkillContent(): string {
  try {
    return readFileSync(AGENT_HEALTH_SKILL_PATH, 'utf-8');
  } catch {
    debug('Assistant', 'AGENT_HEALTH.md not found at', AGENT_HEALTH_SKILL_PATH);
    return '';
  }
}

/**
 * Build the system prompt from skill content and page context
 */
export function buildSystemPrompt(context?: AssistantContext): string {
  const skillContent = loadSkillContent();

  let systemPrompt = `You are an AI assistant for Agent Health, an evaluation framework for Root Cause Analysis (RCA) agents. Help users understand evaluation results, configure agents, interpret trajectories, and improve agent performance.

Be concise and helpful. When discussing specific benchmarks, runs, or test cases, reference them by name when possible.`;

  if (skillContent) {
    systemPrompt += `\n\n---\n\n## Agent Health Reference\n\n${skillContent}`;
  }

  if (context) {
    systemPrompt += '\n\n---\n\n## Current Page Context\n';
    if (context.currentUrl) {
      systemPrompt += `\nThe user is currently viewing: ${context.currentUrl}`;
    }
    if (context.benchmarkId) {
      systemPrompt += `\nActive benchmark ID: ${context.benchmarkId}`;
    }
    if (context.runId) {
      systemPrompt += `\nActive run ID: ${context.runId}`;
    }
    if (context.traceId) {
      systemPrompt += `\nActive trace ID: ${context.traceId}`;
    }
    if (context.testCaseId) {
      systemPrompt += `\nActive test case ID: ${context.testCaseId}`;
    }
  }

  return systemPrompt;
}

// ============================================================================
// Claude CLI Availability Check
// ============================================================================

/** Cached result of claude CLI availability check */
let claudeAvailableCache: boolean | null = null;

/**
 * Check if the claude CLI is available on the system
 */
export function isClaudeAvailable(): boolean {
  if (claudeAvailableCache !== null) {
    return claudeAvailableCache;
  }

  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    claudeAvailableCache = true;
    debug('Assistant', 'Claude CLI is available');
  } catch {
    claudeAvailableCache = false;
    debug('Assistant', 'Claude CLI is not available');
  }

  return claudeAvailableCache;
}

// ============================================================================
// Claude CLI Streaming (Primary)
// ============================================================================

/**
 * Build conversation history as a single prompt string for claude CLI.
 * The claude CLI does not natively support multi-turn via stdin,
 * so we format the history as a structured conversation.
 */
function buildConversationPrompt(messages: AssistantMessage[]): string {
  if (messages.length === 1) {
    return messages[0].content;
  }

  return messages
    .map((msg) => {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      return `${prefix}: ${msg.content}`;
    })
    .join('\n\n');
}

/**
 * Stream response from claude CLI using NDJSON output format.
 *
 * Spawns: `claude --print --verbose --output-format stream-json`
 * Parses NDJSON lines with type "assistant" and subtype "text" for content deltas.
 */
function streamFromClaude(
  messages: AssistantMessage[],
  systemPrompt: string,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): ChildProcess {
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--append-system-prompt', systemPrompt,
  ];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_USE_BEDROCK: '1',
    DISABLE_PROMPT_CACHING: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    ANTHROPIC_API_KEY: '',
  };

  // Inherit AWS_PROFILE and AWS_REGION from process env
  if (process.env.AWS_PROFILE) {
    env.AWS_PROFILE = process.env.AWS_PROFILE;
  }
  if (process.env.AWS_REGION) {
    env.AWS_REGION = process.env.AWS_REGION;
  }

  debug('Assistant', 'Spawning claude CLI with stream-json output');

  const child = spawn('claude', args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: CLAUDE_TIMEOUT_MS,
  });

  let fullResponse = '';
  let buffer = '';
  let stderr = '';

  child.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();

    // Process complete lines (NDJSON format: one JSON object per line)
    const lines = buffer.split('\n');
    // Keep the last potentially incomplete line in the buffer
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);

        // Extract text content from assistant text events
        if (parsed.type === 'assistant' && parsed.subtype === 'text' && parsed.content) {
          fullResponse += parsed.content;
          onDelta(parsed.content);
        }

        // Handle result event (final response)
        if (parsed.type === 'result' && parsed.result && !fullResponse) {
          fullResponse = parsed.result;
          onDelta(parsed.result);
        }
      } catch {
        // Ignore unparseable lines (e.g., verbose output on stderr)
        debug('Assistant', 'Skipping unparseable NDJSON line:', trimmed.substring(0, 100));
      }
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('error', (error: Error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Reset cache since CLI disappeared
      claudeAvailableCache = null;
      onError('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code');
    } else {
      onError(error.message);
    }
  });

  child.on('close', (code: number | null, signal: string | null) => {
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.type === 'assistant' && parsed.subtype === 'text' && parsed.content) {
          fullResponse += parsed.content;
          onDelta(parsed.content);
        }
        if (parsed.type === 'result' && parsed.result && !fullResponse) {
          fullResponse = parsed.result;
        }
      } catch {
        // Ignore
      }
    }

    if (code !== 0) {
      const errorMsg = signal === 'SIGTERM'
        ? `Claude CLI timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`
        : stderr.trim() || `Claude CLI exited with code ${code}`;
      onError(errorMsg);
      return;
    }

    onDone(fullResponse);
  });

  // Write conversation prompt to stdin and close
  child.stdin.on('error', () => { /* handled by 'close' event */ });
  const prompt = buildConversationPrompt(messages);
  child.stdin.write(prompt);
  child.stdin.end();

  return child;
}

// ============================================================================
// Bedrock Fallback (Streaming)
// ============================================================================

/**
 * Stream response from AWS Bedrock using ConverseStream API.
 * Used as fallback when claude CLI is not available.
 */
async function streamFromBedrock(
  messages: AssistantMessage[],
  systemPrompt: string,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): Promise<void> {
  try {
    // Dynamic import to avoid top-level AWS SDK dependency (breaks Jest coverage instrumentation)
    const { BedrockRuntimeClient, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');

    const client = new BedrockRuntimeClient({
      region: serverConfig.AWS_REGION,
    });

    // Determine model from config
    const appConfig = loadConfigSync();
    const modelId = appConfig.judge?.model || serverConfig.BEDROCK_MODEL_ID;

    debug('Assistant', 'Using Bedrock model:', modelId);

    // Convert messages to Bedrock format
    const bedrockMessages = messages.map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: [{ text: msg.content }],
    }));

    const command = new ConverseStreamCommand({
      modelId,
      messages: bedrockMessages,
      system: [{ text: systemPrompt }],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.7,
      },
    });

    const response = await client.send(command);

    let fullResponse = '';

    if (response.stream) {
      for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta && 'text' in event.contentBlockDelta.delta) {
          const text = event.contentBlockDelta.delta.text || '';
          fullResponse += text;
          onDelta(text);
        }
      }
    }

    onDone(fullResponse);
  } catch (error: any) {
    const msg = error.message || 'Unknown Bedrock error';
    if (msg.includes('ExpiredToken') || msg.includes('CredentialsProviderError')) {
      onError('AWS credentials expired or invalid. Please refresh your AWS credentials.');
    } else if (msg.includes('ThrottlingException')) {
      onError('Bedrock API rate limit exceeded. Please try again in a moment.');
    } else {
      onError(msg);
    }
  }
}

// ============================================================================
// LiteLLM Fallback (Non-streaming)
// ============================================================================

/**
 * Get response from LiteLLM endpoint.
 * Used as fallback when claude CLI is not available and provider is litellm.
 */
async function streamFromLiteLLM(
  messages: AssistantMessage[],
  systemPrompt: string,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): Promise<void> {
  try {
    const appConfig = loadConfigSync();
    const modelId = appConfig.judge?.model || 'gpt-4o';

    debug('Assistant', 'Using LiteLLM model:', modelId, 'endpoint:', serverConfig.OPENAI_COMPATIBLE_ENDPOINT);

    const litellmMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
    ];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (serverConfig.OPENAI_COMPATIBLE_API_KEY) {
      headers['Authorization'] = `Bearer ${serverConfig.OPENAI_COMPATIBLE_API_KEY}`;
    }

    const res = await fetch(serverConfig.OPENAI_COMPATIBLE_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: litellmMessages,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      onError(`LiteLLM responded ${res.status}: ${errorText}`);
      return;
    }

    const data = await res.json();
    const responseText: string = data.choices?.[0]?.message?.content ?? '';

    onDelta(responseText);
    onDone(responseText);
  } catch (error: any) {
    const msg = error.message || 'Unknown LiteLLM error';
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
      onError(`Cannot connect to LiteLLM endpoint (${serverConfig.OPENAI_COMPATIBLE_ENDPOINT}). Ensure the server is running.`);
    } else {
      onError(msg);
    }
  }
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Stream an assistant response for a given session and message.
 *
 * Primary: uses claude CLI with NDJSON streaming.
 * Fallback: uses configured LLM judge provider (Bedrock or LiteLLM).
 */
export function streamAssistantResponse(
  sessionId: string,
  message: string,
  context: AssistantContext | undefined,
  onDelta: (content: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (error: string) => void
): { abort: () => void } {
  const session = getSession(sessionId);

  // Add user message to history
  const userMessage: AssistantMessage = {
    role: 'user',
    content: message,
    timestamp: new Date().toISOString(),
  };
  session.messages.push(userMessage);

  const systemPrompt = buildSystemPrompt(context);

  // Wrap onDone to also store the assistant response
  const handleDone = (fullResponse: string) => {
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: fullResponse,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(assistantMessage);
    onDone(fullResponse);
  };

  // Wrap onError to remove the user message from history on failure
  const handleError = (error: string) => {
    const idx = session.messages.indexOf(userMessage);
    if (idx !== -1) session.messages.splice(idx, 1);
    onError(error);
  };

  let childProcess: ChildProcess | null = null;

  // Primary: try claude CLI
  if (isClaudeAvailable()) {
    debug('Assistant', 'Using claude CLI for session:', sessionId);
    childProcess = streamFromClaude(session.messages, systemPrompt, onDelta, handleDone, handleError);
    return { abort: () => childProcess?.kill() };
  }

  // Fallback: use configured judge provider
  const appConfig = loadConfigSync();
  const provider = appConfig.judge?.provider || 'bedrock';
  debug('Assistant', 'Claude CLI unavailable, falling back to Bedrock (provider:', provider, ')');

  if (provider === 'litellm' || provider === 'openai-compatible') {
    streamFromLiteLLM(session.messages, systemPrompt, onDelta, handleDone, handleError);
  } else {
    streamFromBedrock(session.messages, systemPrompt, onDelta, handleDone, handleError);
  }

  return { abort: () => {} };
}

/**
 * Clear a session and its message history
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
  debug('Assistant', 'Cleared session:', sessionId);
}

/**
 * Get all messages for a session
 */
export function getSessionMessages(sessionId: string): AssistantMessage[] {
  const session = sessions.get(sessionId);
  return session ? [...session.messages] : [];
}
