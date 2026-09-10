# Amazon Strands connector

## Connects to

Amazon Bedrock Agent Runtime agents with streamed trace events.

## Configuration

Set `connectorType: 'strands'`; `endpoint` is the agent ID and `connectorConfig.agentAliasId` is required in production. Region/session/trace flags and AWS auth are supported.

## Harvest and quirks

Bedrock trace rationale, action groups, knowledge-base results, and final chunks are normalized as evidence.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
