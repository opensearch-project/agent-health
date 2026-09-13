# Agent connector registry

Connectors adapt one agent protocol or runtime to Agent Health's common request, trajectory, and evidence model. Each well-known connector is maintained in isolation under `connectors/<protocol>/`: its implementation is `index.ts`, its behavior is documented in `README.md`, and unit tests are colocated in `index.test.ts`.

## Registry

`connectors/index.ts` exports the browser-safe `connectorFactories` name-to-factory map. `connectors/server.ts` exports `serverConnectorFactories`, which adds Node.js runtimes. Agent Health resolves an agent's `connectorType` through the populated `connectorRegistry`; the legacy default remains `agui-streaming`, and `mock://` endpoints still resolve to `mock`. User-supplied `config.connectors: AgentConnector[]` remain additive.

## Contract

Implement `AgentConnector` from `../connectors/types.ts`:

- `type` is the stable config string and must equal the registry key.
- `buildPayload()` transforms the standard test case without performing I/O.
- `execute()` invokes the target and returns `trajectory`, `runId`, `rawEvents`, and optional `metadata`.
- `parseResponse()` deterministically converts captured protocol data into trajectory steps.
- `supportsStreaming`, optional `healthCheck()`, and optional `traceContext` describe capabilities.

Factories must create isolated instances. Do not share mutable per-run parser state across concurrent evaluations.

## Harvest and settlement

A connector must not harvest a final transcript while the target can still produce work. Streaming protocols settle when their stream/process closes. Asynchronous runtimes must poll an authoritative settlement endpoint and include timeout/settlement details in metadata. A timeout may return partial evidence only when clearly marked (for example `timedOut: true`).

Call `onProgress` for every harvested trajectory step and `onRawEvent` for every captured wire/runtime event. Preserve raw data rather than synthesizing evidence. `runId` should be the target's stable invocation or session identifier so traces can correlate precisely.

## Evidence and metadata conventions

- `action`: set `toolName` and, when available, `toolArgs`.
- `tool_result`: set `status` and retain the actual result in `content` or `toolOutput`.
- `response`: use for the final user-visible answer; use `assistant` for intermediate text.
- Timestamps are epoch milliseconds.
- `rawEvents` are protocol-native evidence suitable for debugging/replay.
- `metadata` is connector-specific but should use descriptive keys such as `sessionId`, `threadId`, `settledAfterMs`, `timedOut`, and `responseHeaders`. Never put credentials in metadata or raw events.

## Add a well-known connector

1. Create `connectors/<protocol>/index.ts`, `README.md`, and `index.test.ts`.
2. Add the protocol to `WellKnownConnectorProtocol` in `connectors/types.ts`.
3. Add a zero-argument factory to `connectorFactories` (browser-safe) or `serverConnectorFactories` (Node.js-only).
4. Export the class from the matching registry entry file.
5. Test payload mapping, response parsing, errors, progress/raw-event capture, settlement boundaries, metadata, and resolution by the old config string.
6. Run `npx tsc --noEmit`, `npm run build`, `npm run build:server`, and `npm test`.
