/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude Code reader — parses ~/.claude/ session JSONL files.
 * Ported from cc-lens (MIT) claude-reader.ts with adaptations for agent-health.
 */

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import path from 'path';
import os from 'os';
import type { CodingAgentReader, AgentSession, AgentStats, DailyActivity, SessionDetail, SessionMessage } from '../types';
import { estimateCost, estimateCacheSavings } from '../pricing';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

function claudePath(...segments: string[]): string {
  return path.join(CLAUDE_DIR, ...segments);
}

function stripXmlTags(text: string): string {
  return text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]+\/>/g, '').replace(/<[^>]+>/g, '').trim();
}

async function listProjectSlugs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(claudePath('projects'), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function listProjectJSONLFiles(slug: string): Promise<string[]> {
  try {
    const dir = claudePath('projects', slug);
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

async function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
    if (lines.length >= maxLines) break;
  }
  rl.close();
  return lines;
}

async function resolveProjectPath(slug: string): Promise<string> {
  const files = await listProjectJSONLFiles(slug);
  for (const f of files) {
    try {
      const lines = await readFirstLines(f, 50);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.cwd && typeof obj.cwd === 'string') return obj.cwd;
        } catch { /* skip */ }
      }
    } catch { /* next file */ }
  }
  return slug.replace(/-/g, '/');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

async function deriveSessionMeta(
  filePath: string,
  sessionId: string,
  projectPath: string,
): Promise<AgentSession | null> {
  let startTime = '';
  let lastTime = '';
  let userCount = 0;
  let assistantCount = 0;
  const toolCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  const toolUseIdToName: Record<string, string> = {};
  let totalToolErrors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let firstPrompt = '';
  let hasMcp = false;
  let lastMessageType = '';
  let lastAssistantHasText = false;
  let model = '';

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
        if (obj.type === 'user') {
          userCount++;
          lastMessageType = 'user';
          const content = obj.message?.content;
          if (typeof content === 'string' && !firstPrompt) {
            firstPrompt = stripXmlTags(content).slice(0, 500);
          } else if (Array.isArray(content)) {
            const text = content.find((c: AnyObj) => c.type === 'text');
            if (text?.text && !firstPrompt) firstPrompt = stripXmlTags(text.text).slice(0, 500);
            // Check tool_result blocks for errors
            for (const c of content) {
              if (c.type === 'tool_result' && c.is_error === true) {
                const toolName = toolUseIdToName[c.tool_use_id] ?? 'unknown';
                toolErrorCounts[toolName] = (toolErrorCounts[toolName] ?? 0) + 1;
                totalToolErrors++;
              }
            }
          }
        }
        if (obj.type === 'assistant') {
          assistantCount++;
          lastMessageType = 'assistant';
          lastAssistantHasText = false;
          const msg = obj.message;
          if (msg?.model && !model) model = msg.model;
          if (msg?.usage) {
            inputTokens += msg.usage.input_tokens ?? 0;
            outputTokens += msg.usage.output_tokens ?? 0;
            cacheRead += msg.usage.cache_read_input_tokens ?? 0;
            cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
          }
          if (Array.isArray(msg?.content)) {
            for (const c of msg.content) {
              if (c.type === 'tool_use' && c.name) {
                toolCounts[c.name] = (toolCounts[c.name] ?? 0) + 1;
                if (c.id) toolUseIdToName[c.id] = c.name;
                if (c.name.startsWith('mcp__')) hasMcp = true;
              }
              if (c.type === 'text' && c.text) {
                lastAssistantHasText = true;
              }
            }
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
  const costModel = model || 'claude-opus-4-6';
  const cost = estimateCost(costModel, inputTokens, outputTokens, cacheWrite, cacheRead);

  // Session is completed if the last message was an assistant message with text
  const sessionCompleted = lastMessageType === 'assistant' && lastAssistantHasText;

  return {
    agent: 'claude-code',
    session_id: sessionId,
    project_path: projectPath,
    start_time: startTime,
    duration_minutes: durationMinutes,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_counts: toolCounts,
    tool_error_counts: toolErrorCounts,
    total_tool_errors: totalToolErrors,
    session_completed: sessionCompleted,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    first_prompt: firstPrompt,
    estimated_cost: cost,
    uses_mcp: hasMcp,
    model: model || undefined,
    _filePath: filePath,
  };
}

export class ClaudeCodeReader implements CodingAgentReader {
  readonly agentName = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(claudePath('projects'));
      return true;
    } catch {
      return false;
    }
  }

  async getSessions(): Promise<AgentSession[]> {
    try {
      const slugs = await listProjectSlugs();

      // Resolve all project paths in parallel
      const slugData = await Promise.all(
        slugs.map(async slug => ({
          slug,
          projectPath: await resolveProjectPath(slug),
          files: await listProjectJSONLFiles(slug),
        }))
      );

      // Parse all session files in parallel (batched to limit concurrency)
      const BATCH_SIZE = 20;
      const results: AgentSession[] = [];
      const allTasks = slugData.flatMap(({ projectPath, files }) =>
        files.map(filePath => ({
          filePath,
          sessionId: path.basename(filePath, '.jsonl'),
          projectPath,
        }))
      );

      for (let i = 0; i < allTasks.length; i += BATCH_SIZE) {
        const batch = allTasks.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(({ filePath, sessionId, projectPath }) =>
            deriveSessionMeta(filePath, sessionId, projectPath)
          )
        );
        for (const meta of batchResults) {
          if (meta) results.push(meta);
        }
      }

      return results.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
    } catch {
      return [];
    }
  }

  async getStats(): Promise<AgentStats> {
    const sessions = await this.getSessions();
    const dailyMap = new Map<string, DailyActivity>();

    let totalCost = 0;
    let totalCacheSavings = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let totalToolErrors = 0;
    let totalDuration = 0;
    let completedSessions = 0;

    for (const s of sessions) {
      totalCost += s.estimated_cost;
      totalCacheSavings += estimateCacheSavings('claude-opus-4-6', s.cache_read_input_tokens);
      totalInputTokens += s.input_tokens;
      totalOutputTokens += s.output_tokens;
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
      agent: 'claude-code',
      totalSessions: sessions.length,
      totalCost,
      totalCacheSavings,
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls,
      totalToolErrors,
      toolSuccessRate: totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1,
      completedSessions,
      costPerCompletion: completedSessions > 0 ? totalCost / completedSessions : 0,
      activeDays: dailyActivity.length,
      avgSessionMinutes: sessions.length > 0 ? totalDuration / sessions.length : 0,
      dailyActivity,
    };
  }

  async rereadSession(filePath: string): Promise<AgentSession | null> {
    const sessionId = path.basename(filePath, '.jsonl');
    const slug = path.basename(path.dirname(filePath));
    const projectPath = await resolveProjectPath(slug);
    return deriveSessionMeta(filePath, sessionId, projectPath);
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const slugs = await listProjectSlugs();
    for (const slug of slugs) {
      const filePath = claudePath('projects', slug, `${sessionId}.jsonl`);
      try {
        await fs.access(filePath);
      } catch {
        continue;
      }

      const projectPath = await resolveProjectPath(slug);
      const session = await deriveSessionMeta(filePath, sessionId, projectPath);
      if (!session) continue;

      const messages: SessionMessage[] = [];
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        try {
          const obj: AnyObj = JSON.parse(line);
          const ts = obj.timestamp as string | undefined;

          if (obj.type === 'user') {
            const content = obj.message?.content;
            let text = '';
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === 'text' && c.text) text += c.text + '\n';
                if (c.type === 'tool_result') {
                  messages.push({
                    role: 'tool_result',
                    text: typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '').slice(0, 2000),
                    timestamp: ts,
                    toolName: c.tool_use_id,
                    isError: c.is_error === true,
                  });
                }
              }
            }
            if (text.trim()) {
              messages.push({ role: 'user', text: stripXmlTags(text).slice(0, 5000), timestamp: ts });
            }
          }

          if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
            for (const c of obj.message.content) {
              if (c.type === 'text' && c.text) {
                messages.push({ role: 'assistant', text: c.text.slice(0, 5000), timestamp: ts });
              }
              if (c.type === 'tool_use') {
                messages.push({
                  role: 'assistant',
                  text: `Tool: ${c.name}\n${JSON.stringify(c.input ?? {}, null, 2).slice(0, 2000)}`,
                  timestamp: ts,
                  toolName: c.name,
                });
              }
            }
          }
        } catch { /* skip */ }
      }

      return { session, messages };
    }
    return null;
  }
}
