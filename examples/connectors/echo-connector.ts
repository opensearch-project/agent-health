/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Example: a custom connector that wraps a simple HTTP echo agent.
 *
 * This is the smallest realistic shape of a connector. It implements the
 * three abstract members of `BaseConnector` (`buildPayload`, `execute`,
 * `parseResponse`) plus the three readonly identity fields (`type`,
 * `name`, `supportsStreaming`).
 *
 * Drop this file at `connectors/echo.ts` in your project and register it
 * from your `agent-health.config.ts`:
 *
 * @example
 * ```ts
 * import { defineConfig, registerConnector } from '@opensearch-project/agent-health';
 * import { EchoConnector } from './connectors/echo';
 *
 * registerConnector(new EchoConnector());
 *
 * export default defineConfig({
 *   agents: [
 *     {
 *       key: 'echo',
 *       name: 'Echo Agent',
 *       endpoint: 'http://localhost:8080/echo',
 *       connectorType: 'rest',  // or any registered protocol
 *     },
 *   ],
 * });
 * ```
 *
 * To understand the lifecycle this connector plugs into — abort signal
 * handling, progress callbacks, trajectory shape, raw-event replay —
 * read the base class and types directly in the installed package:
 *
 *     node_modules/@opensearch-project/agent-health/lib/dist/connectors/base/index.js
 *     node_modules/@opensearch-project/agent-health/lib/dist/connectors/types.d.ts
 *
 * The compiled `.js` preserves the original JSDoc, and the matching
 * `.d.ts` next to it gives you the precise type contract — no need to
 * cross-reference an arbitrary GitHub commit, you're reading exactly
 * the version your `package.json` resolved to.
 *
 * NOTE: `ConnectorProtocol` is a closed string-literal union of the
 * built-in protocol ids ('rest', 'agui-streaming', 'subprocess', ...).
 * The simplest path for a custom connector is to reuse one of those ids
 * (e.g. 'rest' for HTTP-JSON agents) and replace the built-in connector
 * via `registerConnector(new EchoConnector())`. If you need a brand-new
 * protocol id, fork this repo and widen the `ConnectorProtocol` union
 * in `connectors/types.ts`.
 */

import {
  BaseConnector,
  type ConnectorAuth,
  type ConnectorRequest,
  type ConnectorResponse,
  type ConnectorProgressCallback,
  type ConnectorRawEventCallback,
} from '@opensearch-project/agent-health';

import type { TrajectoryStep } from '@opensearch-project/agent-health';

export class EchoConnector extends BaseConnector {
  // Replaces the built-in 'rest' connector when registered. Pick a
  // different id (and widen ConnectorProtocol in your fork) if you
  // want to coexist with the default REST connector.
  readonly type = 'rest' as const;
  readonly name = 'Echo Agent';
  readonly supportsStreaming = false;

  /**
   * Build the JSON payload sent to the agent's HTTP endpoint.
   * Called by `execute()` and also when re-processing stored raw events
   * during trace replay (see `parseResponse`).
   */
  buildPayload(request: ConnectorRequest): { message: string } {
    return { message: request.testCase.initialPrompt };
  }

  /**
   * Single-turn HTTP call → single response.
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    _auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    _onRawEvent?: ConnectorRawEventCallback,
  ): Promise<ConnectorResponse> {
    const startedAt = Date.now();

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildPayload(request)),
    });
    if (!res.ok) {
      throw new Error(`Echo agent failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { reply: string };

    // Build a single-step trajectory and emit progress for live UIs.
    const step = this.createStep('response', json.reply);
    onProgress?.(step);

    return {
      success: true,
      response: json.reply,
      trajectory: [step],
      rawEvents: [{ type: 'ECHO_REPLY', reply: json.reply }],
      durationMs: Date.now() - startedAt,
      runId: `echo-${startedAt}`,
    };
  }

  /**
   * Re-derive trajectory from previously stored raw events. Used by
   * the run replayer / trace recovery path.
   */
  parseResponse(rawResponse: unknown): TrajectoryStep[] {
    const events = Array.isArray(rawResponse) ? rawResponse : [];
    return events
      .filter((e: { type?: string }) => e?.type === 'ECHO_REPLY')
      .map((e: { reply: string }) => this.createStep('response', e.reply));
  }
}
