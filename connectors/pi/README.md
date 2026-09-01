# Pi CLI connector

## Connects to

The pi coding-agent CLI in print/JSON mode.

## Configuration

Set `connectorType: 'pi'`; config supports packagePath, model, workingDir, timeout, env, and additionalArgs.

## Harvest and quirks

NDJSON deltas are buffered until process settlement. This is distinct from the pi-web session connector.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
