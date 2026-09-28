# Customer-surface regression matrix

Every way a customer runs benchmarks, single tests and independent evaluations
— **CLI, UI and API** — pinned by a test that asserts only what the customer can
see: exit code and printed summary, HTTP status and body shape, rendered UI
state. Nothing in the matrix reaches into server internals, so it stays valid
across refactors (it is the safety net for retiring the legacy
`POST /api/storage/benchmarks/:id/execute` runner).

```bash
npm run test:surface-matrix          # both halves, against the server on AH_PORT
AH_PORT=4001 npm run test:surface-matrix
```

Both halves run against a live backend (`AH_PORT`, default 4001) with a real
fixture REST agent ([`tests/helpers/traceparentRestAgent.ts`](../tests/helpers/traceparentRestAgent.ts))
and the built-in demo/mock judge, so no LLM credentials are needed and a full
run finishes in about a second. Shared plumbing lives in
[`tests/helpers/surfaceMatrix.ts`](../tests/helpers/surfaceMatrix.ts). Every
spec cleans up what it created (`TestDataTracker`), and each records the exact
behaviours it pins in its header comment.

Server requirements for the specs: file or OpenSearch storage; a short trace-poll
budget (`TRACE_POLL_MAX_ATTEMPTS=2 TRACE_POLL_INTERVAL_MS=1000`, as CI sets) so
the deliberately errored run in `ui-run-actions` lands quickly. The `serve` /
quick-mode spec boots its own isolated servers on a free port picked from the OS
(`SURFACE_MATRIX_SPARE_PORT` pins one). Without a backend the specs skip with a
warning (repo convention — the release-rehearsal job runs `npm test` with no
server); when a `CI` job points them at one (`AH_PORT` set) an unreachable
backend fails the matrix instead (`backendReady()`), so the matrix job can never
go green by doing nothing.

CI runs both halves on every PR — `integration-tests` (OpenSearch backend)
and `e2e-tests` (file backend) — and each job fails if the matrix specs did not
run (`Verify the customer-surface matrix ran` steps in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

## CLI — `tests/integration/surface-matrix/cli-*.integration.test.ts`

| Operation | Pinned behaviour | Spec |
|---|---|---|
| `benchmark -n <existing> -a <agent> -c N` | exit 0 · `Benchmark: <name> (<id>) — N test cases` · `Concurrency: N` · `Benchmark Summary` with `N/N passed`, no "errored — evaluator could not run" · `View results:` link · one `trigger: 'cli'`, `completed`, benchmark-associated evaluation run with N results · benchmark `runs[]` lists it · every report judged, `metricsStatus: 'ready'`, `runId` = agent conversation id, `traceId` a W3C id (never the connector id) · one agent call per case | `cli-benchmark-named` |
| `benchmark … --export <file>` | writes `{ benchmark: {id,name,testCaseCount}, runs: [{ runId, status, passed, failed, reports[] }] }` · prints `Results exported to:` | `cli-benchmark-named` |
| `benchmark … -o json` | prints a JSON array `[{ agent, runId, passed, failed, passRate, results }]` | `cli-benchmark-named` |
| `benchmark -n <unknown>` | exit 1 · `Benchmark not found` · hint `list benchmarks` | `cli-benchmark-named` |
| `benchmark -f <cases.json> -a <agent>` | exit 0 · `Running in file mode` · `Imported N test cases` · benchmark named after the file basename with exactly the imported cases · run N/N, judged | `cli-benchmark-file-import` |
| `benchmark -n <name> -f <cases.json>` | benchmark named `<name>` · run N/N | `cli-benchmark-file-import` |
| `benchmark -f <invalid.json>` | exit 1 · `Validation failed` · nothing created | `cli-benchmark-file-import` |
| `benchmark -f <suite>.eval.js -a <agent>` (code SDK) | exit 0 · `Mode: Ad-hoc (no benchmark association)` · `Evaluation run completed (N/N test cases)` · Passed/Failed breakdown · a failing matcher is a `failed` result · agent invoked once per prompt-bearing test · `code-import` source · promote hint | `cli-benchmark-code-sdk` |
| `benchmark -f <suite>.eval.js -n <name>` | benchmark `<name>` created, holds the imported cases, lists the run · results link printed | `cli-benchmark-code-sdk` |
| `benchmark -d <dir> -a <agent>` | every `*.json` imported (non-JSON ignored) · `Sources: 1 source(s)` · ad hoc · `directory-import` source · N/N judged | `cli-benchmark-dir` |
| `benchmark -d <empty>` / `-d <missing>` | exit 1 · `No JSON files found` / `Directory not found` | `cli-benchmark-dir` |
| `benchmark -t <id> -t <id> -c 2` | exactly those cases · `test-case-ids` source · `Concurrency: 2` · ad hoc · judged | `cli-benchmark-sources` |
| `benchmark --label <l>` | exactly the labelled cases (unlabelled NOT run) · `label-filter` source | `cli-benchmark-sources` |
| `benchmark -t <unknown>` | exit 1 · `Test case not found` | `cli-benchmark-sources` |
| quick mode: `benchmark -a <agent>` with no server running | starts its own server (`Started server on port`) · `Running in quick mode` · `Found N test cases` · `Created benchmark: quick-<ts>` · `N/N passed` · stops the server it started · the `quick-*` benchmark + completed run persist and are visible on the next `serve` | `cli-server-lifecycle` |
| `serve --headless -p <port>` | `/health` → `{ status:'ok', version, instance:{ pid, cwd, port } }` · storage/agents/models APIs work out of the box (file storage, `demo`, `demo-model`) · stops on SIGTERM | `cli-server-lifecycle` |
| `benchmark` with no `-n`/`-f` while a server runs | exit 1 · `Benchmark name required when server is already running` | `cli-server-lifecycle` |
| `--stop-server` on a server the CLI did not start | server keeps running | `cli-server-lifecycle` |
| `CI=1` + running server on an **explicit** port (`AH_PORT` / `server.port`), versions match | reused · exit 0 · `Using existing server on :PORT (explicit port)` (the CI job that started its own server first) | `cli-server-lifecycle` |
| `CI=1` + running server on the **implicit** port (no `AH_PORT`, no `server.port` → 4001) | exit 1 · `Server already running on port … In CI mode (reuseExistingServer=false)` · hints `AH_PORT=<port>` (exercised when the backend under test is on 4001, as in CI) | `cli-server-lifecycle` |
| `CI=1` + running server whose version differs | exit 1 · `Server version mismatch: server=… CLI=…` · the server is never killed | `cli-server-lifecycle` |
| `run -t <id> -a demo` | exit 0 · `Test Case: <name> (<id>)` · `PASSED`/`FAILED` (never ERROR / NO VERDICT / PENDING) · table Agent/Status/Accuracy/Steps/Report ID · report persisted, `status: completed`, verdict, trajectory | `cli-run-single-case` |
| `run -t <name> -o json` | resolves by name · `[{ agent, report }]` | `cli-run-single-case` |
| `run -t <unknown>` / `run -a <unknown>` | exit 1 · `Test case not found` / `Agent not found` | `cli-run-single-case` |
| `export -b <name\|id> -o <file>` | exit 0 · `Exported N test case(s) to <file>` · array of import-compatible cases (`name`, `category`, `difficulty`, `initialPrompt`, `expectedOutcomes`) | `cli-export-roundtrip` |
| `export -b <id> --stdout` | JSON array on stdout | `cli-export-roundtrip` |
| export → `benchmark -f <exported> -n <new> -a <agent>` | round trip imports N and runs N/N | `cli-export-roundtrip` |
| `GET /api/storage/benchmarks/:id/export` | `Content-Disposition: attachment; filename="….json"` + the same array | `cli-export-roundtrip` |
| `export -b <unknown>` | exit 1 · `Benchmark not found` | `cli-export-roundtrip` |
| `--help` for root, `serve`, `benchmark`, `run`, `export`, `report`, `list`, `import` | every pinned long flag + short alias still listed (a flag disappearing fails) · root help lists every subcommand · help needs no server | `cli-help-inventory` |

Not pinned (and why): `run -a <custom REST agent>` — `run` resolves agents from
the local config only, so a UI-registered agent is not addressable from `run`
(pinned with the built-in `demo` agent instead). Unknown subcommands
(`agent-health nope`) currently fall through to the default action and try to
start a server rather than printing "Unknown command" — left unpinned as a
known papercut. The `--stdout` flag prints the ServerLifecycle reuse notice on
stdout before the JSON; the spec locates the array rather than pinning a pure
stdout.

## API — `tests/integration/surface-matrix/api-*.integration.test.ts`

| Operation | Pinned behaviour | Spec |
|---|---|---|
| `POST /api/evaluate` by `testCaseId` | 200 `text/event-stream` · `started` (with `reportId`) → `completed` (`status: completed`, `passed\|failed`, `trajectorySteps > 0`, `llmJudgeReasoning`) · report at `GET /api/storage/runs/:id` with `name = runName`, listed under the case | `api-evaluate` |
| `POST /api/evaluate` inline `testCase` | ad-hoc prompt evaluated the same way | `api-evaluate` |
| `POST /api/evaluate` with a `useTraces` agent | completes; verdict lands via trace polling (`metricsStatus → ready`) | `api-evaluate` |
| `POST /api/evaluate` validation | 400 without `modelId` (**pinned; sibling PR #534 relaxes this — its case is `it.skip` here**) · 400 unknown agent · 404 unknown case · 400 no case | `api-evaluate` |
| `POST /api/storage/evaluation-runs` · `benchmark` source | 200 SSE `started` → `progress` / `testCaseComplete` → `completed` · run doc `completed`, `benchmarkId`, N results, `stats`, `testCaseSnapshots`, `completedAt` · benchmark `runs[]` projection · reports judged with traces · `modelId` NOT required · `judgeModelId` persisted | `api-evaluation-runs` |
| … `test-case-ids` source | ad hoc (no `benchmarkId`) · `trigger` defaults to `manual` | `api-evaluation-runs` |
| … `code-import` source | SDK bodies execute; failing matcher → `failed` | `api-evaluation-runs` |
| `GET /api/storage/evaluation-runs/:id` · list filters | 200 terminal doc / 404 unknown · `?benchmarkId=&trigger=&status=` filter | `api-evaluation-runs` |
| evaluation-runs validation | 400 without `sources` / `agentKey` · unknown benchmark / case → SSE `error` event, stream closes (never hangs) | `api-evaluation-runs` |
| `POST /…/:id/cancel` | 200 `{ success, draining }` · run drains to `cancelled`, never-started cases marked `cancelled`, creator stream ends with `completed{status:'cancelled'}` · 400 when not running · 404 unknown | `api-run-lifecycle` |
| `POST /…/:id/retry-judgement?scope=all` + `GET …/status` | 202 `{ jobId, status:'running', total }` → status `completed` with `summary { retried, succeeded, failed }` · reports keep a verdict · 409 while the run executes · 404 unknown · 404 status before any job | `api-run-lifecycle` |
| `DELETE /…/:id` | 200 `{ success, projectionDeleted, benchmarkId }` · run 404 afterwards · benchmark `runs[]` no longer lists it · **reports kept** (no cascade, per AGENTS.md) · second delete 404 | `api-run-lifecycle` |
| `GET /api/storage/runs?ids=&fields=` | batch read of a run's reports | `api-run-lifecycle` |
| legacy `POST /api/storage/benchmarks/:id/execute` | `LEGACY_EXECUTE_EXPECTED = 200` today (route runs + streams; file backend answers 400 "OpenSearch not configured" before it would start); sample ids refused · **the removal PR flips the constant to 410 and changes nothing else** | `api-legacy-execute` |
| `GET /api/storage/runs/by-test-case/:id` · `POST /api/storage/runs/search {testCaseId}` · `GET /api/storage/runs/:id` | reports listed under their case · full report (`trajectory`, verdict, `metricsStatus`, `runId`) · 404 unknown | `api-reads` |
| `POST /api/traces` · `GET /api/traces/health` | the agent's span tree (`invoke_agent`, `chat`, `execute_tool`) for a report's `traceId`/`runIds`, all in one trace · `backend` named · 400 without correlator/time range · health `{ status, backend }` | `api-reads` |
| `GET /health` · `GET /api/storage/health` · `GET /api/storage/config/status` | `{ status:'ok', version, instance:{pid,cwd,port} }` · `{ status:'ok', backend:'file' }` / `{ status:'ok', cluster }` · `{ storage, observability, runtime.storage.backend }` | `api-reads` |
| `GET /api/agents[?filter=custom]` · `GET /api/models` · `POST/DELETE /api/agents/custom` | built-ins (`demo`, `builtIn: true`) + custom agents · `demo-model` listed · 400 without name/endpoint/bad connectorType · 201 create · 204 delete · 404 after | `api-reads` |

## UI — `tests/e2e/surface-matrix/ui-*.spec.ts` (Playwright, real runs, no mocked routes)

| Flow | Pinned behaviour | Spec |
|---|---|---|
| Benchmark page → **Add Run** → Start Run | Configure Run dialog with the REST agent selectable · the completed run's row appears in the Runs tab (no running/failed/cancelled badge, 100% pass rate, N cases) · the same run is a completed, benchmark-associated evaluation run via the API with every report judged | `ui-benchmark-add-run` |
| Test case page → **Run Test** → Start Run | Configure Run dialog · inline run finishes (`Run Test` re-enabled) · Run history badge `0 runs → 1 run`, the run listed; opening it shows Test Case Output / Traces / Judge Evaluation · report judged via API | `ui-test-case-run-test` |
| Test Cases list → ▶ **Quick Run** modal | `Run: <name>` with Agent + Judge Model selects (Demo Model offered) · Run renders the report: PASSED/FAILED badge (never ERRORED), `Score: N%`, Trajectory · report persisted | `ui-quick-run-modal` |
| **New Run wizard** (ad hoc) | tick case → Add → Next: Configure → agent + Demo Model judge, `None (ad-hoc run)` → Launch Run → navigates to `/evaluations/runs/<id>` · run completes (Completed, no running badge) · API: no `benchmarkId`, reports judged | `ui-new-run-wizard` |
| **Run inspector** `/evaluations/runs/:id/inspect` (+ benchmark-scoped redirect) | run name, agent, `N✓ 0✗ / N`, `Test Cases · N`, one PASSED row per case · Test Case Output (non-zero step badge) / Traces (badge = 3 spans; Trace Tree / Agent Map / Timeline views) / Judge Evaluation (verdict + reasoning) | `ui-run-inspector` |
| **Evaluation Runs list** | both runs searchable by name · completed (no running/failed/cancelled/errored badge) · judge column `Demo Model` · kebab present | `ui-runs-list-and-comparison` |
| **Comparison** `/compare?runs=a,b` | scoreboard renders with both names and a 100% pass-rate cell per run · not the "select a benchmark" empty state | `ui-runs-list-and-comparison` |
| **Retry judgement** (inspector kebab) | a real errored run (trace timeout → `metricsStatus: 'error'`): item ENABLED with the count · confirm dialog → summary → run stats flip to N passed, reports get verdicts · DISABLED on a fully judged run | `ui-run-actions` |
| **Delete run** (list kebab) | `Delete this run?` confirm → row gone · API 404 · reports kept | `ui-run-actions` |

Not pinned: the ad-hoc-prompt form of the Quick Run modal (`QuickRunModal` with no
test case) has no routed entry point in the current UI — the New Run wizard is
the UI's ad-hoc path.
