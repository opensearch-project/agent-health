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
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CodingAgentReader, AgentSession, AgentStats, DailyActivity, SessionDetail, SessionMessage } from '../types';
import { estimateCost } from '../pricing';

const execFileAsync = promisify(execFile);

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

// ─── kiro-cli SQLite session parsing ─────────────────────────────────────────

/** Run a sqlite3 query safely using execFile (async, no shell interpolation). */
async function sqlite3Json(dbPath: string, query: string, maxBuffer = 10 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, query], {
    maxBuffer,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return stdout;
}

/** Platform-specific kiro-cli data directory */
export function kiroCliDataDir(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kiro-cli');
  }
  if (platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'kiro-cli');
  }
  return path.join(os.homedir(), '.local', 'share', 'kiro-cli');
}

const KIRO_CLI_DB = path.join(kiroCliDataDir(), 'data.sqlite3');

async function listCliDbSessions(sinceMs?: number): Promise<AgentSession[]> {
  // better-sqlite3 is an optional dependency — skip if not installed
  let Database: any;
  try {
    Database = require('better-sqlite3');
  } catch {
    return listCliDbSessionsViaShell(sinceMs);
  }

  try {
    const db = Database(KIRO_CLI_DB, { readonly: true });
    const query = sinceMs
      ? `SELECT key, conversation_id, value, created_at, updated_at FROM conversations_v2 WHERE updated_at >= ? ORDER BY updated_at DESC`
      : `SELECT key, conversation_id, value, created_at, updated_at FROM conversations_v2 ORDER BY updated_at DESC`;
    const rows = (sinceMs ? db.prepare(query).all(sinceMs) : db.prepare(query).all()) as Array<{ key: string; conversation_id: string; value: string; created_at: number; updated_at: number }>;
    db.close();

    return rows.map(row => parseCliDbRow(row)).filter((s): s is AgentSession => s !== null);
  } catch {
    return listCliDbSessionsViaShell();
  }
}

async function listCliDbSessionsViaShell(sinceMs?: number): Promise<AgentSession[]> {
  try {
    await fs.access(KIRO_CLI_DB);
  } catch {
    return [];
  }

  try {
    const timeFilter = sinceMs ? `AND updated_at >= ${sinceMs}` : '';
    // Extract session metadata using sqlite3 + json_extract to avoid loading full values
    const metaQuery = [
      'SELECT key, conversation_id, created_at, updated_at,',
      "json_extract(value, '$.model_info.model_id') as model_id,",
      "json_extract(value, '$.conversation_id') as conv_id,",
      "json_array_length(value, '$.history') as history_len,",
      "json_array_length(value, '$.transcript') as transcript_len",
      'FROM conversations_v2',
      `WHERE length(value) < 10000000 ${timeFilter}`,
      'ORDER BY updated_at DESC',
    ].join(' ');

    const raw = await sqlite3Json(KIRO_CLI_DB, metaQuery);
    const rows: Array<{
      key: string; conversation_id: string; created_at: number; updated_at: number;
      model_id: string | null; conv_id: string | null; history_len: number; transcript_len: number;
    }> = JSON.parse(raw);

    // Now extract first prompts in a second query
    const promptQuery = [
      'SELECT conversation_id, key,',
      "json_extract(value, '$.history[0].user.content.Prompt.prompt') as first_prompt,",
      "json_extract(value, '$.user_turn_metadata.usage_info') as usage_info",
      'FROM conversations_v2',
      `WHERE length(value) < 10000000 ${timeFilter}`,
      'ORDER BY updated_at DESC',
    ].join(' ');

    const promptRaw = await sqlite3Json(KIRO_CLI_DB, promptQuery, 20 * 1024 * 1024);
    const promptRows: Array<{ conversation_id: string; key: string; first_prompt: string | null; usage_info: string | null }> = JSON.parse(promptRaw);
    const promptMap = new Map(promptRows.map(r => [`${r.key}|${r.conversation_id}`, r]));

    const smallResults = rows.map(row => {
      if (!row.history_len || row.history_len === 0) return null;

      const pk = `${row.key}|${row.conversation_id}`;
      const promptInfo = promptMap.get(pk);
      const firstPrompt = promptInfo?.first_prompt ?? '';

      let totalCredits = 0;
      if (promptInfo?.usage_info) {
        try {
          const usageArr = JSON.parse(promptInfo.usage_info);
          totalCredits = usageArr.reduce((sum: number, u: AnyObj) => sum + (u.value ?? 0), 0);
        } catch { /* skip */ }
      }

      const startTime = new Date(row.created_at).toISOString();
      const durationMs = row.updated_at - row.created_at;
      const model = row.model_id;

      return {
        agent: 'kiro' as const,
        session_id: row.conversation_id,
        project_path: row.key,
        start_time: startTime,
        duration_minutes: durationMs / 60_000,
        user_message_count: row.history_len,
        assistant_message_count: row.history_len,
        tool_counts: {},
        tool_error_counts: {},
        total_tool_errors: 0,
        session_completed: true,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        first_prompt: firstPrompt?.slice(0, 500) ?? '',
        estimated_cost: totalCredits,
        uses_mcp: false,
        model: model ? `kiro-cli (${model})` : 'kiro-cli',
        _filePath: KIRO_CLI_DB,
      } as AgentSession;
    }).filter((s): s is AgentSession => s !== null);

    const results = [...smallResults];

    // Also include large rows — skip during fast pass (length() scan is ~28s)
    if (!sinceMs) {
      try {
        const largeIndexRaw = await sqlite3Json(
          KIRO_CLI_DB,
          'SELECT key, conversation_id, created_at, updated_at FROM conversations_v2 WHERE length(value) >= 10000000 ORDER BY updated_at DESC',
          5 * 1024 * 1024,
        );
      const largeRows: Array<{ key: string; conversation_id: string; created_at: number; updated_at: number }> = JSON.parse(largeIndexRaw);
      for (const row of largeRows) {
        const startTime = new Date(row.created_at).toISOString();
        const durationMs = row.updated_at - row.created_at;
        results.push({
          agent: 'kiro',
          session_id: row.conversation_id,
          project_path: row.key,
          start_time: startTime,
          duration_minutes: durationMs / 60_000,
          user_message_count: 0,
          assistant_message_count: 0,
          tool_counts: {},
          tool_error_counts: {},
          total_tool_errors: 0,
          session_completed: true,
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          first_prompt: '(large session)',
          estimated_cost: 0,
          uses_mcp: false,
          model: 'kiro-cli',
          _filePath: KIRO_CLI_DB,
        });
      }
    } catch { /* skip large rows */ }
    } // end if (!sinceMs)

    return results;
  } catch {
    return [];
  }
}

function parseCliDbRow(row: { key: string; conversation_id: string; value: string; created_at: number; updated_at: number }): AgentSession | null {
  let data: AnyObj;
  try {
    data = JSON.parse(row.value);
  } catch {
    return null;
  }

  const history: AnyObj[] = data.history ?? [];
  if (history.length === 0) return null;

  let userCount = 0;
  let assistantCount = 0;
  let firstPrompt = '';
  let lastRole = '';
  const toolCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  let totalToolErrors = 0;
  let hasMcp = false;

  for (const turn of history) {
    const user = turn.user;
    const assistant = turn.assistant;
    const meta = turn.request_metadata;

    if (user) {
      userCount++;
      lastRole = 'user';
      if (!firstPrompt) {
        const prompt = user.content?.Prompt?.prompt;
        if (typeof prompt === 'string') firstPrompt = prompt.slice(0, 500);
      }
    }

    if (assistant) {
      assistantCount++;
      lastRole = 'assistant';
    }

    // Extract tool usage from request_metadata
    if (meta?.tool_use_ids_and_names) {
      for (const entry of meta.tool_use_ids_and_names) {
        const toolName = entry.name ?? entry[1] ?? 'unknown';
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
        if (toolName.startsWith('mcp_')) hasMcp = true;
      }
    }
  }

  if (userCount === 0) return null;

  const startTime = new Date(row.created_at).toISOString();
  const endTime = new Date(row.updated_at).toISOString();
  const durationMs = row.updated_at - row.created_at;
  const model = data.model_info?.model_id ?? data.model_info?.model_name;

  // Sum credits from usage_info
  const usageInfo = data.user_turn_metadata?.usage_info ?? [];
  const totalCredits = usageInfo.reduce((sum: number, u: AnyObj) => sum + (u.value ?? 0), 0);

  return {
    agent: 'kiro',
    session_id: row.conversation_id,
    project_path: row.key,
    start_time: startTime,
    duration_minutes: durationMs / 60_000,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_counts: toolCounts,
    tool_error_counts: toolErrorCounts,
    total_tool_errors: totalToolErrors,
    session_completed: lastRole === 'assistant',
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: firstPrompt,
    estimated_cost: totalCredits,
    uses_mcp: hasMcp,
    model: model ? `kiro-cli (${model})` : 'kiro-cli',
    _filePath: KIRO_CLI_DB,
  };
}

async function getCliDbSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  try {
    await fs.access(KIRO_CLI_DB);
  } catch {
    return null;
  }

  try {
    // Use sqlite3 to extract just the transcript (lightweight) and metadata
    const query = [
      'SELECT key, conversation_id, created_at, updated_at,',
      "json_extract(value, '$.model_info.model_id') as model_id,",
      "json_extract(value, '$.transcript') as transcript,",
      "json_array_length(value, '$.history') as history_len,",
      "json_extract(value, '$.history[0].user.content.Prompt.prompt') as first_prompt",
      "FROM conversations_v2 WHERE conversation_id='" + sessionId.replace(/'/g, "''") + "' LIMIT 1",
    ].join(' ');

    const raw = await sqlite3Json(KIRO_CLI_DB, query, 20 * 1024 * 1024);
    const rows = JSON.parse(raw);
    if (!rows.length) return null;

    const row = rows[0];
    const startTime = new Date(row.created_at).toISOString();
    const durationMs = row.updated_at - row.created_at;

    const session: AgentSession = {
      agent: 'kiro',
      session_id: row.conversation_id,
      project_path: row.key,
      start_time: startTime,
      duration_minutes: durationMs / 60_000,
      user_message_count: row.history_len ?? 0,
      assistant_message_count: row.history_len ?? 0,
      tool_counts: {},
      tool_error_counts: {},
      total_tool_errors: 0,
      session_completed: true,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      first_prompt: (row.first_prompt ?? '').slice(0, 500),
      estimated_cost: 0,
      uses_mcp: false,
      model: row.model_id ? `kiro-cli (${row.model_id})` : 'kiro-cli',
    };

    // Parse transcript into messages
    const messages: SessionMessage[] = [];
    let transcript: string[] = [];
    try {
      transcript = JSON.parse(row.transcript ?? '[]');
    } catch { /* skip */ }

    for (const entry of transcript) {
      if (typeof entry !== 'string') continue;
      // Transcript entries alternate: user prompts start with "> ", assistant responses don't
      // Tool uses show as "[Tool uses: ...]"
      if (entry.startsWith('> ')) {
        messages.push({ role: 'user', text: entry.slice(2).slice(0, 5000) });
      } else if (entry.includes('[Tool uses:')) {
        const toolMatch = entry.match(/\[Tool uses: (.+?)\]/);
        const textPart = entry.replace(/\[Tool uses: .+?\]/, '').trim();
        if (textPart) {
          messages.push({ role: 'assistant', text: textPart.slice(0, 5000) });
        }
        if (toolMatch) {
          messages.push({ role: 'assistant', text: `Tools: ${toolMatch[1]}`, toolName: toolMatch[1].split(',')[0].trim() });
        }
      } else if (entry.trim()) {
        messages.push({ role: 'assistant', text: entry.slice(0, 5000) });
      }
    }

    return { session, messages };
  } catch {
    return null;
  }
}

// ─── New .chat format parsing (hash-based workspace dirs) ────────────────────

/**
 * Find the execution index file in a workspace hash directory.
 * The IDE stores it under a fixed content-addressable filename that may
 * vary across IDE versions, so we detect it dynamically: it's the JSON
 * file (not .chat) whose top-level object contains an "executions" array.
 */
async function findExecutionIndex(dir: string): Promise<AnyObj | null> {
  const files = await fs.readdir(dir);
  for (const f of files) {
    if (f.endsWith('.chat')) continue;
    const fp = path.join(dir, f);
    try {
      const raw = await fs.readFile(fp, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data?.executions)) return data;
    } catch { /* not the index */ }
  }
  return null;
}

/**
 * List hash-based workspace directories that contain .chat files.
 * These are stored directly under the Kiro IDE globalStorage dir as
 * `<md5-hash>/` with `*.chat` JSON files and an execution index.
 */
async function listChatWorkspaceDirs(): Promise<string[]> {
  const baseDir = kiroIdeDataDir();
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !/^[0-9a-f]{32}$/.test(e.name)) continue;
      const dp = path.join(baseDir, e.name);
      const files = await fs.readdir(dp);
      if (files.some(f => f.endsWith('.chat'))) dirs.push(dp);
    }
    return dirs;
  } catch {
    return [];
  }
}

/** Extract workspace path from steering context in a .chat file. */
function extractWorkspaceFromChat(data: AnyObj): string {
  for (const ctx of (data.context ?? [])) {
    if (ctx.type === 'steering') {
      const id = ctx.id as string | undefined;
      if (id?.startsWith('file:///')) {
        const filePath = id.slice(7);
        const kiroIdx = filePath.indexOf('/.kiro/');
        if (kiroIdx > 0) return filePath.slice(0, kiroIdx);
        // Also try AGENTS.md, CLAUDE.md etc at project root
        const segments = filePath.split('/');
        // Walk up to find a reasonable project root (before the filename)
        if (segments.length > 1) return segments.slice(0, -1).join('/');
      }
    }
  }
  return 'unknown';
}

async function deriveChatSession(filePath: string): Promise<AgentSession | null> {
  let data: AnyObj;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const chat: AnyObj[] = data.chat ?? [];
  if (chat.length === 0) return null;

  const meta = data.metadata ?? {};
  const startTime = meta.startTime ? new Date(meta.startTime).toISOString() : null;
  const endTime = meta.endTime ? new Date(meta.endTime).toISOString() : null;
  if (!startTime) return null;

  let userCount = 0;
  let assistantCount = 0;
  let firstPrompt = '';
  let lastRole = '';
  const toolCounts: Record<string, number> = {};
  const toolErrorCounts: Record<string, number> = {};
  let totalToolErrors = 0;
  let hasMcp = false;

  for (const msg of chat) {
    const role = msg.role as string;
    const content = msg.content;

    if (role === 'human') {
      lastRole = 'human';
      if (typeof content === 'string' && content.startsWith('<identity>')) continue;
      userCount++;
      if (!firstPrompt && typeof content === 'string') {
        firstPrompt = content.slice(0, 500);
      }
    }

    if (role === 'bot') {
      assistantCount++;
      lastRole = 'bot';
      // Check for tool_use in content arrays
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'tool_use') {
            const toolName = c.name ?? 'unknown';
            toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
            if (toolName.startsWith('mcp_')) hasMcp = true;
          }
        }
      }
    }

    if (role === 'tool') {
      // Check for tool errors
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'tool_result' && c.is_error === true) {
            const toolName = 'unknown';
            toolErrorCounts[toolName] = (toolErrorCounts[toolName] ?? 0) + 1;
            totalToolErrors++;
          }
        }
      }
    }
  }

  // Skip sessions that are only system prompt + ack (no real user interaction)
  if (userCount === 0) return null;

  const projectPath = extractWorkspaceFromChat(data);
  const durationMs = (meta.endTime && meta.startTime) ? meta.endTime - meta.startTime : 0;
  const model = meta.modelId as string | undefined;
  const workflow = meta.workflow as string | undefined;

  return {
    agent: 'kiro',
    session_id: data.executionId ?? path.basename(filePath, '.chat'),
    project_path: projectPath,
    start_time: startTime,
    duration_minutes: durationMs / 60_000,
    user_message_count: userCount,
    assistant_message_count: assistantCount,
    tool_counts: toolCounts,
    tool_error_counts: toolErrorCounts,
    total_tool_errors: totalToolErrors,
    session_completed: lastRole === 'bot',
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    first_prompt: firstPrompt,
    estimated_cost: 0,
    uses_mcp: hasMcp,
    model: model || (workflow ? `kiro-ide (${workflow})` : undefined),
    _filePath: filePath,
  };
}

/**
 * List .chat sessions, optionally filtering by file mtime.
 * When `sinceMs` is provided, only files modified after that timestamp are read,
 * enabling fast startup for "Today" views.
 */
async function listChatSessions(sinceMs?: number): Promise<AgentSession[]> {
  const dirs = await listChatWorkspaceDirs();
  const results: AgentSession[] = [];

  for (const dir of dirs) {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.chat')) continue;
      const fp = path.join(dir, f);
      if (sinceMs) {
        try {
          const stat = await fs.stat(fp);
          if (stat.mtimeMs < sinceMs) continue;
        } catch { continue; }
      }
      const session = await deriveChatSession(fp);
      if (session) results.push(session);
    }
  }

  return results;
}

// ─── Combined reader ─────────────────────────────────────────────────────────

export class KiroReader implements CodingAgentReader {
  readonly agentName = 'kiro' as const;
  readonly displayName = 'Kiro';

  async isAvailable(): Promise<boolean> {
    // Available if any of CLI JSONL, CLI SQLite, IDE workspace-sessions, or new .chat sessions exist
    try {
      await fs.access(kiroPath('sessions', 'cli'));
      return true;
    } catch { /* try CLI db */ }
    try {
      await fs.access(KIRO_CLI_DB);
      return true;
    } catch { /* try IDE */ }
    try {
      await fs.access(path.join(kiroIdeDataDir(), 'workspace-sessions'));
      return true;
    } catch { /* try new .chat format */ }
    try {
      const dirs = await listChatWorkspaceDirs();
      if (dirs.length > 0) return true;
    } catch { /* nope */ }
    return false;
  }

  /**
   * Get sessions, optionally filtered to only recent files for fast startup.
   * When `sinceMs` is provided, only sessions modified after that timestamp are returned.
   */
  async getSessions(sinceMs?: number): Promise<AgentSession[]> {
    const [cliFiles, cliDbSessions, ideSessions] = await Promise.all([
      listCliSessionFiles(),
      listCliDbSessions(sinceMs),
      listIdeSessions(),
      // listChatSessions disabled — 8500+ files causes slow warmup
    ]);

    const results: AgentSession[] = [...ideSessions, ...cliDbSessions];

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
    if (filePath.endsWith('.chat')) {
      return deriveChatSession(filePath);
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
    // Try kiro-cli SQLite first (fastest — direct key lookup)
    const cliDbDetail = await getCliDbSessionDetail(sessionId);
    if (cliDbDetail) return cliDbDetail;

    // Try CLI JSONL
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

    // Try new .chat format — use execution index to find the right file quickly
    const chatDirs = await listChatWorkspaceDirs();
    for (const dir of chatDirs) {
      // Check execution index for this sessionId
      // Check execution index for this sessionId
      let indexData: AnyObj | null;
      try {
        indexData = await findExecutionIndex(dir);
      } catch {
        continue;
      }
      if (!indexData) continue;
      const match = (indexData.executions ?? []).find((e: AnyObj) => e.executionId === sessionId);
      if (!match) continue;

      // Found the right dir — now scan only this dir's .chat files
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!f.endsWith('.chat')) continue;
        const filePath = path.join(dir, f);
        try {
          const raw = await fs.readFile(filePath, 'utf-8');
          const data: AnyObj = JSON.parse(raw);
          if (data.executionId !== sessionId) continue;

          const session = await deriveChatSession(filePath);
          if (!session) continue;

          const messages: SessionMessage[] = [];
          for (const msg of (data.chat ?? [])) {
            const role = msg.role as string;
            const content = msg.content;
            if (role === 'human' && typeof content === 'string' && !content.startsWith('<identity>')) {
              messages.push({ role: 'user', text: content.slice(0, 5000) });
            }
            if (role === 'bot') {
              if (typeof content === 'string' && content.trim()) {
                messages.push({ role: 'assistant', text: content.slice(0, 5000) });
              } else if (Array.isArray(content)) {
                for (const c of content) {
                  if (c.type === 'text' && c.text) {
                    messages.push({ role: 'assistant', text: (c.text as string).slice(0, 5000) });
                  }
                  if (c.type === 'tool_use') {
                    messages.push({
                      role: 'assistant',
                      text: `Tool: ${c.name}\n${JSON.stringify(c.input ?? {}, null, 2).slice(0, 2000)}`,
                      toolName: c.name,
                    });
                  }
                }
              }
            }
            if (role === 'tool' && typeof content === 'string' && content.trim()) {
              messages.push({ role: 'tool_result', text: content.slice(0, 2000) });
            }
          }
          return { session, messages };
        } catch { /* skip */ }
      }
    }

    return null;
  }
}
