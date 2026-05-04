/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Terminal, Zap, DollarSign, Clock } from 'lucide-react';
import { ENV_CONFIG } from '@/lib/config';

interface AgentStats {
  agent: string;
  totalSessions: number;
  totalCost: number;
  completedSessions: number;
  activeDays: number;
  avgSessionMinutes: number;
  totalToolCalls: number;
  toolSuccessRate: number;
}

interface CombinedStats {
  agents: AgentStats[];
  totalCost: number;
  totalSessions: number;
  totalTokens: number;
}

const AGENT_META: Record<string, { label: string; color: string; icon: string }> = {
  'claude-code': { label: 'Claude Code', color: '#f97316', icon: '🟠' },
  'kiro': { label: 'Kiro', color: '#8b5cf6', icon: '🟣' },
  'codex': { label: 'Codex CLI', color: '#10b981', icon: '🟢' },
};

export const CodingAgentsBanner: React.FC = () => {
  const [stats, setStats] = useState<CombinedStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`${ENV_CONFIG.backendUrl}/api/coding-agents/stats`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!cancelled) setStats(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Don't render if no data available
  if (!loading && (!stats || stats.agents.length === 0)) return null;

  return (
    <Link
      to="/coding-agents"
      className="group block relative overflow-hidden rounded-xl border border-transparent transition-all duration-300 hover:scale-[1.005] hover:shadow-lg"
    >
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-r from-orange-500/10 via-violet-500/10 to-emerald-500/10 dark:from-orange-500/20 dark:via-violet-500/20 dark:to-emerald-500/20" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background/80" />

      {/* Animated shimmer on hover */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-r from-transparent via-white/5 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />

      <div className="relative p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">AI Dev Tools</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground transition-colors">
            <span>View Analytics</span>
            <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-lg bg-muted/50 animate-pulse" />
            ))}
          </div>
        ) : stats && (
          <>
            {/* Agent Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              {stats.agents.map(agent => {
                const meta = AGENT_META[agent.agent] || { label: agent.agent, color: '#6b7280', icon: '⚪' };
                return (
                  <div
                    key={agent.agent}
                    className="rounded-lg bg-background/60 backdrop-blur-sm border border-border/50 p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: meta.color }}
                      />
                      <span className="text-sm font-medium">{meta.label}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Zap className="h-3 w-3" />
                        <span>{agent.totalSessions} sessions</span>
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <DollarSign className="h-3 w-3" />
                        <span>${agent.totalCost.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>{Math.round(agent.avgSessionMinutes)}m avg</span>
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Terminal className="h-3 w-3" />
                        <span>{agent.activeDays}d active</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Summary footer */}
            <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/30 pt-3">
              <div className="flex items-center gap-4">
                <span><strong className="text-foreground">{stats.totalSessions}</strong> total sessions</span>
                <span><strong className="text-foreground">${stats.totalCost.toFixed(2)}</strong> total cost</span>
                <span><strong className="text-foreground">{(stats.totalTokens / 1_000_000).toFixed(1)}M</strong> tokens</span>
              </div>
            </div>
          </>
        )}
      </div>
    </Link>
  );
};
