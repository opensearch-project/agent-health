/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** In-process restricted bash tool over one judgment's evidence directory. */

import { Type } from 'typebox';
import type { PiExtensionAPI, PiExtensionFactory } from './piSdkTypes';
import { RestrictedBash, type RestrictedBashMount } from './restrictedBash';

export interface EvidenceBashToolOptions {
  mounts?: readonly RestrictedBashMount[];
  onCommand?: (command: string) => void;
  timeoutMs?: number;
  outputCapBytes?: number;
  quotaBytes?: number;
  quotaFiles?: number;
}

export function createEvidenceJudgeExtension(
  rootDir: string,
  options: EvidenceBashToolOptions = {}
): PiExtensionFactory {
  return (pi: PiExtensionAPI) => {
    let bash: Promise<RestrictedBash> | undefined;
    pi.registerTool({
      name: 'bash',
      label: 'Inspect complete judgment evidence (restricted)',
      description:
        'Run a restricted, in-process evidence query. No OS commands or child processes are used. ' +
        'Read files under evidence/, combine supported commands with pipes/&&/||/;, and write only ' +
        'under scratch/. The working directory is the judgment root.',
      promptSnippet: 'Query complete evidence files with restricted bash',
      promptGuidelines: [
        'Inspect evidence/testcase.json and evidence/trajectory.json before deciding',
        'Use jq, grep/rg, sort, uniq, head, tail, wc, find, cat, ls, cut, tr, or sed',
        'Treat evidence/ as immutable; scratch/ is the only writable directory',
        'Narrow large output with jq, grep, or head',
      ],
      parameters: Type.Object({
        command: Type.String({ description: 'Restricted command/pipeline to run from the judgment root' }),
      }),
      async execute(_toolCallId: string, params: { command?: string }) {
        if (!params.command || !params.command.trim()) {
          const message = 'restricted bash: command must be a non-empty string';
          return { content: [{ type: 'text' as const, text: `${message}\n[exit 2]` }], details: { exitCode: 2 } };
        }
        bash ??= RestrictedBash.create({ rootDir, ...options });
        const result = await (await bash).execute(params.command);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          details: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
        };
      },
    });
  };
}
