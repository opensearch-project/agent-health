/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chai-based `expect` with two extensions:
 *
 *  1. A recording plugin that captures every assertion outcome on the
 *     active matcher session (so the runner can persist per-matcher
 *     results and the UI can show a breakdown).
 *
 *  2. Custom matchers tailored to agent trajectories:
 *     - `.haveCalledTool(name)`            — tool was invoked
 *     - `.haveStepsOfType(type)`           — at least one step of given type
 *     - `.haveOutputMatching(regex)`       — final response matches regex
 *     - `.haveCompletedWithin(ms)`         — durationMs is below threshold
 *
 * Chai's BDD style: `expect(value).to.<matcher>(...)`.
 */

import * as chai from 'chai';
import { recordVerdict } from './session.js';
import type { TrajectoryStep } from '../../types/index.js';

let pluginsInstalled = false;

/**
 * Install the recording plugin once per process. Subsequent calls are
 * no-ops so the plugin doesn't double-record when the SDK is loaded
 * multiple times in the same Node session.
 */
function ensurePluginsInstalled(): void {
  if (pluginsInstalled) return;
  pluginsInstalled = true;

  const Assertion = (chai as any).Assertion;
  const utils = (chai as any).util;

  // ─── Recording plugin ────────────────────────────────────────────────
  // Wraps Assertion.prototype.assert so every chai expr produces a
  // MatcherResult on the active session.
  const originalAssert = Assertion.prototype.assert;
  Assertion.prototype.assert = function (
    this: any,
    expr: unknown,
    msg: string | (() => string),
    negateMsg: string | (() => string),
    expected: unknown,
    actual: unknown,
    showDiff: boolean
  ): any {
    const negate = utils.flag(this, 'negate');
    const ok = negate ? !expr : !!expr;
    // chai resolves #{this}, #{exp}, #{act} placeholders only when it builds
    // its own error message. We resolve them here so the recorded
    // description is human-readable in the UI for both passing and failing
    // assertions.
    const description = describeAssertion(this, expr, msg, negateMsg, expected, actual, utils);

    try {
      const result = originalAssert.call(this, expr, msg, negateMsg, expected, actual, showDiff);
      if (description) {
        recordVerdict({
          description,
          pass: true,
          method: 'code-assertion',
          actual: safeClone(actual ?? utils.flag(this, 'object')),
          expected: safeClone(expected),
        });
      }
      return result;
    } catch (err: any) {
      if (description) {
        recordVerdict({
          description,
          pass: false,
          method: 'code-assertion',
          actual: safeClone(actual ?? utils.flag(this, 'object')),
          expected: safeClone(expected),
          errorMessage: err?.message || String(err),
        });
      }
      throw err;
    }
  };

  // ─── Custom matchers ──────────────────────────────────────────────────

  /**
   * `.haveCalledTool(toolName, argsPartial?)`
   * Asserts that `actual` is an array of TrajectoryStep with at least one
   * `action` step whose toolName matches and whose toolArgs is a superset
   * of `argsPartial` (when provided).
   */
  Assertion.addMethod('haveCalledTool', function (this: any, toolName: string, argsPartial?: Record<string, unknown>) {
    const trajectory = utils.flag(this, 'object') as TrajectoryStep[];
    if (!Array.isArray(trajectory)) {
      this.assert(false, 'expected an array of TrajectoryStep', '', toolName, trajectory);
      return;
    }
    const matches = trajectory.filter((step: any) => step?.type === 'action' && step?.toolName === toolName);
    let hit: TrajectoryStep | undefined = matches[0];
    if (argsPartial && matches.length > 0) {
      hit = matches.find((s: any) => isSupersetOf(s.toolArgs ?? s.input, argsPartial));
    }
    const argsLabel = argsPartial ? ` with args ${JSON.stringify(argsPartial)}` : '';
    this.assert(
      !!hit,
      `expected trajectory to have called tool '${toolName}'${argsLabel}`,
      `expected trajectory to NOT have called tool '${toolName}'${argsLabel}`,
      toolName,
      matches.map((m: any) => ({ toolName: m.toolName, toolArgs: m.toolArgs ?? m.input }))
    );
  });

  /**
   * `.haveStepsOfType(type)` — at least one step has the given `type`
   * (e.g. 'thinking', 'action', 'response', 'tool_result').
   */
  Assertion.addMethod('haveStepsOfType', function (this: any, type: string) {
    const trajectory = utils.flag(this, 'object') as TrajectoryStep[];
    const arr = Array.isArray(trajectory) ? trajectory : [];
    const found = arr.filter((s: any) => s?.type === type);
    this.assert(
      found.length > 0,
      `expected trajectory to have at least one step of type '${type}'`,
      `expected trajectory to have NO steps of type '${type}' but found ${found.length}`,
      type,
      arr.map((s: any) => s?.type)
    );
  });

  /**
   * `.haveOutputMatching(pattern)` — `actual` is a string and matches the
   * given regex (or contains the given substring).
   */
  Assertion.addMethod('haveOutputMatching', function (this: any, pattern: RegExp | string) {
    const text = utils.flag(this, 'object') as unknown;
    const str = typeof text === 'string' ? text : '';
    const re = pattern instanceof RegExp ? pattern : new RegExp(escapeRegex(String(pattern)));
    this.assert(
      re.test(str),
      `expected output to match ${re}`,
      `expected output to NOT match ${re}`,
      pattern,
      str
    );
  });

  /**
   * `.haveCompletedWithin(thresholdMs)` — `actual` is an EvalResult-shaped
   * object whose `durationMs` is below `thresholdMs`.
   */
  Assertion.addMethod('haveCompletedWithin', function (this: any, thresholdMs: number) {
    const obj = utils.flag(this, 'object') as { durationMs?: number };
    const duration = obj?.durationMs ?? 0;
    this.assert(
      duration <= thresholdMs,
      `expected to have completed within ${thresholdMs}ms (took ${duration}ms)`,
      `expected to have NOT completed within ${thresholdMs}ms`,
      thresholdMs,
      duration
    );
  });

  /**
   * `.toPass()` — assert a judge {@link Verdict} passed. Gives `judge()`'s
   * non-throwing verdict an ergonomic gate:
   *   expect(await judge(result, claim)).toPass();
   * Reads `verdict.pass`; surfaces `verdict.reasoning` / `errorMessage` on
   * failure so the recorded matcher is actionable.
   */
  Assertion.addMethod('toPass', function (this: any) {
    const verdict = utils.flag(this, 'object') as {
      pass?: boolean; reasoning?: string; errorMessage?: string; accuracy?: number;
    };
    const passed = !!verdict?.pass;
    const detail = verdict?.errorMessage || verdict?.reasoning || '';
    this.assert(
      passed,
      `expected judge verdict to pass${detail ? ` — ${detail}` : ''}`,
      `expected judge verdict to NOT pass`,
      true,
      passed
    );
  });
}

ensurePluginsInstalled();

/** The user-facing `expect` — chai's expect with our plugin pre-installed. */
export const expect = chai.expect;

/**
 * Build a UI-friendly description for an assertion. Chai's raw msg/negateMsg
 * contain `#{this}`, `#{exp}`, `#{act}` placeholders that only get resolved
 * by chai when it builds an error message. We resolve them here so the
 * description is readable on pass too.
 */
function describeAssertion(
  ctx: any,
  _expr: unknown,
  msg: string | (() => string),
  negateMsg: string | (() => string),
  expected: unknown,
  actual: unknown,
  utils: any
): string {
  const rawMsg = typeof msg === 'function' ? msg() : msg;
  const rawNeg = typeof negateMsg === 'function' ? negateMsg() : negateMsg;
  const template: string = rawMsg || rawNeg || '';
  if (!template) return '';
  const obj = utils.flag(ctx, 'object');
  const resolved = template
    .replace(/#\{this\}/g, () => safeInspect(obj, utils))
    .replace(/#\{act\}/g, () => safeInspect(actual, utils))
    .replace(/#\{exp\}/g, () => safeInspect(expected, utils));
  return shortDescription(resolved);
}

function safeInspect(v: unknown, utils: any): string {
  try {
    const str =
      utils.objDisplay && typeof utils.objDisplay === 'function'
        ? utils.objDisplay(v)
        : utils.inspect
        ? utils.inspect(v)
        : String(v);
    if (typeof str !== 'string') return String(v);
    return str.length > 60 ? `${str.slice(0, 57)}\u2026` : str;
  } catch {
    return String(v);
  }
}

/** Trim chai's verbose default messages to a UI-friendly description. */
function shortDescription(msg: string): string {
  // chai messages look like "expected X to contain Y". Drop the "expected X "
  // prefix when we have a useful object label so the UI shows the matcher,
  // not the actual data dump.
  const trimmed = msg.replace(/^expected\s+/i, '');
  // Cap at 120 chars to keep tables readable.
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}\u2026` : trimmed;
}

/** Best-effort clone for serialization \u2014 stringify primitives and small objects. */
function safeClone(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    const s = JSON.stringify(v);
    if (s && s.length < 2000) return JSON.parse(s);
    return s ? `${s.slice(0, 1997)}...` : '[unserializable]';
  } catch {
    return '[circular]';
  }
}

function isSupersetOf(actual: any, expected: Record<string, unknown>): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) return false;
    if (typeof v === 'object' && v !== null) {
      if (!isSupersetOf((actual as any)[k], v as Record<string, unknown>)) return false;
    } else if ((actual as any)[k] !== v) {
      return false;
    }
  }
  return true;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── TypeScript module augmentation ─────────────────────────────────
// chai@4 uses ambient namespace declarations rather than modules, so we
// can't `declare module 'chai'` here. The custom matchers above
// (haveCalledTool, haveStepsOfType, haveOutputMatching, haveCompletedWithin)
// are registered via `Assertion.addMethod` and work at runtime; user code
// that wants type-safe access can either cast `as any` or drop a tiny
// .d.ts in their own project that augments `Chai.Assertion`.
