/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Codemod: migrate v1 code-SDK eval files to the RFC-004 control-inversion
 * shape (#256, phase 10 tooling).
 *
 * v1 bodies received a pre-populated `result` fixture (the framework invoked
 * the agent eagerly). v2 bodies own invocation: `const result = await
 * agent.run()`. This transform rewrites each `test(name, options, body)`
 * whose body destructures `result` AND whose options carry a `prompt`:
 *
 *   test('x', { prompt: 'p' }, function ({ result, judge }) {  ...result... })
 *     ↓
 *   test('x', { prompt: 'p' }, async ({ agent, judge }) => {
 *     const result = await agent.run();
 *     ...result...
 *   })
 *
 * Tests with no `prompt` (data-only) are left untouched — their `result` is
 * the empty placeholder, which is still valid. Bodies that already call
 * `agent.run()` are skipped (idempotent).
 *
 * Uses the TypeScript compiler API for a precise, formatting-preserving
 * transform via plain text-range edits (no full reprint), so it works on
 * both `.eval.js` and `.eval.ts`.
 */

import * as ts from 'typescript';

export interface CodemodResult {
  /** The transformed source (equals input when nothing changed). */
  code: string;
  /** Whether any edit was applied. */
  changed: boolean;
  /** Human-readable notes per test (migrated / skipped + why). */
  notes: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Is this call expression a `test(...)` / `test.only(...)` registration? */
function isTestCall(node: ts.CallExpression): boolean {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text === 'test';
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    return e.expression.text === 'test';
  }
  return false;
}

/** Extract the options-object literal argument (2nd arg) if present. */
function optionsArg(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  const a = call.arguments[1];
  return a && ts.isObjectLiteralExpression(a) ? a : undefined;
}

/** Does the options object declare a non-empty `prompt`? */
function hasPrompt(opts: ts.ObjectLiteralExpression | undefined): boolean {
  if (!opts) return false;
  return opts.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ((ts.isIdentifier(p.name) && p.name.text === 'prompt') ||
        (ts.isStringLiteral(p.name) && p.name.text === 'prompt'))
  );
}

/** The body is the last argument when it's a function/arrow. */
function bodyArg(call: ts.CallExpression): ts.FunctionExpression | ts.ArrowFunction | undefined {
  const last = call.arguments[call.arguments.length - 1];
  if (last && (ts.isFunctionExpression(last) || ts.isArrowFunction(last))) return last;
  return undefined;
}

/**
 * Run the codemod over a single file's source text.
 */
export function migrateEvalSource(code: string, fileName = 'eval.ts'): CodemodResult {
  const sf = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );

  const edits: Edit[] = [];
  const notes: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      processTest(node);
    }
    ts.forEachChild(node, visit);
  };

  function testName(call: ts.CallExpression): string {
    const a = call.arguments[0];
    return a && ts.isStringLiteralLike(a) ? a.text : '<anonymous>';
  }

  function processTest(call: ts.CallExpression) {
    const name = testName(call);
    const body = bodyArg(call);
    if (!body) return; // no function body (e.g. test(name) stub)

    const param = body.parameters[0];
    // Only the object-destructuring fixture form is migrated.
    if (!param || !ts.isObjectBindingPattern(param.name)) {
      return;
    }
    const binding = param.name;
    const names = binding.elements
      .map((el) => (ts.isIdentifier(el.name) ? el.name.text : ''))
      .filter(Boolean);

    const usesResult = names.includes('result');
    const usesAgent = names.includes('agent');

    // Idempotency / applicability guards.
    const bodyText = body.body ? body.body.getText(sf) : '';
    const hasAgentRun = /\bagent\s*\.\s*run\s*\(/.test(bodyText);
    if (hasAgentRun && !usesResult) {
      // Fully migrated: calls agent.run() and no longer destructures `result`.
      notes.push(`skip  ${name}: already migrated (calls agent.run(), no result binding)`);
      return;
    }
    if (hasAgentRun && usesResult) {
      // Half-migrated: agent.run() is in, but `result` is still destructured
      // (and almost certainly still referenced). The runner hands the body an
      // empty placeholder `result` when `agent` is destructured separately, so
      // those `result.*` reads silently read empties and assertions fail — the
      // migration *looks* broken when it isn't. We can't safely rename those
      // reads to the agent.run() return value, so surface for manual review
      // instead of silently reporting "already migrated".
      notes.push(
        `review ${name}: half-migrated — calls agent.run() but still destructures \`result\`. ` +
          `Capture the agent.run() return value (\`const result = await agent.run()\`) and drop the \`result\` fixture.`
      );
      return;
    }
    if (!hasPrompt(optionsArg(call))) {
      notes.push(`skip  ${name}: no prompt (data-only test, result placeholder is valid)`);
      return;
    }
    if (!usesResult) {
      notes.push(`skip  ${name}: body does not use result`);
      return;
    }

    // 1) Rewrite the destructuring: replace `result` with `agent` (or add
    //    `agent` if result+agent both somehow absent). Keep other fixtures.
    const newNames = names.map((n) => (n === 'result' ? 'agent' : n));
    if (usesAgent) {
      // agent already destructured — just drop `result`.
      const filtered = names.filter((n) => n !== 'result');
      newNames.length = 0;
      newNames.push(...filtered);
    }
    const newBinding = `{ ${newNames.join(', ')} }`;
    edits.push({ start: binding.getStart(sf), end: binding.getEnd(), text: newBinding });

    // 2) Ensure the function is async.
    const isAsync = body.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (!isAsync) {
      edits.push({ start: body.getStart(sf), end: body.getStart(sf), text: 'async ' });
    }

    // 3) Insert `const result = await agent.run();` at the top of the body.
    //    Handle both block bodies `{ ... }` and expression arrow bodies.
    if (body.body && ts.isBlock(body.body)) {
      const openBrace = body.body.getStart(sf) + 1; // just after `{`
      edits.push({ start: openBrace, end: openBrace, text: `\n  const result = await agent.run();` });
    } else if (body.body) {
      // Expression-bodied arrow: wrap into a block.
      const exprStart = body.body.getStart(sf);
      const exprEnd = body.body.getEnd();
      const exprText = body.body.getText(sf);
      edits.push({
        start: exprStart,
        end: exprEnd,
        text: `{\n  const result = await agent.run();\n  return ${exprText};\n}`,
      });
    }

    notes.push(`migrate ${name}: result → agent.run()`);
  }

  visit(sf);

  if (edits.length === 0) {
    return { code, changed: false, notes };
  }

  // Apply edits right-to-left so offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return { code: out, changed: true, notes };
}
