# AG-UI streaming connector

## Connects to

AG-UI agents over SSE.

## Configuration

Set `connectorType: 'agui-streaming'` and use the SSE URL as `endpoint`. Auth headers come from `auth`/`headers`.

## Harvest and quirks

This is the backward-compatible default when `connectorType` is omitted. It harvests until the SSE stream closes and preserves every AG-UI event.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
