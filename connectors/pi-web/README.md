# pi-web connector

## Connects to

A real pi-web browser-server session, including recursively spawned worker sessions.

## Configuration

Set `connectorType: 'pi-web'`; `endpoint` is the pi-web base URL. Configure `token` (or `PI_WEB_TOKEN`/bearer auth), `cwd`, optional `model`, `timeoutMs`, `pollIntervalMs`, `settleMs`, `keepSession`, and `fixturesDir`.

## Harvest and quirks

Harvest polls `GET /api/sessions/:id/status` until recursive settlement, then refetches the transcript. Numeric/string timestamps are preserved. `filesystem-workspace` fixture envelopes are integrity checked; legacy fixture context remains supported.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
