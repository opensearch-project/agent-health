/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Codex CLI reader — parses ~/.codex/sessions/ JSONL rollout files.
 * Token counts are not persisted to rollout files, so cost estimation
 * is unavailable. Tool errors use content-based heuristics.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { CodingAgentReader, AgentSession, AgentStats, DailyActivity, SessionDetail, SessionMessage } from '../types';

const CODEX_DIR = path.join(os.homedir(), '.codex');

function codexPath(...segments: string[]): string {
  return path.join(CODEX_DIR, ...segments);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const ERROR_PATTERN = /\b(error|exception|traceback|ENOENT|EACCES|permission denied|command failed|no such file)\b/i;

async function findRolloutFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await findRolloutFiles(fullPath));
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch { /* skip */ }
  return results;
}

async function deriveSessionFromRollout(filePath: string): Promise<AgentSession | null> {
  const filename = path.basename(filePath, '.jsonl');
  const sessionId = filename.replace('rollout-', '');

  let startTime = '';
  let lastTime = '';
  let userCount = 0;
  let assistantCount = 0;
  const toolCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  let totalToolErrors = 0;
  let firstPrompt = '';
  let projectPath = '';
  let model = '';
  let lastMessageType = '';
  // Track the last tool name for correlating with function_call_output
  let lastToolName = '';

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const obj: AnyObj = JSON.parse(line);
        const ts = obj.timestamp as string;
        if (ts) {
          if (!startTime) startTime = ts;
          lastTime = ts;
        }

        const item = obj.item;
        if (!item) continue;

        if (item.type === 'SessionMeta') {
          if (item.working_directory) projectPath = item.working_directory;
          if (item.model) model = item.model;
        }

        if (item.type === 'message') {
          if (item.role === 'user') {
            userCount++;
            lastMessageType = 'user';
            if (Array.isArray(item.content)) {
              const text = item.content.find((c: AnyObj) => c.type === 'input_text');
              if (text?.text && !firstPrompt) firstPrompt = text.text.slice(0, 500);
            }
          }
          if (item.role === 'assistant') {
            assistantCount++;
            lastMessageType = 'assistant';
          }
        }

        if (item.type === 'function_call') {
          const toolName = item.name ?? item.tool_name ?? 'unknown';
          toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
          lastToolName = toolName;
        }

        // Best-effort error detection from function call output content
        if (item.type === 'function_call_output') {
          const output = typeof item.output === 'string' ? item.output : '';
          if (ERROR_PATTERN.test(output)) {
            const toolName = lastToolName || 'unknown';
            toolErrorCounts[toolName] = (toolErrorCounts[toolName] ?? 0) + 1;
            totalToolErrors++;
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch {
    return null;
  }

  if (!startTime) return null;

  const start = new Date(startTime).getTime();
  const end = lastTime ? new Date(lastTime).getTime() : start;
  const durationMinutes = (end - start) / 60_000;

  return {
    agent: 'codex',
    session_id: sessionId,
    project_path: projectPath || 'unknown',
    start_time: startTime,
    duration_minutes: durationMinutes,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_counts: toolCounts,
    tool_error_counts: toolErrorCounts,
    total_tool_errors: totalToolErrors,
    session_completed: lastMessageType === 'assistant',
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: firstPrompt,
    estimated_cost: 0,
    uses_mcp: false,
    model: model || undefined,
    _filePath: filePath,
  };
}

export class CodexReader implements CodingAgentReader {
  readonly agentName = 'codex' as const;
  readonly displayName = 'Codex CLI';

  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(codexPath('sessions'));
      return true;
    } catch {
      return false;
    }
  }

  async getSessions(): Promise<AgentSession[]> {
    const files = await findRolloutFiles(codexPath('sessions'));
    const results: AgentSession[] = [];
    for (const f of files) {
      const session = await deriveSessionFromRollout(f);
      if (session) results.push(session);
    }
    return results.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  }

  async getStats(): Promise<AgentStats> {
    const sessions = await this.getSessions();
    const dailyMap = new Map<string, DailyActivity>();

    let totalToolCalls = 0;
    let totalToolErrors = 0;
    let totalDuration = 0;
    let completedSessions = 0;

    for (const s of sessions) {
      totalDuration += s.duration_minutes;
      totalToolErrors += s.total_tool_errors;
      if (s.session_completed) completedSessions++;
      const toolCallCount = Object.values(s.tool_counts).reduce((a, b) => a + b, 0);
      totalToolCalls += toolCallCount;

      const date = s.start_time.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const existing = dailyMap.get(date) ?? { date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
        existing.messageCount += s.user_message_count + s.assistant_message_count;
        existing.sessionCount += 1;
        existing.toolCallCount += toolCallCount;
        dailyMap.set(date, existing);
      }
    }

    const dailyActivity = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    return {
      agent: 'codex',
      totalSessions: sessions.length,
      totalCost: 0,
      totalCacheSavings: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls,
      totalToolErrors,
      toolSuccessRate: totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1,
      completedSessions,
      costPerCompletion: 0,
      activeDays: dailyActivity.length,
      avgSessionMinutes: sessions.length > 0 ? totalDuration / sessions.length : 0,
      dailyActivity,
    };
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const files = await findRolloutFiles(codexPath('sessions'));
    const target = files.find(f => path.basename(f, '.jsonl') === `rollout-${sessionId}`);
    if (!target) return null;

    const session = await deriveSessionFromRollout(target);
    if (!session) return null;

    const messages: SessionMessage[] = [];
    const raw = await fs.readFile(target, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let lastToolName = '';

    for (const line of lines) {
      try {
        const obj: AnyObj = JSON.parse(line);
        const ts = obj.timestamp as string | undefined;
        const item = obj.item;
        if (!item) continue;

        if (item.type === 'message' && item.role === 'user') {
          const text = Array.isArray(item.content)
            ? item.content.filter((c: AnyObj) => c.type === 'input_text').map((c: AnyObj) => c.text ?? '').join('\n')
            : '';
          if (text) messages.push({ role: 'user', text: text.slice(0, 5000), timestamp: ts });
        }
        if (item.type === 'message' && item.role === 'assistant') {
          const text = Array.isArray(item.content)
            ? item.content.filter((c: AnyObj) => c.type === 'output_text').map((c: AnyObj) => c.text ?? '').join('\n')
            : '';
          if (text) messages.push({ role: 'assistant', text: text.slice(0, 5000), timestamp: ts });
        }
        if (item.type === 'function_call') {
          lastToolName = item.name ?? 'unknown';
          messages.push({
            role: 'assistant',
            text: `Tool: ${lastToolName}\n${JSON.stringify(item.arguments ?? {}, null, 2).slice(0, 2000)}`,
            timestamp: ts,
            toolName: lastToolName,
          });
        }
        if (item.type === 'function_call_output') {
          const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
          messages.push({
            role: 'tool_result',
            text: output.slice(0, 2000),
            timestamp: ts,
            toolName: lastToolName,
            isError: ERROR_PATTERN.test(output),
          });
        }
      } catch { /* skip */ }
    }

    return { session, messages };
  }
}
