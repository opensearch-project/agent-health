# Claude Code connector

## Connects to

Claude Code CLI using structured `stream-json` output.

## Configuration

Set `connectorType: 'claude-code'`; config supports tool allowlists, MCP config, system prompts, env, working directory, timeout, and extra args.

## Harvest and quirks

Captures Claude's session ID for trace correlation. Mutable parser/CLI state is reset and restored for every run.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
