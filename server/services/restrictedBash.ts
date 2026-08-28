/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A deliberately small, in-process shell used by the evidence judge.
 *
 * This is NOT a process launcher. It parses a fixed shell subset and implements
 * every command below with Node APIs (plus jq-wasm). Paths are confined to one
 * judgment directory and writes are confined further to scratch/.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

export const RESTRICTED_COMMANDS = [
  'jq', 'grep', 'rg', 'sort', 'cat', 'ls', 'find', 'head', 'tail', 'wc',
  'uniq', 'cut', 'tr', 'sed', 'echo', 'pwd',
] as const;

const AVAILABLE = RESTRICTED_COMMANDS.join(', ');
const DEFAULT_OUTPUT_CAP = 50 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;
const DEFAULT_QUOTA_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_REGEX_LENGTH = 512;

export interface RestrictedBashMount {
  /** Virtual, root-relative read path (for example evidence/spans.ndjson). */
  virtualPath: string;
  /**
   * Canonical source(s). Multiple regular files are concatenated into one
   * virtual file; one directory exposes a virtual read-only directory tree.
   */
  sourcePaths: readonly string[];
}

type FileMount = {
  kind: 'file';
  virtualPath: string;
  virtualAbs: string;
  sourcePaths: readonly string[];
};
type DirectoryMount = {
  kind: 'directory';
  virtualPath: string;
  virtualAbs: string;
  sourceRoot: string;
};
type ResolvedMount = FileMount | DirectoryMount;
type MountedPath = FileMount | (DirectoryMount & { sourcePath: string });

export interface RestrictedBashOptions {
  rootDir: string;
  mounts?: readonly RestrictedBashMount[];
  timeoutMs?: number;
  outputCapBytes?: number;
  quotaBytes?: number;
  quotaFiles?: number;
  maxFileBytes?: number;
  maxInputBytes?: number;
  onCommand?: (command: string) => void;
}

export interface BashExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  text: string;
}

type Operator = ';' | '&&' | '||';
type Token = { value: string; quoted: boolean };
type Redirect = { kind: '<' | '>' | '>>'; path: string };
type SimpleCommand = { argv: string[]; redirects: Redirect[] };
type Pipeline = SimpleCommand[];
export type ParsedRestrictedCommand = { first: Pipeline; rest: Array<{ op: Operator; pipeline: Pipeline }> };
type CommandResult = { stdout: string; stderr: string; exitCode: number };

function syntaxError(message: string): never {
  throw new Error(`restricted bash: ${message}`);
}

/** Tokenize only the shell syntax this interpreter understands. */
function lex(input: string): Array<Token | { op: string }> {
  if (!input.trim()) syntaxError('empty command');
  const out: Array<Token | { op: string }> = [];
  let value = '';
  let quote: "'" | '"' | null = null;
  let quoted = false;
  const push = () => {
    if (value.length || quoted) out.push({ value, quoted });
    value = '';
    quoted = false;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) { quote = null; quoted = true; continue; }
      if (quote === '"' && c === '\\' && i + 1 < input.length && ['"', '\\'].includes(input[i + 1])) {
        value += input[++i];
      } else {
        value += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '\\') {
      if (i + 1 >= input.length) syntaxError('trailing escape');
      value += input[++i];
      quoted = true;
      continue;
    }
    if (c === '`') syntaxError('backticks/command substitution are not supported');
    if (c === '$') syntaxError('variables and command substitution are not supported');
    if (c === '(' || c === ')') syntaxError('subshells are not supported');
    if (c === '&') {
      push();
      if (input[i + 1] === '&') { out.push({ op: '&&' }); i++; continue; }
      syntaxError("background operator '&' is not supported");
    }
    if (c === '|') {
      push();
      if (input[i + 1] === '|') { out.push({ op: '||' }); i++; } else out.push({ op: '|' });
      continue;
    }
    if (c === ';') { push(); out.push({ op: ';' }); continue; }
    if (c === '>') {
      push();
      if (input[i + 1] === '>') { out.push({ op: '>>' }); i++; } else out.push({ op: '>' });
      continue;
    }
    if (c === '<') { push(); out.push({ op: '<' }); continue; }
    value += c;
  }
  if (quote) syntaxError('unterminated quote');
  push();
  for (const token of out) {
    if ('value' in token && !token.quoted && /[*?[]/.test(token.value)) {
      syntaxError("glob expansion is not supported; use find -name with a quoted pattern");
    }
  }
  return out;
}

export function parseRestrictedCommand(input: string): ParsedRestrictedCommand {
  const tokens = lex(input);
  let cursor = 0;
  const simple = (): SimpleCommand => {
    const argv: string[] = [];
    const redirects: Redirect[] = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if ('op' in token) {
        if (token.op === '<' || token.op === '>' || token.op === '>>') {
          cursor++;
          const target = tokens[cursor++];
          if (!target || 'op' in target) syntaxError(`redirect ${token.op} requires a path`);
          redirects.push({ kind: token.op, path: target.value });
          continue;
        }
        break;
      }
      argv.push(token.value);
      cursor++;
    }
    if (!argv.length) syntaxError('expected a command');
    return { argv, redirects };
  };
  const pipeline = (): Pipeline => {
    const commands = [simple()];
    while (cursor < tokens.length && 'op' in tokens[cursor] && (tokens[cursor] as any).op === '|') {
      cursor++;
      commands.push(simple());
    }
    return commands;
  };

  const first = pipeline();
  const rest: ParsedRestrictedCommand['rest'] = [];
  while (cursor < tokens.length) {
    const token = tokens[cursor++];
    if (!('op' in token) || ![';', '&&', '||'].includes(token.op)) syntaxError(`unexpected operator '${'op' in token ? token.op : token.value}'`);
    if (cursor >= tokens.length) syntaxError(`operator '${token.op}' requires another command`);
    rest.push({ op: token.op as Operator, pipeline: pipeline() });
  }
  return { first, rest };
}

function ok(stdout = ''): CommandResult { return { stdout, stderr: '', exitCode: 0 }; }
function fail(stderr: string, exitCode = 1): CommandResult { return { stdout: '', stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`, exitCode }; }
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
function withFinalNewline(lines: string[]): string { return lines.length ? `${lines.join('\n')}\n` : ''; }
function regexEscape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function validateRegex(pattern: string): void {
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new Error(`restricted bash: regex exceeds ${MAX_REGEX_LENGTH} characters; use a shorter expression or -F`);
  }
  // Reject the common catastrophic-backtracking shape: a quantified group
  // containing another unbounded quantifier, e.g. (a+)+ or (.*)*.
  if (/\((?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)(?:[*+]|\{\d*,?\d*\})/.test(pattern)) {
    throw new Error('restricted bash: regex has nested quantifiers; use -F or a bounded expression');
  }
}
function shellUnescapeSet(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\(.)/g, '$1');
}

export class RestrictedBash {
  private readonly rootDir: string;
  private readonly scratchDir: string;
  private readonly timeoutMs: number;
  private readonly outputCapBytes: number;
  private readonly quotaBytes: number;
  private readonly quotaFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxInputBytes: number;
  private readonly onCommand?: (command: string) => void;
  private readonly mounts: ReadonlyMap<string, ResolvedMount>;

  private constructor(
    options: RestrictedBashOptions,
    rootDir: string,
    mounts: ReadonlyMap<string, ResolvedMount>
  ) {
    this.rootDir = rootDir;
    this.scratchDir = path.join(rootDir, 'scratch');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.outputCapBytes = options.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.quotaFiles = options.quotaFiles ?? DEFAULT_QUOTA_FILES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    this.onCommand = options.onCommand;
    this.mounts = mounts;
  }

  static async create(options: RestrictedBashOptions): Promise<RestrictedBash> {
    const rootDir = await fs.realpath(options.rootDir);
    const scratch = path.join(rootDir, 'scratch');
    await fs.mkdir(scratch, { recursive: true });
    const scratchReal = await fs.realpath(scratch);
    if (!RestrictedBash.inside(rootDir, scratchReal)) throw new Error('restricted bash: scratch is outside the evidence root');

    const mounts = new Map<string, ResolvedMount>();
    for (const mount of options.mounts ?? []) {
      if (!mount.virtualPath || path.isAbsolute(mount.virtualPath) || mount.virtualPath.split(/[\\/]+/).includes('..')) {
        throw new Error(`restricted bash: invalid mount path: ${mount.virtualPath}`);
      }
      const virtualAbs = path.resolve(rootDir, mount.virtualPath);
      if (!RestrictedBash.inside(rootDir, virtualAbs) || RestrictedBash.inside(scratchReal, virtualAbs)) {
        throw new Error(`restricted bash: mount must be read-only and inside the judgment tree: ${mount.virtualPath}`);
      }
      if ([...mounts.keys()].some((existing) => RestrictedBash.inside(existing, virtualAbs) || RestrictedBash.inside(virtualAbs, existing))) {
        throw new Error(`restricted bash: overlapping mount: ${mount.virtualPath}`);
      }
      if (await fs.lstat(virtualAbs).catch(() => undefined)) {
        throw new Error(`restricted bash: mount shadows a physical entry: ${mount.virtualPath}`);
      }
      const parentReal = await fs.realpath(path.dirname(virtualAbs)).catch(() => undefined);
      if (!parentReal || !RestrictedBash.inside(rootDir, parentReal)) {
        throw new Error(`restricted bash: mount parent is outside the judgment tree: ${mount.virtualPath}`);
      }
      if (!mount.sourcePaths.length) throw new Error(`restricted bash: mount has no sources: ${mount.virtualPath}`);

      const sourceStats = await Promise.all(mount.sourcePaths.map(async (source) => ({
        source,
        stat: await fs.lstat(source).catch(() => undefined),
      })));
      if (sourceStats.length === 1 && sourceStats[0].stat?.isDirectory() && !sourceStats[0].stat?.isSymbolicLink()) {
        const sourceRoot = await fs.realpath(sourceStats[0].source);
        mounts.set(virtualAbs, {
          kind: 'directory', virtualAbs, virtualPath: path.relative(rootDir, virtualAbs), sourceRoot,
        });
        continue;
      }

      const sourcePaths: string[] = [];
      for (const { source, stat } of sourceStats) {
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          throw new Error(`restricted bash: mount source must be regular non-symlink file(s), or one non-symlink directory: ${source}`);
        }
        sourcePaths.push(await fs.realpath(source));
      }
      mounts.set(virtualAbs, {
        kind: 'file', virtualAbs, virtualPath: path.relative(rootDir, virtualAbs), sourcePaths,
      });
    }
    return new RestrictedBash(options, rootDir, mounts);
  }

  private static inside(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(root + path.sep);
  }

  private display(abs: string): string {
    const rel = path.relative(this.rootDir, abs);
    return rel || '.';
  }

  private rejectTraversal(input: string): void {
    if (input.split(/[\\/]+/).includes('..')) throw new Error(`restricted bash: path escape rejected: ${input}`);
  }

  /** Resolve exact file mounts or descendants of an explicitly mounted directory. */
  private mountFor(input: string): MountedPath | undefined {
    this.rejectTraversal(input);
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.rootDir, input || '.');
    if (!RestrictedBash.inside(this.rootDir, candidate)) return undefined;
    const exact = this.mounts.get(candidate);
    if (exact?.kind === 'file') return exact;
    for (const mount of this.mounts.values()) {
      if (mount.kind === 'directory' && RestrictedBash.inside(mount.virtualAbs, candidate)) {
        return { ...mount, sourcePath: path.join(mount.sourceRoot, path.relative(mount.virtualAbs, candidate)) };
      }
    }
    return undefined;
  }

  private mountsInDirectory(absDir: string): Array<ResolvedMount & { name: string }> {
    return [...this.mounts.entries()]
      .filter(([virtualAbs]) => path.dirname(virtualAbs) === absDir)
      .map(([virtualAbs, mount]) => ({ name: path.basename(virtualAbs), ...mount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async validateFileMountSource(source: string): Promise<void> {
    const stat = await fs.lstat(source).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || await fs.realpath(source).catch(() => undefined) !== source) {
      throw new Error('restricted bash: mounted source is no longer the exact allowed canonical file');
    }
  }

  private async validateDirectoryMountPath(mount: DirectoryMount & { sourcePath: string }): Promise<string> {
    const rootStat = await fs.lstat(mount.sourceRoot).catch(() => undefined);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(mount.sourceRoot).catch(() => undefined) !== mount.sourceRoot) {
      throw new Error('restricted bash: mounted workspace root is no longer the exact allowed canonical directory');
    }
    const stat = await fs.lstat(mount.sourcePath).catch(() => undefined);
    if (!stat) throw new Error(`restricted bash: no such file or directory: ${mount.virtualPath}`);
    if (stat.isSymbolicLink()) throw new Error(`restricted bash: symlinks are not allowed in mounted workspace: ${mount.virtualPath}`);
    const real = await fs.realpath(mount.sourcePath);
    if (!RestrictedBash.inside(mount.sourceRoot, real) || real !== path.resolve(mount.sourcePath)) {
      throw new Error(`restricted bash: mounted workspace path escapes its root: ${mount.virtualPath}`);
    }
    return real;
  }

  private async mountSize(mount: FileMount): Promise<number> {
    let size = 0;
    for (const source of mount.sourcePaths) {
      await this.validateFileMountSource(source);
      size += (await fs.stat(source)).size;
    }
    return size;
  }

  private async readText(input: string): Promise<string> {
    const mount = this.mountFor(input);
    const paths = mount?.kind === 'file'
      ? [...mount.sourcePaths]
      : [mount ? await this.validateDirectoryMountPath(mount) : await this.readPath(input)];
    let total = 0;
    for (const source of paths) {
      if (mount?.kind === 'file') await this.validateFileMountSource(source);
      const size = (await fs.stat(source)).size;
      if (size > this.maxFileBytes) {
        throw new Error(`restricted bash: input ${input} is ${size} bytes (per-file limit ${this.maxFileBytes}); narrow or split the evidence`);
      }
      total += size;
      if (total > this.maxInputBytes) {
        throw new Error(`restricted bash: inputs exceed ${this.maxInputBytes} bytes; narrow the file set with find/head`);
      }
    }
    return (await Promise.all(paths.map((source) => fs.readFile(source, 'utf8')))).join('');
  }

  private async readPath(input: string): Promise<string> {
    this.rejectTraversal(input);
    const mounted = this.mountFor(input);
    if (mounted) {
      if (mounted.kind === 'file') throw new Error(`restricted bash: ${input}: is a virtual file`);
      return this.validateDirectoryMountPath(mounted);
    }
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.rootDir, input || '.');
    if (!RestrictedBash.inside(this.rootDir, candidate)) throw new Error(`restricted bash: path outside judgment directory: ${input}`);
    const stat = await fs.lstat(candidate).catch(() => undefined);
    if (!stat) throw new Error(`restricted bash: no such file or directory: ${input}`);
    if (stat.isSymbolicLink()) throw new Error(`restricted bash: symlinks are not allowed: ${input}`);
    const real = await fs.realpath(candidate);
    if (!RestrictedBash.inside(this.rootDir, real)) throw new Error(`restricted bash: path outside judgment directory: ${input}`);
    return real;
  }

  private async writePath(input: string): Promise<string> {
    this.rejectTraversal(input);
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.rootDir, input);
    if (!RestrictedBash.inside(this.scratchDir, candidate)) {
      throw new Error(`restricted bash: writes are allowed only under scratch/: ${input}`);
    }
    const parent = await this.readPath(path.dirname(candidate));
    if (!RestrictedBash.inside(this.scratchDir, parent)) throw new Error(`restricted bash: writes are allowed only under scratch/: ${input}`);
    const existing = await fs.lstat(candidate).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error(`restricted bash: symlinks are not allowed: ${input}`);
    if (existing?.isDirectory()) throw new Error(`restricted bash: cannot redirect to a directory: ${input}`);
    return candidate;
  }

  private async scratchUsage(dir = this.scratchDir): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`restricted bash: symlink found in scratch/: ${this.display(abs)}`);
      if (entry.isDirectory()) {
        const child = await this.scratchUsage(abs);
        files += child.files; bytes += child.bytes;
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        files++; bytes += stat.size;
      }
    }
    return { files, bytes };
  }

  private async redirectWrite(target: string, content: string, append: boolean): Promise<void> {
    const abs = await this.writePath(target);
    const usage = await this.scratchUsage();
    const old = await fs.stat(abs).catch(() => undefined);
    const incoming = Buffer.byteLength(content);
    const projectedBytes = usage.bytes - (append ? 0 : (old?.size ?? 0)) + incoming;
    const projectedFiles = usage.files + (old ? 0 : 1);
    if (projectedBytes > this.quotaBytes || projectedFiles > this.quotaFiles) {
      throw new Error(
        `restricted bash: scratch quota exceeded (limit ${this.quotaBytes} bytes / ${this.quotaFiles} files)`
      );
    }
    await fs.writeFile(abs, content, { flag: append ? 'a' : 'w' });
  }

  async execute(command: string): Promise<BashExecutionResult> {
    this.onCommand?.(command);
    const parsed = parseRestrictedCommand(command);
    if (this.timeoutMs <= 0) {
      const result = fail(`restricted bash: command timed out after ${this.timeoutMs}ms`, 2);
      return { ...result, text: this.render(result.stdout, result.stderr, result.exitCode) };
    }
    const work = this.executeParsed(parsed);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`restricted bash: command timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    try {
      const result = await Promise.race([work, timeout]);
      const capped = this.capOutput(result.stdout, result.stderr);
      return { ...result, ...capped, text: this.render(capped.stdout, capped.stderr, result.exitCode) };
    } catch (err: any) {
      const result = fail(err?.message ?? String(err), 2);
      const capped = this.capOutput(result.stdout, result.stderr);
      return { ...result, ...capped, text: this.render(capped.stdout, capped.stderr, result.exitCode) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private capOutput(stdout: string, stderr: string): { stdout: string; stderr: string } {
    const combined = Buffer.from(stdout + stderr);
    if (combined.length <= this.outputCapBytes) return { stdout, stderr };
    const marker = `\n... [output truncated at ${this.outputCapBytes} bytes; narrow the query with grep/head/jq]\n`;
    const kept = combined.subarray(0, Math.max(0, this.outputCapBytes - Buffer.byteLength(marker))).toString('utf8') + marker;
    return { stdout: kept, stderr: '' };
  }

  private render(stdout: string, stderr: string, exitCode: number): string {
    const body = `${stdout}${stderr}`;
    return `${body}${body && !body.endsWith('\n') ? '\n' : ''}[exit ${exitCode}]`;
  }

  private async executeParsed(parsed: ParsedRestrictedCommand): Promise<CommandResult> {
    let result = await this.executePipeline(parsed.first);
    let stdout = result.stdout;
    let stderr = result.stderr;
    for (const next of parsed.rest) {
      if (next.op === '&&' && result.exitCode !== 0) continue;
      if (next.op === '||' && result.exitCode === 0) continue;
      result = await this.executePipeline(next.pipeline);
      stdout += result.stdout;
      stderr += result.stderr;
    }
    return { stdout, stderr, exitCode: result.exitCode };
  }

  private async executePipeline(pipeline: Pipeline): Promise<CommandResult> {
    let input = '';
    let result = ok();
    let stderr = '';
    for (const command of pipeline) {
      result = await this.executeSimple(command, input);
      input = result.stdout;
      stderr += result.stderr;
    }
    return { ...result, stderr };
  }

  private async executeSimple(command: SimpleCommand, pipelineInput: string): Promise<CommandResult> {
    const [name, ...args] = command.argv;
    if (name === 'cd') return fail('bash: cd: not supported; the restricted cwd is fixed at the judgment root', 2);
    if (!(RESTRICTED_COMMANDS as readonly string[]).includes(name)) {
      return fail(`bash: ${name}: command not found on this restricted host (available: ${AVAILABLE})`, 127);
    }
    let input = pipelineInput;
    const inputRedirects = command.redirects.filter((r) => r.kind === '<');
    const outputRedirects = command.redirects.filter((r) => r.kind !== '<');
    if (inputRedirects.length > 1 || outputRedirects.length > 1) return fail('restricted bash: only one input and one output redirect are allowed', 2);
    if (inputRedirects[0]) input = await this.readText(inputRedirects[0].path);

    let result = await this.runCommand(name, args, input);
    if (outputRedirects[0]) {
      if (result.exitCode === 0) {
        await this.redirectWrite(outputRedirects[0].path, result.stdout, outputRedirects[0].kind === '>>');
        result = { ...result, stdout: '' };
      }
    }
    return result;
  }

  private async fileInputs(args: string[], stdin: string, recursive = false): Promise<Array<{ name?: string; text: string }>> {
    if (!args.length) return [{ text: stdin }];
    const files: Array<{ name?: string; text: string }> = [];
    let totalBytes = Buffer.byteLength(stdin);
    const account = (size: number, name: string) => {
      if (size > this.maxFileBytes) throw new Error(`restricted bash: input ${name} is ${size} bytes (per-file limit ${this.maxFileBytes}); narrow or split the evidence`);
      totalBytes += size;
      if (totalBytes > this.maxInputBytes) throw new Error(`restricted bash: inputs exceed ${this.maxInputBytes} bytes; narrow the file set with find/head`);
    };
    const visit = async (input: string): Promise<void> => {
      if (input === '-') { files.push({ text: stdin }); return; }
      const mount = this.mountFor(input);
      if (mount?.kind === 'file') {
        files.push({ name: input, text: await this.readText(input) });
        return;
      }
      const abs = await this.readPath(input);
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        if (!recursive) throw new Error(`restricted bash: ${input}: is a directory`);
        const physical = await fs.readdir(abs, { withFileTypes: true });
        for (const entry of physical) {
          if (entry.isSymbolicLink()) continue;
          await visit(path.join(input, entry.name));
        }
        for (const child of this.mountsInDirectory(abs)) {
          if (!physical.some((entry) => entry.name === child.name)) await visit(path.join(input, child.name));
        }
      } else if (stat.isFile()) {
        account(stat.size, input);
        files.push({ name: input, text: await fs.readFile(abs, 'utf8') });
      }
    };
    for (const arg of args) await visit(arg);
    return files;
  }

  private async runCommand(name: string, args: string[], stdin: string): Promise<CommandResult> {
    try {
      switch (name) {
        case 'pwd': return args.length ? fail('pwd: too many arguments', 2) : ok(`${this.rootDir}\n`);
        case 'echo': return ok(`${args[0] === '-n' ? args.slice(1).join(' ') : args.join(' ')}${args[0] === '-n' ? '' : '\n'}`);
        case 'cat': return this.cat(args, stdin);
        case 'ls': return this.ls(args);
        case 'find': return this.find(args);
        case 'grep': return this.grep(args, stdin, false);
        case 'rg': return this.grep(args, stdin, true);
        case 'head': return this.headTail(args, stdin, false);
        case 'tail': return this.headTail(args, stdin, true);
        case 'wc': return this.wc(args, stdin);
        case 'sort': return this.sort(args, stdin);
        case 'uniq': return this.uniq(args, stdin);
        case 'cut': return this.cut(args, stdin);
        case 'tr': return this.tr(args, stdin);
        case 'sed': return this.sed(args, stdin);
        case 'jq': return this.jq(args, stdin);
        default: return fail(`bash: ${name}: command not found`, 127);
      }
    } catch (err: any) {
      return fail(err?.message ?? String(err), 2);
    }
  }

  private async cat(args: string[], stdin: string): Promise<CommandResult> {
    const files = await this.fileInputs(args, stdin);
    return ok(files.map((f) => f.text).join(''));
  }

  private async ls(args: string[]): Promise<CommandResult> {
    let all = false, long = false, recursive = false;
    const paths: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') {
        for (const flag of arg.slice(1)) {
          if (flag === 'a') all = true; else if (flag === 'l') long = true; else if (flag === 'R') recursive = true;
          else throw new Error(`ls: unsupported flag -${flag}`);
        }
      } else paths.push(arg);
    }
    if (!paths.length) paths.push('.');
    const chunks: string[] = [];
    const list = async (input: string, heading: boolean): Promise<void> => {
      const directMount = this.mountFor(input);
      if (directMount?.kind === 'file') {
        if (long) chunks.push(`-r--r--r-- ${String(await this.mountSize(directMount)).padStart(8)} ${path.basename(input)}`);
        else chunks.push(input);
        return;
      }
      const abs = await this.readPath(input);
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) { chunks.push(input); return; }
      if (heading) chunks.push(`${input}:`);
      const physical = (await fs.readdir(abs, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink())
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory(), mount: undefined as ResolvedMount | undefined }));
      const physicalNames = new Set(physical.map((entry) => entry.name));
      // Root mounts are virtual children of physical judgment directories.
      // Descendants of directory mounts come directly from their canonical
      // source directory and therefore need no synthetic entries here.
      const mounted = RestrictedBash.inside(this.rootDir, abs)
        ? this.mountsInDirectory(abs)
          .filter((mount) => !physicalNames.has(mount.name))
          .map((mount) => ({ name: mount.name, directory: mount.kind === 'directory', mount }))
        : [];
      const entries = [...physical, ...mounted]
        .filter((entry) => all || !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (long) {
          const size = entry.mount?.kind === 'file'
            ? await this.mountSize(entry.mount)
            : entry.mount?.kind === 'directory'
              ? (await fs.stat(entry.mount.sourceRoot)).size
              : (await fs.stat(path.join(abs, entry.name))).size;
          chunks.push(`${entry.directory ? 'd' : '-'}r--r--r-- ${String(size).padStart(8)} ${entry.name}${entry.directory ? '/' : ''}`);
        } else chunks.push(`${entry.name}${entry.directory ? '/' : ''}`);
      }
      if (recursive) {
        for (const entry of entries.filter((entry) => entry.directory)) {
          chunks.push('');
          await list(path.join(input, entry.name), true);
        }
      }
    };
    for (let i = 0; i < paths.length; i++) { if (i) chunks.push(''); await list(paths[i], paths.length > 1); }
    return ok(withFinalNewline(chunks));
  }

  private async find(args: string[]): Promise<CommandResult> {
    let start = '.';
    let namePattern: string | undefined;
    let type: 'f' | 'd' | undefined;
    let maxDepth = Number.POSITIVE_INFINITY;
    let i = 0;
    if (args[0] && !args[0].startsWith('-')) start = args[i++];
    while (i < args.length) {
      const flag = args[i++];
      const value = args[i++];
      if (value === undefined) throw new Error(`find: ${flag} requires a value`);
      if (flag === '-name') namePattern = value;
      else if (flag === '-type' && (value === 'f' || value === 'd')) type = value;
      else if (flag === '-maxdepth' && /^\d+$/.test(value)) maxDepth = Number(value);
      else throw new Error(`find: unsupported expression ${flag} ${value}`);
    }
    const pattern = namePattern ? new RegExp(`^${namePattern.split('*').map(regexEscape).join('.*')}$`) : undefined;
    const out: string[] = [];
    const directMount = this.mountFor(start);
    if (directMount?.kind === 'file') {
      if ((!type || type === 'f') && (!pattern || pattern.test(path.basename(start)))) out.push(start);
      return ok(withFinalNewline(out));
    }
    const startAbs = await this.readPath(start);
    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      const stat = await fs.stat(abs);
      const kind = stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : undefined;
      if (kind && (!type || type === kind) && (!pattern || pattern.test(path.basename(abs)))) out.push(rel);
      if (kind !== 'd' || depth >= maxDepth) return;
      for (const entry of (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        await walk(path.join(abs, entry.name), path.join(rel, entry.name), depth + 1);
      }
    };
    await walk(startAbs, start, 0);
    // A directory mount reached directly is already walked above. When find
    // starts at one of its physical ancestors, walk each virtual root too.
    if (!directMount) {
      const startVirtualAbs = path.isAbsolute(start) ? path.resolve(start) : path.resolve(this.rootDir, start);
      for (const mount of this.mounts.values()) {
        if (!RestrictedBash.inside(startVirtualAbs, mount.virtualAbs) || mount.virtualAbs === startVirtualAbs) continue;
        const relative = path.relative(startVirtualAbs, mount.virtualAbs);
        const depth = relative.split(path.sep).length;
        const virtualStart = path.join(start, relative);
        if (depth > maxDepth) continue;
        if (mount.kind === 'directory') {
          await this.validateDirectoryMountPath({ ...mount, sourcePath: mount.sourceRoot });
          await walk(mount.sourceRoot, virtualStart, depth);
        } else if ((!type || type === 'f') && (!pattern || pattern.test(path.basename(mount.virtualAbs)))) {
          out.push(virtualStart);
        }
      }
    }
    return ok(withFinalNewline([...new Set(out)].sort()));
  }

  private async grep(args: string[], stdin: string, rgMode: boolean): Promise<CommandResult> {
    const opt = { insensitive: false, invert: false, count: false, numbers: false, files: false, fixed: false, recursive: rgMode, before: 0, after: 0, max: Infinity };
    const positional: string[] = [];
    const valueFlags: Record<string, keyof typeof opt> = { '-A': 'after', '-B': 'before', '-C': 'after', '-m': 'max' };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const combinedValue = arg.match(/^-(A|B|C|m)(\d+)$/);
      if (combinedValue) {
        const key = valueFlags[`-${combinedValue[1]}`];
        (opt as any)[key] = Number(combinedValue[2]);
        if (combinedValue[1] === 'C') opt.before = Number(combinedValue[2]);
        continue;
      }
      if (arg in valueFlags) {
        const value = Number(args[++i]);
        if (!Number.isFinite(value)) throw new Error(`${rgMode ? 'rg' : 'grep'}: ${arg} requires a number`);
        (opt as any)[valueFlags[arg]] = value;
        if (arg === '-C') opt.before = value;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        for (const flag of arg.slice(1)) {
          if (flag === 'i') opt.insensitive = true; else if (flag === 'v') opt.invert = true;
          else if (flag === 'c') opt.count = true; else if (flag === 'n') opt.numbers = true;
          else if (flag === 'l') opt.files = true; else if (flag === 'F') opt.fixed = true;
          else if (flag === 'E') { /* JS regex already extended */ } else if (flag === 'r') opt.recursive = true;
          else throw new Error(`${rgMode ? 'rg' : 'grep'}: unsupported flag -${flag}`);
        }
      } else positional.push(arg);
    }
    const patternText = positional.shift();
    if (patternText === undefined) throw new Error(`${rgMode ? 'rg' : 'grep'}: missing pattern`);
    if (!opt.fixed) validateRegex(patternText);
    const pattern = new RegExp(opt.fixed ? regexEscape(patternText) : patternText, opt.insensitive ? 'i' : '');
    const files = await this.fileInputs(positional, stdin, opt.recursive);
    const multiple = files.filter((f) => f.name).length > 1 || opt.recursive;
    const output: string[] = [];
    let totalMatches = 0;
    for (const file of files) {
      const lines = splitLines(file.text);
      const matched = lines.map((line) => opt.invert ? !pattern.test(line) : pattern.test(line));
      const indexes = matched.map((yes, index) => yes ? index : -1).filter((n) => n >= 0).slice(0, opt.max);
      totalMatches += indexes.length;
      if (opt.files) { if (indexes.length && file.name) output.push(file.name); continue; }
      if (opt.count) { output.push(`${multiple && file.name ? `${file.name}:` : ''}${indexes.length}`); continue; }
      const selected = new Set<number>();
      for (const index of indexes) for (let n = Math.max(0, index - opt.before); n <= Math.min(lines.length - 1, index + opt.after); n++) selected.add(n);
      for (const index of [...selected].sort((a, b) => a - b)) {
        const prefix = `${multiple && file.name ? `${file.name}:` : ''}${opt.numbers ? `${index + 1}:` : ''}`;
        output.push(prefix + lines[index]);
      }
    }
    return { stdout: withFinalNewline(output), stderr: '', exitCode: totalMatches ? 0 : 1 };
  }

  private async headTail(args: string[], stdin: string, tail: boolean): Promise<CommandResult> {
    let mode: 'lines' | 'bytes' = 'lines', count = 10;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n' || args[i] === '-c') { mode = args[i] === '-c' ? 'bytes' : 'lines'; count = Number(args[++i]); }
      else if (/^-\d+$/.test(args[i])) count = Number(args[i].slice(1));
      else files.push(args[i]);
    }
    if (!Number.isFinite(count) || count < 0) throw new Error(`${tail ? 'tail' : 'head'}: invalid count`);
    const inputs = await this.fileInputs(files, stdin);
    const out = inputs.map((f) => {
      if (mode === 'bytes') return tail ? f.text.slice(-count) : f.text.slice(0, count);
      const lines = splitLines(f.text);
      return withFinalNewline(tail ? lines.slice(-count) : lines.slice(0, count));
    }).join('');
    return ok(out);
  }

  private async wc(args: string[], stdin: string): Promise<CommandResult> {
    let lines = false, bytes = false, words = false;
    const files: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') for (const f of arg.slice(1)) {
        if (f === 'l') lines = true; else if (f === 'c') bytes = true; else if (f === 'w') words = true; else throw new Error(`wc: unsupported flag -${f}`);
      } else files.push(arg);
    }
    if (!lines && !bytes && !words) lines = words = bytes = true;
    const inputs = await this.fileInputs(files, stdin);
    const rows = inputs.map((f) => {
      const values = [lines ? splitLines(f.text).length : undefined, words ? (f.text.trim() ? f.text.trim().split(/\s+/).length : 0) : undefined, bytes ? Buffer.byteLength(f.text) : undefined].filter((v) => v !== undefined);
      return `${values.join(' ')}${f.name ? ` ${f.name}` : ''}`;
    });
    return ok(withFinalNewline(rows));
  }

  private async sort(args: string[], stdin: string): Promise<CommandResult> {
    let reverse = false, numeric = false, unique = false, delimiter: string | undefined, key = 1;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-t') delimiter = args[++i];
      else if (arg === '-k') key = Number(String(args[++i]).split(',')[0]);
      else if (arg.startsWith('-') && arg !== '-') for (const f of arg.slice(1)) {
        if (f === 'r') reverse = true; else if (f === 'n') numeric = true; else if (f === 'u') unique = true; else throw new Error(`sort: unsupported flag -${f}`);
      } else files.push(arg);
    }
    const text = (await this.fileInputs(files, stdin)).map((f) => f.text).join('');
    let lines = splitLines(text);
    const field = (line: string) => delimiter ? line.split(delimiter)[key - 1] ?? '' : line.trim().split(/\s+/)[key - 1] ?? '';
    lines.sort((a, b) => numeric ? Number(field(a)) - Number(field(b)) : field(a).localeCompare(field(b)));
    if (reverse) lines.reverse();
    if (unique) lines = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);
    return ok(withFinalNewline(lines));
  }

  private async uniq(args: string[], stdin: string): Promise<CommandResult> {
    let counts = false, duplicates = false;
    const files: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg !== '-') for (const f of arg.slice(1)) {
        if (f === 'c') counts = true; else if (f === 'd') duplicates = true; else throw new Error(`uniq: unsupported flag -${f}`);
      } else files.push(arg);
    }
    const lines = splitLines((await this.fileInputs(files, stdin)).map((f) => f.text).join(''));
    const out: string[] = [];
    for (let i = 0; i < lines.length;) {
      let j = i + 1; while (j < lines.length && lines[j] === lines[i]) j++;
      const count = j - i;
      if (!duplicates || count > 1) out.push(`${counts ? `${String(count).padStart(7)} ` : ''}${lines[i]}`);
      i = j;
    }
    return ok(withFinalNewline(out));
  }

  private async cut(args: string[], stdin: string): Promise<CommandResult> {
    let delimiter = '\t', fields: number[] | undefined, chars: number[] | undefined;
    const files: string[] = [];
    const parseList = (value: string) => value.split(',').flatMap((part) => {
      const [a, b] = part.split('-').map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
    });
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d') delimiter = args[++i]; else if (args[i] === '-f') fields = parseList(args[++i]);
      else if (args[i] === '-c') chars = parseList(args[++i]); else files.push(args[i]);
    }
    if ((!fields && !chars) || (fields && chars)) throw new Error('cut: specify exactly one of -f or -c');
    const lines = splitLines((await this.fileInputs(files, stdin)).map((f) => f.text).join(''));
    const out = lines.map((line) => fields ? fields.map((n) => line.split(delimiter)[n - 1] ?? '').join(delimiter) : chars!.map((n) => line[n - 1] ?? '').join(''));
    return ok(withFinalNewline(out));
  }

  private async tr(args: string[], stdin: string): Promise<CommandResult> {
    let del = false;
    if (args[0] === '-d') { del = true; args = args.slice(1); }
    if ((del && args.length !== 1) || (!del && args.length !== 2)) throw new Error('tr: expected tr [-d] SET1 [SET2]');
    const expand = (set: string): string[] => {
      const source = [...shellUnescapeSet(set)];
      const out: string[] = [];
      for (let i = 0; i < source.length; i++) {
        if (source[i + 1] === '-' && source[i + 2]) { for (let c = source[i].charCodeAt(0); c <= source[i + 2].charCodeAt(0); c++) out.push(String.fromCharCode(c)); i += 2; }
        else out.push(source[i]);
      }
      return out;
    };
    const from = expand(args[0]);
    if (del) return ok([...stdin].filter((c) => !from.includes(c)).join(''));
    const to = expand(args[1]);
    return ok([...stdin].map((c) => { const i = from.indexOf(c); return i < 0 ? c : (to[Math.min(i, to.length - 1)] ?? ''); }).join(''));
  }

  private async sed(args: string[], stdin: string): Promise<CommandResult> {
    if (args.length < 1) throw new Error('sed: missing expression');
    const expression = args.shift()!;
    if (!expression.startsWith('s') || expression.length < 4) throw new Error('sed: only s/pattern/replacement/flags is supported');
    const delim = expression[1];
    const parts: string[] = [];
    let current = '';
    for (let i = 2; i < expression.length; i++) {
      if (expression[i] === '\\' && expression[i + 1] === delim) { current += delim; i++; }
      else if (expression[i] === delim) { parts.push(current); current = ''; }
      else current += expression[i];
    }
    parts.push(current);
    if (parts.length !== 3 || /[^gi]/.test(parts[2])) throw new Error('sed: only s/pattern/replacement/[gi] is supported');
    validateRegex(parts[0]);
    const regex = new RegExp(parts[0], `${parts[2].includes('g') ? 'g' : ''}${parts[2].includes('i') ? 'i' : ''}`);
    const files = await this.fileInputs(args, stdin);
    return ok(files.map((f) => f.text.replace(regex, parts[1])).join(''));
  }

  private async jq(args: string[], stdin: string): Promise<CommandResult> {
    const flags: string[] = [];
    const positional: string[] = [];
    for (const arg of args) { if (arg.startsWith('-') && positional.length === 0) flags.push(arg); else positional.push(arg); }
    const query = positional.shift();
    if (!query) throw new Error('jq: missing filter');
    const input = positional.length ? (await this.fileInputs(positional, stdin)).map((f) => f.text).join('\n') : stdin;

    // jq is real WebAssembly and a pathological filter can run without
    // yielding to Node's event loop. Execute it in a worker THREAD (never a
    // child process) so the deadline is enforceable and the computation can
    // actually be terminated instead of merely racing a blocked promise.
    return await new Promise<CommandResult>((resolve) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        // jq-wasm expects Web Crypto. Node 18 exposes it from node:crypto but
        // does not install it on globalThis as later Node releases do.
        if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;
        (async () => {
          try {
            const { raw } = await import('jq-wasm/inline');
            parentPort.postMessage({ ok: true, result: await raw(workerData.input, workerData.query, workerData.flags) });
          } catch (error) {
            parentPort.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
          }
        })();
      `, { eval: true, workerData: { input, query, flags } });
      let settled = false;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish(fail(`restricted bash: command timed out after ${this.timeoutMs}ms`, 2)),
        this.timeoutMs
      );
      worker.on('message', (message: any) => {
        if (!message?.ok) finish(fail(`jq: ${message?.error ?? 'worker failed'}`, 2));
        else finish({
          stdout: String(message.result?.stdout ?? ''),
          stderr: String(message.result?.stderr ?? ''),
          exitCode: Number(message.result?.exitCode ?? 2),
        });
      });
      worker.on('error', (error) => finish(fail(`jq: ${error.message}`, 2)));
      worker.on('exit', (code) => {
        if (!settled && code !== 0) finish(fail(`jq: worker exited ${code}`, 2));
      });
    });
  }
}
