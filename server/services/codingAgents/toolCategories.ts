/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified tool categorization across coding agents.
 */

export type ToolCategory =
  | 'file-io'
  | 'shell'
  | 'agent'
  | 'web'
  | 'planning'
  | 'todo'
  | 'skill'
  | 'mcp'
  | 'other';

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // Claude Code tools
  Read: 'file-io',
  Write: 'file-io',
  Edit: 'file-io',
  Glob: 'file-io',
  Grep: 'file-io',
  NotebookEdit: 'file-io',
  Bash: 'shell',
  Task: 'agent',
  TaskCreate: 'agent',
  TaskUpdate: 'agent',
  TaskList: 'agent',
  TaskOutput: 'agent',
  TaskStop: 'agent',
  TaskGet: 'agent',
  Agent: 'agent',
  WebSearch: 'web',
  WebFetch: 'web',
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
  AskUserQuestion: 'planning',
  TodoWrite: 'todo',
  Skill: 'skill',
  ToolSearch: 'skill',
  // Kiro tools
  readFile: 'file-io',
  writeFile: 'file-io',
  editFile: 'file-io',
  listFiles: 'file-io',
  searchFiles: 'file-io',
  executeCommand: 'shell',
  // Codex tools
  shell: 'shell',
  read_file: 'file-io',
  write_file: 'file-io',
  list_directory: 'file-io',
};

export const CATEGORY_COLORS: Record<ToolCategory, string> = {
  'file-io': '#60a5fa',
  'shell': '#d97706',
  'agent': '#a78bfa',
  'web': '#22c55e',
  'planning': '#fbbf24',
  'todo': '#fb923c',
  'skill': '#38bdf8',
  'mcp': '#34d399',
  'other': '#6b7280',
};

export const CATEGORY_LABELS: Record<ToolCategory, string> = {
  'file-io': 'File I/O',
  'shell': 'Shell',
  'agent': 'Agents',
  'web': 'Web',
  'planning': 'Planning',
  'todo': 'Todo',
  'skill': 'Skills',
  'mcp': 'MCP',
  'other': 'Other',
};

export function categorizeTool(name: string): ToolCategory {
  if (name.startsWith('mcp__') || name.startsWith('mcp_')) return 'mcp';
  return TOOL_CATEGORIES[name] ?? 'other';
}

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__') || name.startsWith('mcp_');
}

export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const prefix = name.startsWith('mcp__') ? 'mcp__' : name.startsWith('mcp_') ? 'mcp_' : null;
  if (!prefix) return null;
  const rest = name.slice(prefix.length);
  const sep = rest.indexOf('__');
  if (sep === -1) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}
