# LangGraph connector

## Connects to

LangGraph's direct REST API (use AG-UI for SSE deployments).

## Configuration

Set `connectorType: 'langgraph'`. Optional `connectorConfig.graphId`, `threadId`, and `configurable` tune invocation.

## Harvest and quirks

Thread runs and assistant invokes use different URL shapes; `/ok` is used for health checks.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
