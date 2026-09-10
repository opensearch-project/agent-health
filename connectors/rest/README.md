# REST connector

## Connects to

Generic synchronous JSON-over-HTTP agents.

## Configuration

Set `connectorType: 'rest'`; `endpoint` receives POST requests. Standard auth and custom headers are supported.

## Harvest and quirks

Response fields such as `thinking`, `toolCalls`, `response`, and ML Commons `inference_results` are normalized.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
