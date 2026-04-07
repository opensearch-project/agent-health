/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Claude Code workspace features — reads memory, plans, tasks, settings,
 * skills, plugins, and active sessions from ~/.claude/.
 *
 * These are Claude Code-specific features not shared across agents.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

function claudePath(...segments: string[]): string {
  return path.join(CLAUDE_DIR, ...segments);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryFile {
  name: string;
  description: string;
  type: string;
  content: string;
  filePath: string;
}

export interface PlanFile {
  name: string;
  content: string;
  filePath: string;
  modifiedAt: string;
}

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: string;
  blocks: string[];
  blockedBy: string[];
  activeForm?: string;
  owner?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface PluginInfo {
  name: string;
  scope: string;
  version: string;
  installedAt: string;
}

export interface ClaudeCodeSettings {
  settings: AnyObj;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  storage_bytes: number;
}

export interface ActiveSessionInfo {
  session_id: string;
  project_path: string;
  project_slug: string;
  last_activity: string;
  last_activity_ago: string;
  model?: string;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: AnyObj; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta: AnyObj = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      meta[key] = value;
    }
  }
  return { meta, body: match[2] };
}

export async function getMemoryFiles(): Promise<{ projects: Array<{ slug: string; projectPath: string; memories: MemoryFile[] }> }> {
  const projects: Array<{ slug: string; projectPath: string; memories: MemoryFile[] }> = [];

  try {
    const projectsDir = claudePath('projects');
    const slugs = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const entry of slugs) {
      if (!entry.isDirectory()) continue;
      const memDir = path.join(projectsDir, entry.name, 'memory');
      try {
        const files = await fs.readdir(memDir);
        const memories: MemoryFile[] = [];

        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          const filePath = path.join(memDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const { meta, body } = parseFrontmatter(content);

          memories.push({
            name: meta.name || file.replace('.md', ''),
            description: meta.description || '',
            type: meta.type || (file === 'MEMORY.md' ? 'index' : 'unknown'),
            content: file === 'MEMORY.md' ? content : body,
            filePath: filePath,
          });
        }

        if (memories.length > 0) {
          projects.push({
            slug: entry.name,
            projectPath: entry.name.replace(/-/g, '/'),
            memories,
          });
        }
      } catch { /* no memory dir */ }
    }
  } catch { /* no projects dir */ }

  return { projects };
}

export async function updateMemoryFile(filePath: string, content: string): Promise<boolean> {
  // Security: only allow writing to memory files under ~/.claude/projects/
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(claudePath('projects')) || !resolved.includes('/memory/') || !resolved.endsWith('.md')) {
    return false;
  }
  try {
    await fs.writeFile(resolved, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ─── Plans ──────────────────────────────────────────────────────────────────

export async function getPlans(): Promise<PlanFile[]> {
  const plans: PlanFile[] = [];
  try {
    const dir = claudePath('plans');
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      plans.push({
        name: file.replace('.md', ''),
        content: content.slice(0, 10000),
        filePath,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  } catch { /* no plans */ }
  return plans.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export async function getTasks(): Promise<TaskItem[]> {
  const tasks: TaskItem[] = [];
  try {
    const dir = claudePath('tasks');
    const taskListDirs = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of taskListDirs) {
      if (!entry.isDirectory()) continue;
      const listDir = path.join(dir, entry.name);
      const files = await fs.readdir(listDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(listDir, file), 'utf-8');
          const task: AnyObj = JSON.parse(raw);
          if (task.id && task.subject) {
            tasks.push({
              id: task.id,
              subject: task.subject,
              description: task.description ?? '',
              status: task.status ?? 'pending',
              blocks: task.blocks ?? [],
              blockedBy: task.blockedBy ?? [],
              activeForm: task.activeForm,
              owner: task.owner,
            });
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* no tasks */ }
  return tasks;
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function getSettings(): Promise<ClaudeCodeSettings> {
  let settings: AnyObj = {};
  const skills: SkillInfo[] = [];
  const plugins: PluginInfo[] = [];
  let storageBytes = 0;

  // Read settings.json
  try {
    const raw = await fs.readFile(claudePath('settings.json'), 'utf-8');
    settings = JSON.parse(raw);
  } catch { /* no settings */ }

  // Read installed plugins
  try {
    const raw = await fs.readFile(claudePath('plugins', 'installed_plugins.json'), 'utf-8');
    const data: AnyObj = JSON.parse(raw);
    if (data.plugins) {
      for (const [name, installs] of Object.entries(data.plugins as Record<string, AnyObj[]>)) {
        if (Array.isArray(installs)) {
          for (const install of installs) {
            plugins.push({
              name,
              scope: install.scope ?? 'user',
              version: install.version ?? '',
              installedAt: install.installedAt ?? '',
            });

            // Try to extract skills from plugin
            if (install.installPath) {
              try {
                const skillsDir = path.join(install.installPath, 'skills');
                const skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
                for (const se of skillEntries) {
                  if (se.isDirectory()) {
                    let desc = '';
                    try {
                      const skillMd = await fs.readFile(path.join(skillsDir, se.name, 'SKILL.md'), 'utf-8');
                      const firstLine = skillMd.split('\n').find(l => l.trim() && !l.startsWith('#'));
                      if (firstLine) desc = firstLine.trim().slice(0, 200);
                    } catch { /* no SKILL.md */ }
                    skills.push({ name: se.name, description: desc });
                  }
                }
              } catch { /* no skills dir */ }
            }
          }
        }
      }
    }
  } catch { /* no plugins */ }

  // Estimate storage
  try {
    const entries = await fs.readdir(CLAUDE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      try {
        const stat = await fs.stat(path.join(CLAUDE_DIR, entry.name));
        storageBytes += stat.size;
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  return { settings, skills, plugins, storage_bytes: storageBytes };
}

// ─── Active Sessions ────────────────────────────────────────────────────────

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function getActiveSessions(): Promise<ActiveSessionInfo[]> {
  const active: ActiveSessionInfo[] = [];
  const now = Date.now();
  const ACTIVE_THRESHOLD = 30 * 60 * 1000; // 30 minutes

  try {
    const projectsDir = claudePath('projects');
    const slugs = await fs.readdir(projectsDir, { withFileTypes: true });

    for (const entry of slugs) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(projectsDir, entry.name);

      try {
        const files = await fs.readdir(projectDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(projectDir, file);
          const stat = await fs.stat(filePath);
          const lastModified = stat.mtime.getTime();

          if (now - lastModified < ACTIVE_THRESHOLD) {
            // Read last few lines to get model
            let model: string | undefined;
            try {
              const raw = await fs.readFile(filePath, 'utf-8');
              const lines = raw.split(/\r?\n/).filter(Boolean);
              for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
                try {
                  const obj = JSON.parse(lines[i]);
                  if (obj.type === 'assistant' && obj.message?.model) {
                    model = obj.message.model;
                    break;
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }

            active.push({
              session_id: file.replace('.jsonl', ''),
              project_path: entry.name.replace(/-/g, '/'),
              project_slug: entry.name,
              last_activity: stat.mtime.toISOString(),
              last_activity_ago: timeAgo(stat.mtime),
              model,
            });
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* no projects dir */ }

  return active.sort((a, b) => b.last_activity.localeCompare(a.last_activity));
}
