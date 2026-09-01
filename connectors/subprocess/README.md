# Subprocess connector

## Connects to

Arbitrary command-line agents.

## Configuration

Set `connectorType: 'subprocess'`; configure command/args, env, input mode, output parser, timeout, and working directory in `connectorConfig`.

## Harvest and quirks

Processes run with `shell: false`. Settlement is process close; stdout and stderr are retained as raw evidence.

See [`../README.md`](../README.md) for the shared contract, evidence conventions, and contribution checklist.
