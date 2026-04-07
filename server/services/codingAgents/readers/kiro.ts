/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Kiro reader — supports both Kiro CLI and Kiro IDE session formats.
 *
 * **Kiro CLI** (`~/.kiro/sessions/cli/`):
 *   JSONL files with `kind` discriminator (Prompt, AssistantMessage, ToolResults).
 *   Companion .json has timestamps and token counts.
 *
 * **Kiro IDE** (`~/Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/`):
 *   workspace-sessions/<base64-path>/<sessionId>.json — JSON with `history[]`
 *   of `{message: {role, content}}` entries. Session index in sessions.json.
 *   Tool calls happen via executionId (out-of-band), not embedded in messages.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { CodingAgentReader, AgentSession, AgentStats, DailyActivity, SessionDetail, SessionMessage } from '../types';
import { estimateCost } from '../pricing';

const KIRO_DIR = path.join(os.homedir(), '.kiro');

/** Platform-specific Kiro IDE data directory */
function kiroIdeDataDir(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  }
  if (platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  }
  // Linux / other
  return path.join(os.homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
}

function kiroPath(...segments: string[]): string {
  return path.join(KIRO_DIR, ...segments);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

// ─── CLI session parsing ─────────────────────────────────────────────────────

async function listCliSessionFiles(): Promise<string[]> {
  const dir = kiroPath('sessions', 'cli');
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

async function readCliSessionMeta(sessionId: string): Promise<AnyObj | null> {
  try {
    const raw = await fs.readFile(kiroPath('sessions', 'cli', `${sessionId}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deriveCliSession(filePath: string): Promise<AgentSession | null> {
  const sessionId = path.basename(filePath, '.jsonl');
  let userCount = 0;
  let assistantCount = 0;
  const toolCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  const toolUseIdToName: Record<string, string> = {};
  let totalToolErrors = 0;
  let firstPrompt = '';
  let hasMcp = false;
  let lastMessageKind = '';

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const obj: AnyObj = JSON.parse(line);
        const kind = obj.kind as string;
        const data = obj.data;
        if (!data) continue;

        if (kind === 'Prompt') {
          userCount++;
          lastMessageKind = 'Prompt';
          if (Array.isArray(data.content) && !firstPrompt) {
            const textBlock = data.content.find((c: AnyObj) => c.kind === 'text');
            if (textBlock?.data) {
              let promptText = textBlock.data as string;
              if (promptText.startsWith('You are a session naming agent')) {
                userCount--;
              } else {
                const marker = '[CURRENT USER REQUEST';
                const idx = promptText.indexOf(marker);
                if (idx >= 0) {
                  const afterMarker = promptText.indexOf('\n', idx);
                  if (afterMarker >= 0) promptText = promptText.slice(afterMarker + 1).trim();
                }
                const optIdx = promptText.indexOf('\n(If presenting choices');
                if (optIdx >= 0) promptText = promptText.slice(0, optIdx).trim();
                if (promptText) firstPrompt = promptText.slice(0, 500);
              }
            }
          }
          if (Array.isArray(data.content)) {
            for (const c of data.content) {
              if ((c.kind === 'toolResult' || c.type === 'tool_result') && c.data?.isError === true) {
                const toolName = toolUseIdToName[c.data?.toolUseId] ?? 'unknown';
                toolErrorCounts[toolName] = (toolErrorCounts[toolName] ?? 0) + 1;
                totalToolErrors++;
              }
            }
          }
        }

        if (kind === 'AssistantMessage') {
          assistantCount++;
          lastMessageKind = 'AssistantMessage';
          if (Array.isArray(data.content)) {
            for (const c of data.content) {
              if (c.kind === 'toolUse' && c.data) {
                const toolData = c.data;
                const serverName = toolData.serverName;
                const toolName = serverName
                  ? `mcp_${serverName}__${toolData.name}`
                  : (toolData.name ?? 'unknown');
                toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
                if (toolData.toolUseId) toolUseIdToName[toolData.toolUseId] = toolName;
                if (serverName) hasMcp = true;
              }
            }
          }
        }

        if (kind === 'ToolResults' && data.content) {
          for (const c of (Array.isArray(data.content) ? data.content : [])) {
            if (c.kind === 'toolResult' && c.data) {
              if (c.data.isError === true) {
                const toolName = toolUseIdToName[c.data.toolUseId] ?? 'unknown';
                toolErrorCounts[toolName] = (toolErrorCounts[toolName] ?? 0) + 1;
                totalToolErrors++;
              }
            }
          }
          if (data.results) {
            for (const [id, result] of Object.entries(data.results as Record<string, AnyObj>)) {
              const toolMeta = result?.tool;
              if (toolMeta?.kind?.Mcp?.serverName) {
                const serverName = toolMeta.kind.Mcp.serverName;
                const rawName = toolMeta.kind.Mcp.toolName ?? toolUseIdToName[id];
                if (rawName && !toolUseIdToName[id]?.startsWith('mcp_')) {
                  const mcpName = `mcp_${serverName}__${rawName}`;
                  const oldName = toolUseIdToName[id] ?? rawName;
                  if (toolCounts[oldName]) {
                    toolCounts[oldName]--;
                    if (toolCounts[oldName] <= 0) delete toolCounts[oldName];
                  }
                  toolCounts[mcpName] = (toolCounts[mcpName] ?? 0) + 1;
                  toolUseIdToName[id] = mcpName;
                  hasMcp = true;
                }
              }
              if (result?.isError === true || (result?.result && !result.result.Success)) {
                const toolName = toolUseIdToName[id] ?? 'unknown';
                toolErrorCounts[toolName] = (toolErrorCounts[toolName] ?? 0) + 1;
                totalToolErrors++;
              }
            }
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch {
    return null;
  }

  const meta = await readCliSessionMeta(sessionId);
  if (!meta) return null;

  const startTime = meta.created_at as string;
  const lastTime = meta.updated_at as string;
  if (!startTime) return null;

  const projectPath = (meta.cwd as string) || 'unknown';

  let inputTokens = 0;
  let outputTokens = 0;
  const sessionState = meta.session_state;
  if (sessionState?.conversation_metadata?.user_turn_metadatas) {
    for (const turn of sessionState.conversation_metadata.user_turn_metadatas) {
      inputTokens += turn.input_token_count ?? 0;
      outputTokens += turn.output_token_count ?? 0;
    }
  }
  if (meta.turns && Array.isArray(meta.turns)) {
    for (const turn of meta.turns) {
      inputTokens += turn.input_token_count ?? 0;
      outputTokens += turn.output_token_count ?? 0;
    }
  }

  const start = new Date(startTime).getTime();
  const end = lastTime ? new Date(lastTime).getTime() : start;
  const durationMinutes = (end - start) / 60_000;
  const cost = estimateCost('us.anthropic.claude-sonnet-4-6-v1', inputTokens, outputTokens);

  return {
    agent: 'kiro',
    session_id: sessionId,
    project_path: projectPath,
    start_time: startTime,
    duration_minutes: durationMinutes,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_counts: toolCounts,
    tool_error_counts: toolErrorCounts,
    total_tool_errors: totalToolErrors,
    session_completed: lastMessageKind === 'AssistantMessage',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: firstPrompt,
    estimated_cost: cost,
    uses_mcp: hasMcp,
    _filePath: filePath,
  };
}

// ─── IDE session parsing ─────────────────────────────────────────────────────

interface IdeSessionIndex {
  sessionId: string;
  title: string;
  dateCreated: string; // epoch millis as string
  workspaceDirectory: string;
  hidden?: boolean;
}

async function listIdeWorkspaces(): Promise<string[]> {
  const dir = path.join(kiroIdeDataDir(), 'workspace-sessions');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function deriveIdeSession(
  wsDir: string,
  index: IdeSessionIndex,
): Promise<AgentSession | null> {
  if (index.hidden) return null;

  const filePath = path.join(wsDir, `${index.sessionId}.json`);
  let data: AnyObj;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const history: AnyObj[] = data.history ?? [];
  if (history.length === 0) return null;

  let userCount = 0;
  let assistantCount = 0;
  let firstPrompt = '';
  let lastRole = '';

  for (const entry of history) {
    const msg = entry.message;
    if (!msg) continue;
    const role = msg.role as string;

    if (role === 'user') {
      userCount++;
      lastRole = 'user';
      if (!firstPrompt) {
        const content = msg.content;
        if (typeof content === 'string') {
          firstPrompt = content.slice(0, 500);
        } else if (Array.isArray(content)) {
          const text = content.find((c: AnyObj) => c.type === 'text');
          if (text?.text) firstPrompt = text.text.slice(0, 500);
        }
      }
    }
    if (role === 'assistant') {
      assistantCount++;
      lastRole = 'assistant';
    }
  }

  // dateCreated is epoch millis as string
  const epochMs = parseInt(index.dateCreated, 10);
  if (isNaN(epochMs)) return null;
  const startTime = new Date(epochMs).toISOString();

  const projectPath = (data.workspaceDirectory as string)
    || (data.workspacePath as string)
    || index.workspaceDirectory
    || 'unknown';

  const model = (data.selectedModel as string) || undefined;
  const sessionType = data.sessionType as string | undefined;
  const title = (data.title as string) || index.title || '';

  // Use session title as prompt fallback for spec/task sessions
  if (!firstPrompt && title) {
    firstPrompt = title.slice(0, 500);
  }

  return {
    agent: 'kiro',
    session_id: index.sessionId,
    project_path: projectPath,
    start_time: startTime,
    duration_minutes: 0, // IDE doesn't provide end time
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_counts: {}, // Tool calls happen out-of-band via executionId
    tool_error_counts: {},
    total_tool_errors: 0,
    session_completed: lastRole === 'assistant',
    input_tokens: 0, // Not tracked per-session in IDE
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: firstPrompt,
    estimated_cost: 0,
    uses_mcp: false,
    model: model || (sessionType ? `kiro-ide (${sessionType})` : undefined),
    _filePath: filePath,
  };
}

async function listIdeSessions(): Promise<AgentSession[]> {
  const workspaces = await listIdeWorkspaces();
  const results: AgentSession[] = [];

  for (const wsDir of workspaces) {
    try {
      const raw = await fs.readFile(path.join(wsDir, 'sessions.json'), 'utf-8');
      const indices: IdeSessionIndex[] = JSON.parse(raw);
      for (const idx of indices) {
        const session = await deriveIdeSession(wsDir, idx);
        if (session) results.push(session);
      }
    } catch { /* skip */ }
  }

  return results;
}

// ─── Combined reader ─────────────────────────────────────────────────────────

export class KiroReader implements CodingAgentReader {
  readonly agentName = 'kiro' as const;
  readonly displayName = 'Kiro';

  async isAvailable(): Promise<boolean> {
    // Available if either CLI sessions or IDE sessions exist
    try {
      await fs.access(kiroPath('sessions', 'cli'));
      return true;
    } catch { /* try IDE */ }
    try {
      await fs.access(path.join(kiroIdeDataDir(), 'workspace-sessions'));
      return true;
    } catch {
      return false;
    }
  }

  async getSessions(): Promise<AgentSession[]> {
    const [cliFiles, ideSessions] = await Promise.all([
      listCliSessionFiles(),
      listIdeSessions(),
    ]);

    const results: AgentSession[] = [...ideSessions];

    for (const f of cliFiles) {
      const session = await deriveCliSession(f);
      if (session) results.push(session);
    }

    // Deduplicate by session_id (in case CLI and IDE share sessions)
    const seen = new Set<string>();
    const deduped: AgentSession[] = [];
    for (const s of results) {
      if (!seen.has(s.session_id)) {
        seen.add(s.session_id);
        deduped.push(s);
      }
    }

    return deduped.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());
  }

  async getStats(): Promise<AgentStats> {
    const sessions = await this.getSessions();
    const dailyMap = new Map<string, DailyActivity>();

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let totalToolErrors = 0;
    let totalDuration = 0;
    let completedSessions = 0;

    for (const s of sessions) {
      totalCost += s.estimated_cost;
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
      agent: 'kiro',
      totalSessions: sessions.length,
      totalCost,
      totalCacheSavings: 0,
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
    if (filePath.endsWith('.jsonl')) {
      return deriveCliSession(filePath);
    }
    // IDE session — need the index entry
    const wsDir = path.dirname(filePath);
    try {
      const indexRaw = await fs.readFile(path.join(wsDir, 'sessions.json'), 'utf-8');
      const indices: IdeSessionIndex[] = JSON.parse(indexRaw);
      const sessionId = path.basename(filePath, '.json');
      const idx = indices.find(i => i.sessionId === sessionId);
      if (idx) return deriveIdeSession(wsDir, idx);
    } catch { /* skip */ }
    return null;
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    // Try CLI first
    const cliPath = kiroPath('sessions', 'cli', `${sessionId}.jsonl`);
    try {
      await fs.access(cliPath);
      const session = await deriveCliSession(cliPath);
      if (session) {
        const messages: SessionMessage[] = [];
        const raw = await fs.readFile(cliPath, 'utf-8');
        const lines = raw.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const obj: AnyObj = JSON.parse(line);
            const kind = obj.kind as string;
            const data = obj.data;
            if (!data) continue;
            if (kind === 'Prompt' && Array.isArray(data.content)) {
              const textBlock = data.content.find((c: AnyObj) => c.kind === 'text');
              if (textBlock?.data) {
                messages.push({ role: 'user', text: (textBlock.data as string).slice(0, 5000) });
              }
            }
            if (kind === 'AssistantMessage' && Array.isArray(data.content)) {
              for (const c of data.content) {
                if (c.kind === 'text' && c.data) {
                  messages.push({ role: 'assistant', text: (c.data as string).slice(0, 5000) });
                }
                if (c.kind === 'toolUse' && c.data) {
                  messages.push({
                    role: 'assistant',
                    text: `Tool: ${c.data.name}\n${JSON.stringify(c.data.input ?? {}, null, 2).slice(0, 2000)}`,
                    toolName: c.data.name,
                  });
                }
              }
            }
            if (kind === 'ToolResults' && Array.isArray(data.content)) {
              for (const c of data.content) {
                if (c.kind === 'toolResult' && c.data) {
                  const content = Array.isArray(c.data.content)
                    ? c.data.content.map((x: AnyObj) => x.text ?? '').join('\n')
                    : String(c.data.content ?? '');
                  messages.push({
                    role: 'tool_result',
                    text: content.slice(0, 2000),
                    isError: c.data.isError === true,
                  });
                }
              }
            }
          } catch { /* skip */ }
        }
        return { session, messages };
      }
    } catch { /* try IDE */ }

    // Try IDE
    const workspaces = await listIdeWorkspaces();
    for (const wsDir of workspaces) {
      const filePath = path.join(wsDir, `${sessionId}.json`);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const data: AnyObj = JSON.parse(raw);
        const history: AnyObj[] = data.history ?? [];
        const messages: SessionMessage[] = [];

        for (const entry of history) {
          const msg = entry.message;
          if (!msg) continue;
          const role = msg.role === 'user' ? 'user' as const : 'assistant' as const;
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .filter((c: AnyObj) => c.type === 'text')
              .map((c: AnyObj) => c.text ?? '')
              .join('\n');
          }
          if (text.trim()) messages.push({ role, text: text.slice(0, 5000) });
        }

        // We need the session metadata — build it from IDE index
        const indexPath = path.join(wsDir, 'sessions.json');
        const indexRaw = await fs.readFile(indexPath, 'utf-8');
        const indices: IdeSessionIndex[] = JSON.parse(indexRaw);
        const idx = indices.find(i => i.sessionId === sessionId);
        if (idx) {
          const session = await deriveIdeSession(wsDir, idx);
          if (session) return { session, messages };
        }
      } catch { /* skip */ }
    }

    return null;
  }
}
