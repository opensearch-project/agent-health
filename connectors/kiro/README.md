# Kiro connector

## Connects to

Kiro CLI in headless agent-engine v2 mode.

## Configuration

Set `connectorType: 'kiro'`; `endpoint` may override `kiro-cli` and subprocess options may be supplied in config.

## Harvest and quirks

Kiro tool evidence is emitted on stderr; `[tool] Running` and status lines become action/result steps.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
