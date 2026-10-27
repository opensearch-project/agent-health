/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI commands that work on the user's project directory / shell / config
 * rather than on benchmark data — `init`, `remote`, `setup`, `setup-telemetry`,
 * `doctor`, `import`, `workflow run` — driven as REAL CLI processes.
 *
 * Every command runs in a throwaway cwd with a throwaway `HOME`, so nothing
 * touches the developer's real `.claude/`, shell rc or AWS config. Where a
 * command probes the outside world (AWS credentials, the Claude CLI, the
 * AWS CLI, an OTLP endpoint) the test pins the environment so the outcome
 * is deterministic in CI and locally:
 *   • AWS: no `AWS_*` → "No AWS credentials detected"; a profile that cannot
 *     exist (empty config files) → "AWS credentials invalid"; a static
 *     `AWS_ACCESS_KEY_ID` + secret → validated from env without any network.
 *   • Tools on PATH: a PATH with only Node makes `claude` / `aws` "not found".
 *   • OTLP endpoint: the local agent-health server itself (it accepts
 *     `POST /v1/traces`).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getTestBackendUrl } from '../testConfig';
import {
  ensureCliBundle,
  backendAvailable,
  backendPort,
  runCli,
  plain,
  makeTempDir,
  REPO_ROOT,
  jsonTail,
  type RunCliOptions,
} from '../../helpers/cliProcess';

const TEST_TIMEOUT = 120_000;
const BASE_URL = getTestBackendUrl();
const NODE_ONLY_PATH = dirname(process.execPath);

/**
 * No AWS_* from the parent; a fake HOME; the given cwd. IMDS is disabled so
 * the AWS credential chain cannot pick up an instance role on a dev box or a
 * cloud CI runner — "no credentials" has to mean no credentials everywhere.
 */
function isolated(cwd: string, home: string, env: Record<string, string | undefined> = {}): RunCliOptions {
  return { cwd, keepAws: false, env: { HOME: home, SHELL: '/bin/bash', AWS_EC2_METADATA_DISABLED: 'true', ...env } };
}

describe('CLI project/shell commands (real CLI processes, isolated HOME + cwd)', () => {
  let tmp: string;
  let home: string;
  let serverUp = false;

  beforeAll(async () => {
    ensureCliBundle();
    tmp = makeTempDir('ah-cli-local');
    home = join(tmp, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.bashrc'), '# test rc\n');
    serverUp = await backendAvailable(BASE_URL);
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates the config + .env.example (+ sample case with --with-examples), skips existing files, overwrites with --force', () => {
      const proj = join(tmp, 'init-proj');
      mkdirSync(proj);
      const first = runCli(['init', '--with-examples'], isolated(proj, home));
      const out1 = plain(first.output);
      expect(first.status).toBe(0);
      expect(out1).toMatch(/✓ Created: agent-health\.config\.ts/);
      expect(out1).toMatch(/✓ Created: \.env\.example/);
      expect(out1).toMatch(/✓ Created: test-cases\/sample-rca\.yaml/);
      expect(out1).toMatch(/Next steps:/);
      expect(existsSync(join(proj, 'agent-health.config.ts'))).toBe(true);
      expect(existsSync(join(proj, 'test-cases', 'sample-rca.yaml'))).toBe(true);
      const configText = readFileSync(join(proj, 'agent-health.config.ts'), 'utf-8');
      expect(configText).toMatch(/agents/);

      writeFileSync(join(proj, '.env.example'), 'EDITED=1\n');
      const second = runCli(['init'], isolated(proj, home));
      const out2 = plain(second.output);
      expect(second.status).toBe(0);
      expect(out2).toMatch(/⚠ Skipped: agent-health\.config\.ts \(already exists, use --force to overwrite\)/);
      expect(out2).toMatch(/⚠ Skipped: \.env\.example/);
      expect(out2).toMatch(/2 file\(s\) skipped/);
      expect(readFileSync(join(proj, '.env.example'), 'utf-8')).toBe('EDITED=1\n');

      const forced = runCli(['init', '--force'], isolated(proj, home));
      expect(forced.status).toBe(0);
      expect(plain(forced.output)).toMatch(/✓ Created: \.env\.example/);
      expect(readFileSync(join(proj, '.env.example'), 'utf-8')).not.toBe('EDITED=1\n');
    }, TEST_TIMEOUT);
  });

  describe('remote', () => {
    it('add / list / test / remove round-trip through agent-health.config.json, with duplicate and missing-name errors', () => {
      const proj = join(tmp, 'remote-proj');
      mkdirSync(proj);
      const opts = isolated(proj, home);

      const empty = runCli(['remote', 'list'], opts);
      expect(empty.status).toBe(0);
      expect(plain(empty.output)).toMatch(/No remote servers configured/i);

      const add1 = runCli(['remote', 'add', '--name', 'alpha', '--url', BASE_URL], opts);
      expect(add1.status).toBe(0);
      expect(plain(add1.output)).toContain(`Added remote server: alpha (${BASE_URL})`);
      const cfg = JSON.parse(readFileSync(join(proj, 'agent-health.config.json'), 'utf-8')) as { remoteServers: Array<{ name: string; url: string; apiKey?: string }> };
      expect(cfg.remoteServers).toEqual([{ name: 'alpha', url: BASE_URL }]);

      const dup = runCli(['remote', 'add', '--name', 'alpha', '--url', BASE_URL], opts);
      expect(dup.status).toBe(1);
      expect(plain(dup.output)).toMatch(/Server "alpha" already exists/);

      const add2 = runCli(['remote', 'add', '--name', 'beta', '--url', 'http://127.0.0.1:9', '--api-key', 'test-key'], opts);
      expect(add2.status).toBe(0);

      const list = runCli(['remote', 'list'], opts);
      const listOut = plain(list.output);
      expect(list.status).toBe(0);
      expect(listOut).toMatch(/Remote Servers \(2\)/);
      expect(listOut).toMatch(/alpha\s+\S+ \[no auth\]/);
      expect(listOut).toMatch(/beta\s+http:\/\/127\.0\.0\.1:9 \[auth\]/);

      const test = runCli(['remote', 'test'], opts);
      const testOut = plain(test.output);
      expect(test.status).toBe(0);
      expect(testOut).toMatch(/Testing 2 remote server\(s\)/);
      if (serverUp) expect(testOut).toMatch(/✓ alpha — OK \(\d+ agents detected\)/);
      else expect(testOut).toMatch(/✗ alpha/);
      expect(testOut).toMatch(/✗ beta — /);

      const rm = runCli(['remote', 'remove', 'beta'], opts);
      expect(rm.status).toBe(0);
      expect(plain(rm.output)).toMatch(/Removed remote server: beta/);
      const rmMissing = runCli(['remote', 'remove', 'gamma'], opts);
      expect(rmMissing.status).toBe(1);
      expect(plain(rmMissing.output)).toMatch(/Server "gamma" not found/);
      const after = JSON.parse(readFileSync(join(proj, 'agent-health.config.json'), 'utf-8')) as { remoteServers: Array<{ name: string }> };
      expect(after.remoteServers.map(s => s.name)).toEqual(['alpha']);
    }, TEST_TIMEOUT);
  });

  describe('setup', () => {
    it('installs the session hook, slash command and bundled skills into ./.claude; re-runs are idempotent; --force rewrites', () => {
      const proj = join(tmp, 'setup-proj');
      mkdirSync(proj);
      const opts = isolated(proj, home);

      const first = runCli(['setup'], opts);
      const out1 = plain(first.output);
      expect(first.status).toBe(0);
      expect(out1).toMatch(/No \.claude directory found — creating Claude Code layout/);
      expect(out1).toMatch(/✓ Installed PreToolUse session hook → \.claude\/settings\.json/);
      expect(out1).toMatch(/✓ Installed slash command → \/agent-health:profile/);
      expect(out1).toMatch(/Skills:/);
      expect(out1).toMatch(/✓ agent-health-profile/);
      expect(out1).toMatch(/✓ instrument-otel/);

      const settings = JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8')) as { hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> } };
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(/current-session/);
      expect(existsSync(join(proj, '.claude', 'commands', 'agent-health', 'profile.md'))).toBe(true);
      const skill = readFileSync(join(proj, '.claude', 'skills', 'agent-health-profile', 'SKILL.md'), 'utf-8');
      expect(skill).not.toContain('__AH_CLI__');

      const second = runCli(['setup'], opts);
      const out2 = plain(second.output);
      expect(second.status).toBe(0);
      expect(out2).toMatch(/• Session hook already present/);
      expect(out2).toMatch(/• Slash command already present \(use --force to overwrite\)/);
      expect(out2).toMatch(/• agent-health-profile \(already present, use --force to overwrite\)/);
      const settings2 = JSON.parse(readFileSync(join(proj, '.claude', 'settings.json'), 'utf-8')) as { hooks: { PreToolUse: unknown[] } };
      expect(settings2.hooks.PreToolUse).toHaveLength(1);

      const forced = runCli(['setup', '--force'], opts);
      expect(forced.status).toBe(0);
      expect(plain(forced.output)).toMatch(/✓ Installed slash command/);
    }, TEST_TIMEOUT);
  });

  describe('setup-telemetry', () => {
    const endpoint = () => `http://localhost:${backendPort()}`;

    it('--status reports every unset variable, the shell rc state, and the endpoint probe when one is configured', () => {
      const proj = join(tmp, 'tel-status');
      mkdirSync(proj);
      const bare = runCli(['setup-telemetry', '--status'], isolated(proj, home, { PATH: NODE_ONLY_PATH }));
      const out = plain(bare.output);
      expect(bare.status).toBe(0);
      expect(out).toMatch(/Current Telemetry Status/);
      expect(out).toMatch(/⚠ Telemetry enabled: not set \(CLAUDE_CODE_ENABLE_TELEMETRY\)/);
      expect(out).toMatch(/⚠ OTLP endpoint: not set \(OTEL_EXPORTER_OTLP_ENDPOINT\)/);
      expect(out).toMatch(/⚠ Claude Code CLI not found/);
      expect(out).toMatch(new RegExp(`⚠ No telemetry block in ${home}/.bashrc`));
      expect(out).toMatch(/Some checks failed\. Run `agent-health setup-telemetry` to fix\./);

      if (!serverUp) return;
      const full = runCli(['setup-telemetry', '--status'], isolated(proj, home, {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_SERVICE_NAME: 'something-else',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint(),
      }));
      const fullOut = plain(full.output);
      expect(full.status).toBe(0);
      expect(fullOut).toMatch(/✓ Telemetry enabled: 1/);
      expect(fullOut).toMatch(/⚠ Service name: something-else \(expected claude-code-agent\)/);
      expect(fullOut).toMatch(/✓ Traces exporter: otlp/);
      expect(fullOut).toMatch(/Testing endpoint/);
      expect(fullOut).toMatch(/✓ Endpoint reachable \(HTTP \d+\)/);
    }, TEST_TIMEOUT);

    it('--endpoint … --dry-run prints the cc-otel block for the detected shell without writing; --skip-rc prints it to copy', () => {
      const proj = join(tmp, 'tel-dry');
      mkdirSync(proj);
      const zsh = runCli(['setup-telemetry', '--endpoint', endpoint(), '--dry-run'], isolated(proj, home, { SHELL: '/usr/bin/zsh' }));
      const out = plain(zsh.output);
      expect(zsh.status).toBe(0);
      expect(out).toContain(`✓ Using provided endpoint: ${endpoint()}`);
      expect(out).toMatch(/Testing OTLP endpoint connectivity/);
      expect(out).toMatch(new RegExp(`Detected shell: zsh → ${home}/.zshrc`));
      expect(out).toMatch(/Dry run — would append to/);
      expect(out).toMatch(/alias cc-otel=/);
      expect(out).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint()}`);
      expect(out).toMatch(/No changes made\./);
      expect(existsSync(join(home, '.zshrc'))).toBe(false);

      const fish = runCli(['setup-telemetry', '--endpoint', endpoint(), '--skip-rc'], isolated(proj, home, { SHELL: '/usr/bin/fish' }));
      const fishOut = plain(fish.output);
      expect(fish.status).toBe(0);
      expect(fishOut).toMatch(/Detected shell: fish → .*config\.fish/);
      expect(fishOut).toMatch(/Add these to your shell profile:/);
      expect(fishOut).toMatch(/alias cc-otel=/);
      expect(existsSync(join(home, '.config', 'fish', 'config.fish'))).toBe(false);
    }, TEST_TIMEOUT);

    it('writes the block to ~/.bashrc once, refuses to duplicate it, and --force replaces it', () => {
      const proj = join(tmp, 'tel-write');
      mkdirSync(proj);
      const rc = join(home, '.bashrc');
      const opts = isolated(proj, home);

      const write = runCli(['setup-telemetry', '--endpoint', endpoint()], opts);
      const out = plain(write.output);
      expect(write.status).toBe(0);
      expect(out).toContain(`✓ Telemetry env vars written to ${rc}`);
      expect(out).toMatch(/Next steps:/);
      expect(out).toContain(`source ${rc}`);
      const once = readFileSync(rc, 'utf-8');
      expect(once.match(/alias cc-otel=/g)).toHaveLength(1);
      expect(once).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint()}`);
      expect(once.startsWith('# test rc\n')).toBe(true);

      const again = runCli(['setup-telemetry', '--endpoint', endpoint()], opts);
      expect(again.status).toBe(0);
      expect(plain(again.output)).toContain(`⚠ Telemetry block already exists in ${rc}`);
      expect(plain(again.output)).toMatch(/Use --force to replace it/);
      expect(readFileSync(rc, 'utf-8')).toBe(once);

      const forced = runCli(['setup-telemetry', '--endpoint', 'http://127.0.0.1:9/replaced', '--force'], opts);
      expect(forced.status).toBe(0);
      expect(plain(forced.output)).toContain(`✓ Telemetry env vars updated in ${rc}`);
      const replaced = readFileSync(rc, 'utf-8');
      expect(replaced.match(/alias cc-otel=/g)).toHaveLength(1);
      expect(replaced).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9/replaced');
      expect(replaced).not.toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint()}`);
      // The unreachable endpoint is reported as a warning, not a failure.
      expect(plain(forced.output)).toMatch(/⚠ Connection failed|⚠ Endpoint/);

      const status = runCli(['setup-telemetry', '--status'], opts);
      expect(plain(status.output)).toContain(`✓ Telemetry block in ${rc}`);
    }, TEST_TIMEOUT);

    it('without --endpoint it needs the AWS CLI (exit 1 when missing); with it but no usable profile the stack lookup fails clearly', () => {
      const proj = join(tmp, 'tel-aws');
      mkdirSync(proj);
      const noAws = runCli(['setup-telemetry', '--dry-run'], isolated(proj, home, { PATH: NODE_ONLY_PATH }));
      expect(noAws.status).toBe(1);
      expect(plain(noAws.output)).toMatch(/✗ AWS CLI not found\. Install it or use --endpoint <url> to skip stack lookup\./);

      const noAwsDeploy = runCli(['setup-telemetry', '--deploy', '--dry-run'], isolated(proj, home, { PATH: NODE_ONLY_PATH }));
      expect(noAwsDeploy.status).toBe(1);
      expect(plain(noAwsDeploy.output)).toMatch(/✗ AWS CLI not found/);

      // Only meaningful where an `aws` binary exists (dev machines, GitHub runners).
      const hasAws = runCli(['setup-telemetry', '--status'], isolated(proj, home)).status === 0 && !!process.env.PATH && (() => {
        try { return require('child_process').spawnSync('aws', ['--version'], { encoding: 'utf-8' }).status === 0; } catch { return false; }
      })();
      if (!hasAws) return;
      const noProfile = runCli(['setup-telemetry', '--dry-run', '--stack', 'NoSuchStackForTests', '--profile', 'no-such-profile-for-tests'], isolated(proj, home, {
        AWS_CONFIG_FILE: join(tmp, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: join(tmp, 'no-aws-creds'),
      }));
      expect(noProfile.status).toBe(1);
      expect(plain(noProfile.output)).toMatch(/Reading stack outputs from NoSuchStackForTests/);
      expect(plain(noProfile.output)).toMatch(/✗ /);
    }, TEST_TIMEOUT);

    it('rejects an endpoint with shell metacharacters (exit 1)', () => {
      const proj = join(tmp, 'tel-bad');
      mkdirSync(proj);
      const res = runCli(['setup-telemetry', '--endpoint', 'http://evil;rm -rf /', '--dry-run'], isolated(proj, home));
      expect(res.status).toBe(1);
      expect(plain(res.output)).toMatch(/Invalid endpoint: contains disallowed characters/);
      expect(readFileSync(join(home, '.bashrc'), 'utf-8')).not.toContain('evil');
    }, TEST_TIMEOUT);
  });

  describe('doctor', () => {
    type Check = { name: string; status: string; message: string; details?: string[] };
    const byName = (checks: Check[]) => Object.fromEntries(checks.map(c => [c.name, c]));

    it('with no AWS env and no config: warns about credentials and storage, lists agents/connectors, probes the server', () => {
      const proj = join(tmp, 'doctor-bare');
      mkdirSync(proj);
      const text = runCli(['doctor'], isolated(proj, home));
      const out = plain(text.output);
      expect(text.status).toBe(0);
      expect(out).toMatch(/Configuration Check/);
      expect(out).toMatch(/✓ Config File: Using defaults \+ environment variables/);
      expect(out).toMatch(/✓ Environment File: Not using \.env file/);
      expect(out).toMatch(/⚠ AWS Credentials: No AWS credentials detected/);
      expect(out).toMatch(/✓ Agents: \d+ agents configured/);
      expect(out).toMatch(/✓ Demo Agent \(mock\)/);
      expect(out).toMatch(/✓ Connectors: \d+ connectors registered/);
      expect(out).toMatch(/⚠ OpenSearch Storage: Not configured/);
      expect(out).toMatch(/\d+ warning\(s\)\. Some features may be limited\./);
      if (serverUp) expect(out).toMatch(/Traces Connectivity: (Local filesystem trace storage|OpenSearch traces index is accessible|Sample data only)/);

      writeFileSync(join(proj, '.env'), 'EXAMPLE=1\n');
      const json = runCli(['doctor', '-o', 'json'], isolated(proj, home));
      expect(json.status).toBe(0);
      const checks = byName(JSON.parse(json.stdout) as Check[]);
      expect(checks['Environment File']).toMatchObject({ status: 'ok', message: 'Found: .env' });
      expect(checks['AWS Credentials'].status).toBe('warning');
      expect(checks['Connectors'].details).toEqual(expect.arrayContaining(['✓ mock']));
    }, TEST_TIMEOUT);

    it('a profile that cannot be resolved is an error with the debugging hints; static keys validate without network', () => {
      const proj = join(tmp, 'doctor-aws');
      mkdirSync(proj);
      const bad = runCli(['doctor', '-o', 'json'], isolated(proj, home, {
        AWS_PROFILE: 'no-such-profile-for-tests',
        AWS_CONFIG_FILE: join(tmp, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: join(tmp, 'no-aws-creds'),
        AWS_REGION: 'us-east-1',
      }));
      expect(bad.status).toBe(0);
      const badChecks = byName(JSON.parse(bad.stdout) as Check[]);
      expect(badChecks['AWS Credentials'].status).toBe('error');
      expect(badChecks['AWS Credentials'].message).toMatch(/AWS credentials invalid/);
      expect(badChecks['AWS Credentials'].details).toEqual(expect.arrayContaining([
        'AWS_PROFILE: no-such-profile-for-tests',
        'AWS_REGION: us-east-1',
        'Run: aws sts get-caller-identity to debug',
        'Run: aws sso login --profile no-such-profile-for-tests',
      ]));
      const badText = runCli(['doctor'], isolated(proj, home, {
        AWS_PROFILE: 'no-such-profile-for-tests',
        AWS_CONFIG_FILE: join(tmp, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: join(tmp, 'no-aws-creds'),
      }));
      expect(plain(badText.output)).toMatch(/✗ AWS Credentials: AWS credentials invalid/);
      expect(plain(badText.output)).toMatch(/\d+ error\(s\)/);

      const ok = runCli(['doctor', '-o', 'json'], isolated(proj, home, {
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEFORTESTS0',
        AWS_SECRET_ACCESS_KEY: 'not-a-real-secret-for-tests',
        AWS_CONFIG_FILE: join(tmp, 'no-aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: join(tmp, 'no-aws-creds'),
        OPENSEARCH_STORAGE_ENDPOINT: 'http://localhost:9200',
        OPENSEARCH_STORAGE_USERNAME: 'admin',
        OPENSEARCH_LOGS_ENDPOINT: 'http://localhost:9200',
        AH_PORT: '1',
      }));
      expect(ok.status).toBe(0);
      const okChecks = byName(JSON.parse(ok.stdout) as Check[]);
      expect(okChecks['AWS Credentials']).toMatchObject({ status: 'ok', message: 'Using access key (validated)' });
      expect(okChecks['AWS Credentials'].details).toEqual(expect.arrayContaining(['AWS_ACCESS_KEY_ID: AKIAEXAM...']));
      expect(okChecks['OpenSearch Storage']).toMatchObject({ status: 'ok', details: ['Username: admin'] });
      expect(okChecks['OpenSearch Observability'].status).toBe('ok');
      // AH_PORT=1: nothing listens there → the probe is skipped, not failed.
      expect(okChecks['Traces Connectivity']).toMatchObject({ status: 'ok', message: 'Server not running (skipped)' });
    }, TEST_TIMEOUT);

    it('a Claude CLI missing from PATH is a warning, present is ok', () => {
      const proj = join(tmp, 'doctor-path');
      mkdirSync(proj);
      const res = runCli(['doctor', '-o', 'json'], isolated(proj, home, { PATH: NODE_ONLY_PATH }));
      expect(res.status).toBe(0);
      const checks = byName(JSON.parse(res.stdout) as Check[]);
      expect(checks['Claude Code CLI'].status).toBe('warning');
      expect(checks['Claude Code CLI'].message).toMatch(/not found|not installed/i);
    }, TEST_TIMEOUT);
  });

  describe('import --from holmesgpt --source <dir>', () => {
    function writeFixtures(root: string): void {
      const w = (rel: string, body: string) => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body, 'utf-8');
      };
      w('test_ask/01_crashing_pods/test_case.yaml', [
        'user_prompt: "How many pods are failing and why?"',
        'expected_output:',
        '  - "Two pods are in CrashLoopBackOff"',
        'tags: [kubernetes, easy]',
        'before_test: kubectl apply -f manifest.yaml',
        'after_test: kubectl delete -f manifest.yaml',
        'toolsets:',
        '  kubernetes/core: { enabled: true }',
        'cluster_name: demo-cluster',
        'mocked_date: "2025-01-01T00:00:00Z"',
        '',
      ].join('\n'));
      w('test_ask/02_skipped/test_case.yaml', 'user_prompt: skipped\nexpected_output: n/a\nskip: true\nskip_reason: flaky upstream\n');
      w('test_investigate/03_health_checks/test_case.yaml', [
        'description: "Health check scenario"',
        'checks:',
        '  - query: "is the api healthy"',
        '  - description: "latency below 200ms"',
        'expected_results:',
        '  api_healthy: "true"',
        'expected_output: "All checks pass"',
        'tags: [hard, prometheus]',
        'conversation_history:',
        '  - role: user',
        '    content: hello',
        '',
      ].join('\n'));
    }

    it('--dry-run converts, reports skipped cases and prints a sample without writing', () => {
      const root = join(tmp, 'holmes-dry');
      writeFixtures(root);
      const res = runCli(['import', '--from', 'holmesgpt', '--source', root, '--dry-run'], isolated(tmp, home));
      const out = plain(res.output);
      expect(res.status).toBe(0);
      expect(out).toMatch(/Found 2 test case\(s\)/);
      expect(out).toMatch(/Converted: 2/);
      expect(out).toMatch(/Skipped:\s+1/);
      expect(out).toMatch(/Dry run — no files written/);
      expect(out).toMatch(/Sample test case:/);
      expect(out).toContain('"name": "holmesgpt/test_ask/01_crashing_pods"');
      expect(out).toContain('"Setup Script (before_test)"');
      expect(existsSync(join(tmp, 'holmesgpt-test-cases.json'))).toBe(false);
    }, TEST_TIMEOUT);

    it('writes an import-compatible JSON file (positional source, -o), and a malformed fixture makes it exit 1 after writing the rest', () => {
      const root = join(tmp, 'holmes-write');
      writeFixtures(root);
      const outFile = join(tmp, 'holmes-out.json');
      const ok = runCli(['import', '--from', 'holmesgpt', root, '-o', outFile], isolated(tmp, home));
      expect(ok.status).toBe(0);
      expect(plain(ok.output)).toContain(`Output: ${outFile}`);
      expect(plain(ok.output)).toMatch(/Next step: run a benchmark with these test cases/);
      const cases = JSON.parse(readFileSync(outFile, 'utf-8')) as Array<{ name: string; difficulty: string; category: string; initialPrompt: string; expectedOutcomes: string[]; context: unknown[] }>;
      expect(cases.map(c => c.name)).toEqual(['holmesgpt/test_ask/01_crashing_pods', 'holmesgpt/test_investigate/03_health_checks']);
      expect(cases[0].difficulty).toBe('Easy');
      expect(cases[0].context.length).toBeGreaterThanOrEqual(4);
      expect(cases[1].difficulty).toBe('Hard');
      expect(cases[1].initialPrompt).toMatch(/Run health checks: is the api healthy; latency below 200ms/);
      expect(cases[1].expectedOutcomes).toEqual(['All checks pass', "Check 'api_healthy' should result in: true"]);

      mkdirSync(join(root, 'test_ask', '04_broken'), { recursive: true });
      writeFileSync(join(root, 'test_ask', '04_broken', 'test_case.yaml'), 'user_prompt: [unclosed\n  - x\n', 'utf-8');
      const broken = runCli(['import', '--from', 'holmesgpt', '--source', root, '-o', join(tmp, 'holmes-out2.json')], isolated(tmp, home));
      expect(broken.status).toBe(1);
      expect(plain(broken.output)).toMatch(/Errors:\s+1/);
      expect(plain(broken.output)).toMatch(/04_broken\/test_case\.yaml/);
      expect(existsSync(join(tmp, 'holmes-out2.json'))).toBe(true);
    }, TEST_TIMEOUT);

    it('an unsupported --from format exits 1 and lists the supported ones', () => {
      const res = runCli(['import', '--from', 'unknown-format'], isolated(tmp, home));
      expect(res.status).toBe(1);
      expect(plain(res.output)).toMatch(/Unsupported format 'unknown-format'/);
      expect(plain(res.output)).toMatch(/Supported formats: holmesgpt/);
    }, TEST_TIMEOUT);
  });

  describe('workflow run', () => {
    const LIB = join(REPO_ROOT, 'lib', 'dist', 'lib', 'workflow', 'index.js');

    function writeWorkflow(dir: string): string {
      // A real workflow (lib/workflow) over a 3-item in-memory queue, run
      // against the built-in `demo` (mock) agent — no network, no credentials.
      const file = join(dir, 'queue.workflow.mjs');
      writeFileSync(file, `import { source, workflow } from ${JSON.stringify(LIB)};
const queue = source('tickets', async () => [
  { id: 'T-1', prompt: 'investigate elevated 5xx on the checkout API', meta: { cti: 'checkout-5xx' } },
  { id: 'T-2', prompt: 'investigate JVM heap pressure on the search tier', meta: { cti: 'search-heap' } },
  { id: 'T-3', prompt: 'another burst of 5xx on the checkout API', meta: { cti: 'checkout-5xx' } },
]);
export default workflow('queue-triage', { agent: 'demo', concurrency: 2 })
  .step('triage', async (ctx) => {
    await ctx.forEach(queue, {}, async (t) => {
      const run = await ctx.runAgent(t, { feedback: ctx.ledger(), writes: 'shadow' });
      ctx.stage({ item: t, run, signature: String(t.meta?.cti ?? run.signature) });
    });
  })
  .step('consolidate', async (ctx) => {
    for (const c of await ctx.consolidate(ctx.staged())) {
      await ctx.raisePR(c.fix, { title: 'fix: ' + c.label });
    }
  });
`, 'utf-8');
      return file;
    }

    it('runs a real workflow over the demo agent: table output, json output, --limit', () => {
      if (!existsSync(LIB)) {
        // eslint-disable-next-line no-console
        console.warn('[cli-workflow] lib/dist missing (run npm run build:lib) — skipping');
        return;
      }
      const dir = join(tmp, 'wf');
      mkdirSync(dir);
      const file = writeWorkflow(dir);
      const opts = isolated(dir, home);

      const table = runCli(['workflow', 'run', '-f', file, '--since', '24h'], opts);
      const out = plain(table.output);
      expect(table.status).toBe(0);
      expect(out).toMatch(/Workflow: queue-triage\s+\(agent: demo\)/);
      expect(out).toMatch(/mode=new since=24h concurrency=2 limit=- dryRun=true/);
      expect(out).toMatch(/Processed: 3 item\(s\)/);
      expect(out).toMatch(/Clusters: 2\s+·\s+PRs \(dry-run\) raised: 2/);
      expect(out).toMatch(/Consolidated fix-classes:/);
      expect(out).toMatch(/— 2 ticket\(s\)/);

      const json = runCli(['workflow', 'run', '-f', file, '-o', 'json', '--limit', '1', '-c', '1'], opts);
      expect(json.status).toBe(0);
      const result = jsonTail(json.stdout) as { staged: unknown[]; clusters: unknown[]; prsRaised: number; peakConcurrency: number };
      expect(result.staged).toHaveLength(1);
      expect(result.clusters).toHaveLength(1);
      expect(result.prsRaised).toBe(1);
      expect(result.peakConcurrency).toBe(1);
    }, TEST_TIMEOUT);

    it('missing file, a module without a workflow, and a bad --limit all exit 1 with a specific message (text and json)', () => {
      const dir = join(tmp, 'wf-errors');
      mkdirSync(dir);
      const opts = isolated(dir, home);

      const missing = runCli(['workflow', 'run', '-f', join(dir, 'nope.workflow.mjs')], opts);
      expect(missing.status).toBe(1);
      expect(plain(missing.output)).toMatch(/Workflow file not found: .*nope\.workflow\.mjs/);
      const missingJson = runCli(['workflow', 'run', '-f', join(dir, 'nope.workflow.mjs'), '-o', 'json'], opts);
      expect(missingJson.status).toBe(1);
      expect(JSON.parse(missingJson.stdout)).toMatchObject({ error: expect.stringMatching(/Workflow file not found/) });

      const notAWorkflow = join(dir, 'plain.workflow.mjs');
      writeFileSync(notAWorkflow, 'export default { name: "x" };\n', 'utf-8');
      const bad = runCli(['workflow', 'run', '-f', notAWorkflow], opts);
      expect(bad.status).toBe(1);
      expect(plain(bad.output)).toMatch(/No workflow found in .*plain\.workflow\.mjs/);
      expect(plain(bad.output)).toMatch(/For \.ts files run via tsx/);
      const badJson = runCli(['workflow', 'run', '-f', notAWorkflow, '-o', 'json'], opts);
      expect(JSON.parse(badJson.stdout)).toMatchObject({ error: expect.stringMatching(/No workflow found/) });

      if (!existsSync(LIB)) return;
      const real = writeWorkflow(dir);
      const badLimit = runCli(['workflow', 'run', '-f', real, '--limit', 'zero'], opts);
      expect(badLimit.status).toBe(1);
      expect(plain(badLimit.output)).toMatch(/--limit must be a positive integer \(got "zero"\)/);
      const badConcurrency = runCli(['workflow', 'run', '-f', real, '-c', '0'], opts);
      expect(badConcurrency.status).toBe(1);
      expect(plain(badConcurrency.output)).toMatch(/--concurrency must be a positive integer \(got "0"\)/);
    }, TEST_TIMEOUT);
  });
});
