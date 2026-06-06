/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Parser
 * Parses and validates SKILL.md files and evals/evals.json
 * following the AgentSkills open standard / Claude Code skills convention.
 *
 * Validation philosophy (matches Claude Code authoring guidance):
 *   - Hard errors: spec violations that make the file unusable
 *     (missing name, missing description, malformed YAML, name not kebab-case).
 *   - Warnings: authoring smells that the user can still ship past
 *     (description likely lacks a "use when…" trigger, body too long,
 *     no evals to drive A/B comparison).
 *
 * The single most-cited rule in Claude Code's skills docs is that the
 * `description` field is the *trigger* the loader matches against — not a
 * tagline. We surface that explicitly via the "use-when" heuristic warning.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import yaml from 'js-yaml';
import type { Skill, SkillMetadata, SkillEvalsFile, SkillEval, SkillValidationResult } from '@/types';
import {
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_DESCRIPTION_MIN_RECOMMENDED_LENGTH,
  SKILL_BODY_TOKEN_WARN_THRESHOLD,
} from './constants';

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Heuristic: a well-authored Claude Code skill description tells the loader
 * *when* to invoke the skill. These tokens are the most common phrasings.
 */
const TRIGGER_HINT_PATTERNS: RegExp[] = [
  /\buse\s+(this\s+)?when\b/i,
  /\bwhen\s+(?:to|the\s+user|asked|handling|working|debugging|reviewing)\b/i,
  /\bfor\s+(?:tasks?|requests?|questions?|prompts?|issues?)\b/i,
  /\binvoke\s+(this\s+)?(?:skill\s+)?when\b/i,
  /\btrigger(?:s|ed)?\s+(?:on|when|by)\b/i,
];

/**
 * Parse and validate a skill directory.
 * Reads SKILL.md, extracts YAML frontmatter, validates fields.
 */
export function parseSkill(dirPath: string): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const absolutePath = resolve(dirPath);

  if (!existsSync(absolutePath)) {
    return { valid: false, errors: [`Directory does not exist: ${absolutePath}`], warnings };
  }

  const skillMdPath = join(absolutePath, 'SKILL.md');
  if (!existsSync(skillMdPath)) {
    return { valid: false, errors: [`SKILL.md not found in ${absolutePath}`], warnings };
  }

  let content: string;
  try {
    content = readFileSync(skillMdPath, 'utf-8');
  } catch (err) {
    return { valid: false, errors: [`Cannot read SKILL.md: ${err}`], warnings };
  }

  const { frontmatter, body } = extractFrontmatter(content);
  if (!frontmatter) {
    errors.push('SKILL.md must have YAML frontmatter delimited by --- on their own lines');
    return { valid: false, errors, warnings };
  }

  let parsed: Record<string, any>;
  try {
    parsed = yaml.load(frontmatter) as Record<string, any>;
  } catch (err) {
    errors.push(`Invalid YAML frontmatter: ${err}`);
    return { valid: false, errors, warnings };
  }

  if (!parsed || typeof parsed !== 'object') {
    errors.push('Frontmatter must be a YAML mapping');
    return { valid: false, errors, warnings };
  }

  // Validate required fields
  if (!parsed.name || typeof parsed.name !== 'string') {
    errors.push('Missing required field: name');
  } else {
    if (parsed.name.length > SKILL_NAME_MAX_LENGTH) {
      errors.push(`name must be \u2264${SKILL_NAME_MAX_LENGTH} characters (got ${parsed.name.length})`);
    }
    if (!KEBAB_CASE_REGEX.test(parsed.name)) {
      errors.push(`name must be lowercase kebab-case (got "${parsed.name}")`);
    }
  }

  if (!parsed.description || typeof parsed.description !== 'string') {
    errors.push('Missing required field: description');
  } else {
    if (parsed.description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      errors.push(`description must be \u2264${SKILL_DESCRIPTION_MAX_LENGTH} characters (got ${parsed.description.length})`);
    }
    if (parsed.description.length < SKILL_DESCRIPTION_MIN_RECOMMENDED_LENGTH) {
      warnings.push(
        `description is only ${parsed.description.length} characters \u2014 the loader uses this to decide *when* to apply the skill. ` +
        `Aim for \u2265${SKILL_DESCRIPTION_MIN_RECOMMENDED_LENGTH} chars and explicitly state trigger conditions ` +
        `(e.g. "Use when …", "For tasks involving …").`,
      );
    } else if (!TRIGGER_HINT_PATTERNS.some(re => re.test(parsed.description))) {
      warnings.push(
        'description does not appear to state when the skill should be used. ' +
        'Add a trigger phrase like "Use when …" or "For requests about …" so the loader can match it reliably.',
      );
    }
  }

  // Validate allowed-tools: spec accepts either a YAML list or a whitespace-separated string.
  // The previous implementation called String() on a YAML array and produced a single
  // comma-joined token (["Read,Write"]) \u2014 silently broken.
  let allowedTools: string[] | undefined;
  if (parsed['allowed-tools'] !== undefined && parsed['allowed-tools'] !== null) {
    const raw = parsed['allowed-tools'];
    if (Array.isArray(raw)) {
      allowedTools = raw.map(t => String(t).trim()).filter(Boolean);
    } else if (typeof raw === 'string') {
      allowedTools = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
    } else {
      errors.push(`allowed-tools must be a YAML list or whitespace-separated string (got ${typeof raw})`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Warnings for best practices
  const instructionTokenEstimate = Math.ceil(body.length / 4);
  if (instructionTokenEstimate > SKILL_BODY_TOKEN_WARN_THRESHOLD) {
    warnings.push(
      `Instructions are ~${instructionTokenEstimate} tokens (recommended <${SKILL_BODY_TOKEN_WARN_THRESHOLD}). ` +
      `Consider splitting into multiple skills or moving examples to bundled reference files.`,
    );
  }

  if (!body.trim()) {
    warnings.push('SKILL.md body is empty \u2014 no instructions for the agent');
  }

  const metadata: SkillMetadata = {
    name: parsed.name,
    description: parsed.description,
    license: parsed.license,
    compatibility: parsed.compatibility,
    metadata: parsed.metadata,
    allowedTools,
  };

  const skill: Skill = {
    metadata,
    instructions: body.trim(),
    path: absolutePath,
  };

  // Try to parse evals
  const evalsResult = parseEvalsDetailed(absolutePath);
  if (!evalsResult.file) {
    if (evalsResult.reason === 'missing') {
      warnings.push('No evals/evals.json found \u2014 skill cannot be evaluated without test cases (auto-generation will run on evaluate)');
    } else {
      // Surface *why* the file was rejected instead of silently behaving as if it didn't exist.
      warnings.push(`evals/evals.json present but invalid: ${evalsResult.reason}`);
    }
  }

  return { valid: true, skill, evalsFile: evalsResult.file || undefined, errors, warnings };
}

/**
 * Parse evals/evals.json from a skill directory.
 *
 * Public API preserved \u2014 returns null on any failure. Use parseEvalsDetailed
 * internally when you need to know *why* parsing failed.
 */
export function parseEvals(dirPath: string): SkillEvalsFile | null {
  return parseEvalsDetailed(dirPath).file;
}

interface ParseEvalsResult {
  file: SkillEvalsFile | null;
  /** 'missing' if the file is absent; otherwise a human-readable reason. */
  reason: string;
}

function parseEvalsDetailed(dirPath: string): ParseEvalsResult {
  const evalsPath = join(dirPath, 'evals', 'evals.json');
  if (!existsSync(evalsPath)) {
    return { file: null, reason: 'missing' };
  }

  let raw: string;
  try {
    raw = readFileSync(evalsPath, 'utf-8');
  } catch (err) {
    return { file: null, reason: `cannot read file (${err instanceof Error ? err.message : err})` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { file: null, reason: `invalid JSON (${err instanceof Error ? err.message : err})` };
  }

  if (!parsed.skill_name) {
    return { file: null, reason: 'missing required field "skill_name"' };
  }
  if (!Array.isArray(parsed.evals)) {
    return { file: null, reason: 'field "evals" must be an array' };
  }

  const evals: SkillEval[] = parsed.evals
    .filter((e: any) => e.prompt && typeof e.prompt === 'string')
    .map((e: any, idx: number) => ({
      id: e.id ?? idx + 1,
      prompt: e.prompt,
      expected_output: e.expected_output || '',
      files: Array.isArray(e.files) ? e.files : undefined,
      assertions: Array.isArray(e.assertions) ? e.assertions : [],
    }));

  return {
    file: { skill_name: parsed.skill_name, evals },
    reason: 'ok',
  };
}

/**
 * Extract YAML frontmatter from markdown content.
 *
 * Frontmatter is delimited by --- on lines by themselves (matches Jekyll /
 * Hugo / Claude Code conventions). The previous implementation accepted
 * `---name: x---` on a single line, which is not spec-compliant.
 */
function extractFrontmatter(content: string): { frontmatter: string | null; body: string } {
  // Normalise line endings so CRLF files don't bypass the fence regex.
  const normalised = content.replace(/\r\n/g, '\n');

  // Match: optional leading whitespace, "---" + newline, body, "---" on its own line.
  const match = normalised.match(/^\s*---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  return {
    frontmatter: match[1].trim(),
    body: normalised.slice(match[0].length),
  };
}
