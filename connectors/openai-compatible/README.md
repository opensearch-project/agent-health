# OpenAI-compatible connector

## Connects to

OpenAI Chat Completions compatible services including OpenAI, vLLM, Ollama, and LiteLLM.

## Configuration

Set `connectorType: 'openai-compatible'`, a chat-completions endpoint, model ID, and usually bearer auth.

## Harvest and quirks

The connector is non-streaming and records usage plus finish reason in metadata.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
