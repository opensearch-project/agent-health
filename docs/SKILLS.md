<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Skills Evaluator — Authoring Guide

The Skills Evaluator runs an A/B benchmark on an [AgentSkills](https://agentskills.io/) /
[Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills): one set of
agent runs **with** the skill injected, one set **without**, then grades the same
assertions on both trajectories and reports the delta in pass-rate, latency, and
tokens. Optionally, an LLM proposes an improved `SKILL.md` body from the failure
evidence and (with `auto`) applies it.

This guide tells you **how to write a skill that the evaluator can score
fairly** — and what every warning / status the UI shows actually means.

```
┌──────────┐  ┌──────────────┐   ┌──────────────┐   ┌────────────┐
│ SKILL.md │→ │ parseSkill   │→  │ runSkillEval │→  │ benchmark  │
└──────────┘  │  validate +  │   │  with vs     │   │  + diff +  │
              │  warn        │   │  without     │   │  improve   │
              └──────────────┘   └──────────────┘   └────────────┘
```

---

## 1. Anatomy of a skill folder

```
my-skill/
├── SKILL.md            # required — frontmatter + body
└── evals/
    └── evals.json      # optional — auto-generated if absent
```

`SKILL.md` is a markdown file with a YAML frontmatter block delimited by `---`
on lines by themselves:

```markdown
---
name: rca-log-analysis
description: Use when the user asks why a service is failing or wants to find
  the root cause from log lines. Triggers on terms like "why is X failing",
  "RCA", "root cause", "error spike".
allowed-tools:
  - Read
  - Bash(git:*)
license: Apache-2.0
---

# Root-cause analysis from logs

When the user asks why a service is failing:

1. Pull the last 5 minutes of logs from the suspect service.
2. Group by error code; the dominant code is your starting hypothesis.
3. ...
```

### Frontmatter rules (enforced by `parseSkill`)

| Field           | Required | Constraint                                                              |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `name`          | yes      | lowercase kebab-case, ≤ 64 chars                                        |
| `description`   | yes      | ≤ 1024 chars; **should describe trigger conditions** (see §2)           |
| `allowed-tools` | no       | YAML list **or** whitespace-separated string (`Bash(git:*)` patterns ok) |
| `license`       | no       | free-form string                                                        |
| `compatibility` | no       | free-form string                                                        |
| `metadata`      | no       | arbitrary YAML mapping                                                  |

The closing `---` must be on its own line. CRLF line endings are normalised
before matching.

---

## 2. Why your `description` is the most important field

In Claude Code's skill loader the `description` is what the matcher
**actually reads** when deciding whether to inject the skill into a given
turn. The body is only loaded after the description has matched. A
description that reads like a tagline ("A helper for log analysis") will
silently fail to fire.

The parser surfaces two warnings for this:

| Warning text                                                                                                                 | What to do                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `description is only N characters … aim for ≥ 30 chars and explicitly state trigger conditions` | The description is too short to discriminate from peers. Expand it.                                                                              |
| `description does not appear to state when the skill should be used`                                                         | Add a phrase like **`Use when …`**, **`For requests about …`**, **`Trigger on …`**, **`Invoke when the user asks …`**. The matcher looks for these. |

Good descriptions:

> ✅ "Use when the user asks why a service is failing or wants RCA from logs.
> Triggers on phrases like 'why is X erroring', 'root cause', 'error spike'."

> ✅ "For requests about diffing two trajectories — invoke when the user
> mentions 'compare runs', 'why did the agent behave differently', or pastes
> two run IDs."

Bad descriptions (parser will warn):

> ❌ "Helper for logs."
> ❌ "Skill for trace analysis."
> ❌ "Improves debugging."

---

## 3. Authoring `evals/evals.json`

Each eval case is a triple **prompt → expected_output → assertions**. The
evaluator runs the prompt twice (with and without the skill), then asks the
LLM judge whether **each** assertion holds against the resulting trajectory.

```json
{
  "skill_name": "rca-log-analysis",
  "evals": [
    {
      "id": 1,
      "prompt": "The checkout service started returning 503s 10 minutes ago. Why?",
      "expected_output": "Identifies a downstream dependency or resource exhaustion as the cause.",
      "assertions": [
        "The agent searches logs for the affected service before guessing",
        "The agent groups errors by error code or status",
        "The agent's final answer names a specific suspect (service / resource / config)"
      ]
    }
  ]
}
```

Tips:

- **Make assertions discriminating.** A good assertion is one a *baseline*
  agent (without the skill) would plausibly fail — that's the only way the
  A/B delta surfaces real value. Trivial assertions like "the response is in
  English" don't move the needle.
- **2–3 assertions per eval is plenty.** Each assertion costs one judge call.
- **`expected_output` is free-form** — it's used as judge context, not as a
  string-match target.
- **Auto-generation** runs only if `evals/evals.json` is missing. If it
  fails to parse a JSON eval set from the model response, the evaluator
  **throws with the exact JSON shape** rather than substituting a generic
  placeholder. Hand-author the file in that case.

---

## 4. Reading the validation panel

After you select a skill in the UI, the validation panel shows:

| Symbol | Meaning                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------- |
| ✅     | `valid: true` — frontmatter parsed, required fields present                                          |
| ❌     | `valid: false` — at least one hard error; the **Run Evaluation** button stays disabled               |
| ⚠      | Warning, listed below the description. Skill still runs, but you should fix before publishing.       |

Common warnings (and what they mean):

| Warning                                                              | Cause / Fix                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `description does not appear to state when the skill should be used` | Add a "Use when …" trigger phrase (§2)                                                                   |
| `Instructions are ~N tokens (recommended <5000)`                     | Skill body too long. Split into multiple skills or move examples to bundled reference files.            |
| `evals/evals.json present but invalid: …`                            | The file exists but parsing failed. The reason follows the colon (e.g. `invalid JSON`, `missing skill_name`). |
| `No evals/evals.json found — skill cannot be evaluated …`            | Auto-generation will run on Evaluate. Provide your own to control what's tested.                         |

---

## 5. Reading the run progress

While a run is in flight, the progress bar shows three counters:

```
N passed   N failed   ⚠ N errored
```

The distinction is intentional and matters:

| Status     | Meaning                                                                                                                                                                 | Improver behaviour                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `passed`   | Agent ran cleanly **and** every assertion graded true.                                                                                                                  | Treated as a positive example.                                                                                          |
| `failed`   | Agent ran cleanly but **at least one assertion graded false**.                                                                                                          | This is the signal the improver learns from — the skill is the suspect.                                                 |
| `errored`  | The **agent itself** crashed / endpoint unreachable / timed out — assertions were skipped because grading them would (a) waste a judge call and (b) wrongly blame the skill. | **Excluded** from improvement-proposal evidence. Fix the agent (endpoint, auth, network) before drawing skill conclusions. |

If you see all `errored`, the skill is **unknowable** — the evaluator is
telling you to debug the agent, not the skill.

---

## 6. Auto-applying improvement proposals (`auto: true`)

When the LLM proposes an improved `SKILL.md` body, you can ship it
automatically with the **Apply & Re-run** button (UI) or `--auto` (CLI).

The server applies the change **non-destructively**:

1. Snapshots the current `SKILL.md` to `SKILL.md.bak` next to it.
2. Refuses to apply (with an explanatory error pointing to
   `iteration-N/improvement-proposal.json`) if the original instructions
   snapshot doesn't appear verbatim in the file — this prevents the silent
   no-op case where `String.replace` matched nothing but the API still
   claimed `applied: true`.

To roll back: `mv SKILL.md.bak SKILL.md`.

---

## 7. Where skills are discovered

The discover endpoint scans both **user scope** and **project scope**, in
this order:

| Path                       | Source label             | Notes                                  |
| -------------------------- | ------------------------ | -------------------------------------- |
| `~/.claude/skills/`        | `Claude Code (user)`     | Per Claude Code spec — user-global.    |
| `<cwd>/.claude/skills/`    | `Claude Code`            | Project scope.                         |
| `<cwd>/.kiro/skills/`      | `Kiro`                   |                                        |
| `<cwd>/.kiro/steering/`    | `Kiro`                   |                                        |
| `<cwd>/.codex/`            | `Codex`                  |                                        |
| `<cwd>/.cursor/rules/`     | `Cursor`                 |                                        |
| `<cwd>/.github/copilot/`   | `Copilot`                |                                        |
| `<cwd>/.continue/skills/`  | `Continue`               |                                        |
| `<cwd>/skills/`            | `Project`                |                                        |

Duplicate skill folders (same absolute path) appear once. Home-relative
paths render as `~/…` in the dropdown. You can also paste a path manually
or upload a single `SKILL.md` from the UI.

---

## 8. CLI

```bash
# Run on a specific skill folder
agent-health skill ./my-skill --agent claude-code --model claude-sonnet

# Auto-apply the proposed improvement and re-run
agent-health skill ./my-skill --auto
```

The CLI emits the same SSE event stream the UI consumes; `evalStatus` per
case is logged with the same tri-state semantics described in §5.

---

## 9. Troubleshooting

| Symptom                                                                   | Likely cause                                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Skill validates but A/B delta is ~0%                                      | Assertions aren't discriminating — a baseline agent passes them too. Rewrite assertions to require knowledge the skill uniquely provides.     |
| All evals graded `errored`                                                | Agent endpoint unreachable, auth failed, or model timed out. Check the agent's settings page first; the skill is unknowable until then.       |
| `Cannot auto-apply: original instructions snapshot does not match …`      | The `SKILL.md` was edited between proposal generation and apply. Open `iteration-N/improvement-proposal.json`, review, and merge by hand.     |
| `description does not appear to state when the skill should be used`     | Add a "Use when …" trigger phrase. The matcher needs it (§2).                                                                                 |
| `allowed-tools` parsed wrong (e.g. `["Read,Write"]`)                       | Pre-PR-206 behaviour — upgrade. The current parser accepts both YAML lists and whitespace-separated strings.                                  |

---

## See also

- [AgentSkills open standard](https://agentskills.io/)
- [Claude Code skills documentation](https://docs.claude.com/en/docs/claude-code/skills)
- [`docs/SDK.md`](./SDK.md) — code-based test SDK (different surface; complementary)
- Source: [`services/skills/`](../services/skills/), [`server/routes/skills.ts`](../server/routes/skills.ts), [`components/skills/SkillsPage.tsx`](../components/skills/SkillsPage.tsx)
