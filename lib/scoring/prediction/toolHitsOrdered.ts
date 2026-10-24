/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `tool-hits-ordered` — the labelled LEGACY prediction extractor.
 *
 * Reconstructs a ranked candidate-id list from a report's STORED trajectory
 * (nothing is re-executed). It exists so completed runs can be re-scored
 * today; a native connector output mapping (the agent declaring its ranked
 * candidates) is the follow-up, and reports scored this way carry
 * `scoringSnapshot.extractionRule: 'tool-hits-ordered'` so the provenance is
 * never ambiguous.
 *
 * Rule, exactly:
 *   (a) retrieved ids = ids of every hit in every `tool_result` step, with
 *       the MOST RECENT tool call first and within-call order preserved. A
 *       hit is an object found under one of `hitsPaths` (dotted paths,
 *       default `hits` / `results`) whose id is under one of `idFields`
 *       (default `id` / `_id`). Tool-result `content` is a JSON string —
 *       sometimes wrapped as `[{ text: '<json>' }]` — or an already-parsed
 *       object.
 *   (b) anchors = ids in `toolArgs[argKey]` (string or string[]) of any
 *       `action` step whose `toolName` matches an `anchorTools` entry — these
 *       are the query's own inputs and are REMOVED from the candidates.
 *   (c) cited ids = retrieved ids that appear as whole tokens in the LAST
 *       `response` step's text, ordered by first mention. These go FIRST;
 *       the remaining retrieved ids follow in order (a).
 *   Dedupe keeping the first occurrence; cap at {@link MAX_CANDIDATES}.
 *
 * Every field name here is evaluator DATA (`inputs.prediction`); the defaults
 * are generic conventions, not any specific agent's vocabulary.
 */

import type { DeterministicEvaluatorInputs, TrajectoryStep } from '@/types';
import { dedupeIds } from '@/lib/metrics/index';

export const TOOL_HITS_ORDERED_RULE = 'tool-hits-ordered' as const;
export const MAX_CANDIDATES = 100;
export const DEFAULT_ID_FIELDS = ['id', '_id'] as const;
export const DEFAULT_HITS_PATHS = ['hits', 'results'] as const;

export interface ToolHitsOrderedOptions {
  idFields?: ReadonlyArray<string>;
  hitsPaths?: ReadonlyArray<string>;
  anchorTools?: ReadonlyArray<{ tool: string; argKey: string }>;
}

export interface ExtractedPrediction {
  rule: typeof TOOL_HITS_ORDERED_RULE;
  /** Final ranked candidate ids (cited first, then most-recent-call first), deduped, capped. */
  ranked: string[];
  /** Distinct retrieved ids before anchor removal / citation ordering. */
  candidateCount: number;
  /** Retrieved (non-anchor) ids cited in the final answer. */
  citedCount: number;
  /** Retrieved ids dropped because they were anchors. */
  anchorsRemoved: number;
  /** Whether any `response` step was found at all. */
  hasAnswer: boolean;
}

/** Parse a tool-result `content` into a JSON value (handles `[{text}]` wrapping and plain objects). */
export function parseToolResultContent(content: unknown): unknown {
  let value: unknown = content;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value === 'string') {
      const t = value.trim();
      if (!t) return undefined;
      try {
        value = JSON.parse(t);
      } catch {
        return undefined;
      }
      continue;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(v => v && typeof v === 'object' && typeof (v as any).text === 'string')) {
      // `[{ text: '<json>' }, …]` — unwrap the first text block that parses.
      const texts = (value as Array<{ text: string }>).map(v => v.text);
      let parsed: unknown = undefined;
      for (const text of texts) {
        try {
          parsed = JSON.parse(text);
          break;
        } catch {
          /* try the next block */
        }
      }
      if (parsed === undefined) return undefined;
      value = parsed;
      continue;
    }
    return value;
  }
  return value;
}

/** Walk a dotted path (`forward.records`) through nested objects. */
export function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const idOf = (hit: unknown, idFields: ReadonlyArray<string>): string | null => {
  if (!hit || typeof hit !== 'object') {
    // A bare string/number id in a hits array is accepted as the id itself.
    if (typeof hit === 'string' && hit.trim()) return hit.trim();
    if (typeof hit === 'number' && Number.isFinite(hit)) return String(hit);
    return null;
  }
  for (const f of idFields) {
    const v = (hit as Record<string, unknown>)[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
};

/** Ids of the hits in ONE parsed tool result, in stored order (all `hitsPaths`, in declared order). */
export function idsFromToolResult(parsed: unknown, opts: Required<Pick<ToolHitsOrderedOptions, 'idFields' | 'hitsPaths'>>): string[] {
  const out: string[] = [];
  for (const p of opts.hitsPaths) {
    const arr = getPath(parsed, p);
    if (!Array.isArray(arr)) continue;
    for (const hit of arr) {
      const id = idOf(hit, opts.idFields);
      if (id) out.push(id);
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ids that occur as whole tokens in `text`, ordered by first mention.
 *
 * A token boundary is anything that is not a letter, digit, `_`, `-` or `.`
 * — so `41` is NOT cited by the price `$41.16` (`.1` follows), `16` is not
 * cited by `41.16` (`.` precedes), and `2024` is not cited by `v1.2024-01`.
 * A sentence-ending period still counts as a boundary (`… (id: 202).`).
 */
export function citedIdsInText(text: string, ids: ReadonlyArray<string>): string[] {
  if (!text) return [];
  const positions: Array<{ id: string; at: number }> = [];
  for (const id of ids) {
    const re = new RegExp(`(^|[^A-Za-z0-9_.\\-])${escapeRe(id)}(?=$|[^A-Za-z0-9_.\\-]|\\.(?!\\d))`);
    const m = re.exec(text);
    if (m) positions.push({ id, at: m.index + m[1].length });
  }
  positions.sort((a, b) => a.at - b.at);
  return positions.map(p => p.id);
}

const anchorIdsFromArgs = (args: unknown, argKey: string): string[] => {
  if (!args || typeof args !== 'object') return [];
  const v = (args as Record<string, unknown>)[argKey];
  if (Array.isArray(v)) return dedupeIds(v);
  if (typeof v === 'string' || typeof v === 'number') return dedupeIds([v]);
  return [];
};

export function extractToolHitsOrdered(
  trajectory: ReadonlyArray<TrajectoryStep> | null | undefined,
  options: ToolHitsOrderedOptions = {}
): ExtractedPrediction {
  const idFields = options.idFields && options.idFields.length > 0 ? options.idFields : DEFAULT_ID_FIELDS;
  const hitsPaths = options.hitsPaths && options.hitsPaths.length > 0 ? options.hitsPaths : DEFAULT_HITS_PATHS;
  const anchorTools = options.anchorTools ?? [];
  const steps = Array.isArray(trajectory) ? trajectory : [];

  // (a) most recent tool call first.
  const perCall: string[][] = [];
  const anchors = new Set<string>();
  let lastResponse: string | undefined;
  for (const step of steps) {
    if (!step) continue;
    if (step.type === 'tool_result') {
      const content = (step as any).content;
      const parsed = parseToolResultContent(
        typeof content === 'string' && content.trim() === '' ? (step as any).toolOutput : content ?? (step as any).toolOutput
      );
      const ids = idsFromToolResult(parsed, { idFields, hitsPaths });
      if (ids.length > 0) perCall.push(ids);
    } else if (step.type === 'action') {
      const toolName = (step as any).toolName;
      for (const a of anchorTools) {
        if (a.tool === toolName) {
          for (const id of anchorIdsFromArgs((step as any).toolArgs, a.argKey)) anchors.add(id);
        }
      }
    } else if (step.type === 'response' && typeof step.content === 'string') {
      lastResponse = step.content;
    }
  }
  const retrieved = dedupeIds(perCall.slice().reverse().flat());
  const candidateCount = retrieved.length;

  // (b) anchors removed.
  const nonAnchor = retrieved.filter(id => !anchors.has(id));
  const anchorsRemoved = candidateCount - nonAnchor.length;

  // (c) cited ids first.
  const cited = lastResponse ? citedIdsInText(lastResponse, nonAnchor) : [];
  const ranked = dedupeIds([...cited, ...nonAnchor]).slice(0, MAX_CANDIDATES);

  return {
    rule: TOOL_HITS_ORDERED_RULE,
    ranked,
    candidateCount,
    citedCount: cited.length,
    anchorsRemoved,
    hasAnswer: lastResponse !== undefined,
  };
}

/** Build the extractor options from an evaluator's declared `inputs.prediction`. */
export function toolHitsOptionsFromInputs(prediction: DeterministicEvaluatorInputs['prediction'] | undefined): ToolHitsOrderedOptions {
  return {
    idFields: prediction?.idFields,
    hitsPaths: prediction?.hitsPaths,
    anchorTools: prediction?.anchorTools,
  };
}
