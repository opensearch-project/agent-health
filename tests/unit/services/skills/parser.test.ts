/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkill } from '@/services/skills/parser';

/**
 * These tests cover skill-authoring rules called out by Claude Code's skills
 * docs that the original parser didn't enforce or surface:
 *
 *   1. `allowed-tools` accepts a YAML list (was silently broken — array
 *      stringification produced ["Read,Write"]).
 *   2. Description should describe *when* to use the skill — surface a
 *      warning when the trigger phrase is missing.
 *   3. Frontmatter fences must be on their own lines (single-line `---x---`
 *      should not be accepted as valid frontmatter).
 *   4. Invalid evals/evals.json should produce an explanatory warning rather
 *      than silently being treated as missing.
 */

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `skill-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeSkill(content: string): string {
  writeFileSync(join(workDir, 'SKILL.md'), content, 'utf-8');
  return workDir;
}

describe('parseSkill - allowed-tools', () => {
  it('accepts a YAML list', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: Use when handling foo bar baz quux\nallowed-tools:\n  - Read\n  - Write\n  - Bash(git:*)\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.skill?.metadata.allowedTools).toEqual(['Read', 'Write', 'Bash(git:*)']);
  });

  it('accepts a whitespace-separated string (back-compat)', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: Use when handling foo bar baz quux\nallowed-tools: Read Write Edit\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.skill?.metadata.allowedTools).toEqual(['Read', 'Write', 'Edit']);
  });

  it('errors on a non-string, non-array value', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: Use when handling foo bar baz quux\nallowed-tools: 42\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/allowed-tools/);
  });
});

describe('parseSkill - description quality warnings', () => {
  it('warns when the description lacks a trigger phrase', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: A helper that does some stuff with files and folders.\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /when the skill should be used/i.test(w))).toBe(true);
  });

  it('does not warn when the description includes "use when"', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: Use when the user asks to refactor TypeScript imports.\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /when the skill should be used/i.test(w))).toBe(false);
  });

  it('warns when the description is very short', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: short one\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /trigger conditions/i.test(w))).toBe(true);
  });
});

describe('parseSkill - frontmatter fences', () => {
  it('rejects a single-line fence', () => {
    const dir = writeSkill(`---name: my-skill---\n\nbody`);
    const result = parseSkill(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/frontmatter/i);
  });

  it('handles CRLF line endings', () => {
    const dir = writeSkill(
      `---\r\nname: my-skill\r\ndescription: Use when handling foo bar quux baz\r\n---\r\n\r\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.skill?.metadata.name).toBe('my-skill');
  });
});

describe('parseSkill - evals.json error surfacing', () => {
  it('warns with reason when evals.json is invalid JSON', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: Use when handling foo bar baz quux\n---\n\nbody`,
    );
    const evalsDir = join(dir, 'evals');
    mkdirSync(evalsDir, { recursive: true });
    writeFileSync(join(evalsDir, 'evals.json'), '{not valid json', 'utf-8');

    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /invalid JSON/i.test(w))).toBe(true);
  });

  it('warns with "missing" reason when evals.json is absent', () => {
    const dir = writeSkill(
      `---\nname: my-skill\ndescription: Use when handling foo bar baz quux\n---\n\nbody`,
    );
    const result = parseSkill(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => /No evals\/evals\.json/.test(w))).toBe(true);
  });
});
