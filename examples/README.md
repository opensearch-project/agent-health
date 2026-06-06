# Examples

Hand-written, runnable examples that ship inside the published
`@opensearch-project/agent-health` npm tarball.

When you install agent-health, these files land at:

```
node_modules/@opensearch-project/agent-health/examples/
```

The point of shipping them in the tarball (instead of only on GitHub) is that
the source you read here is **exactly** the version your `package.json`
resolved to — no risk of looking at `main` and being misled by changes that
landed after your version was cut. AI assistants debugging your project can
also read these files directly.

## Layout

| Directory          | What's inside                                           |
| ------------------ | ------------------------------------------------------- |
| `eval-files/`      | Code-based test cases (`.eval.js` / `.eval.ts`)         |
| `connectors/`      | Custom `BaseConnector` subclasses                       |
| `config/`          | Annotated `agent-health.config.ts` examples             |

Each example file is self-contained, heavily commented, and runnable as-is.

## Running

For SDK examples (`eval-files/`):

```bash
# Copy or symlink the example into your project's evals/ dir, then run it:
npx @opensearch-project/agent-health benchmark \
  --source-type code-import \
  --files ./evals/<copied-file>.eval.js \
  --agent <your-agent-key>
```

For connector examples, see the per-file header for the import / register
snippet you drop into your `agent-health.config.ts`.

## Where to look first

If you're debugging behavior that doesn't match what you expect:

1. Read the **source you imported from** under
   `node_modules/@opensearch-project/agent-health/lib/dist/lib/` — the
   compiled-but-readable `.js` files preserve the original JSDoc and structure
   so you can navigate by import path.
2. Cross-reference against the matching `.d.ts` for the exact type contract.
3. If something is unclear, an example here usually demonstrates the intended
   usage pattern.
