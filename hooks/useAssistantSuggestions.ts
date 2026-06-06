/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Contextual suggestions + a one-time nudge tooltip for the assistant modal.
 *
 * Behaviour
 * - Suggestions are derived from the current route shape so the user sees
 *   prompts that actually match the page they are on (instead of three
 *   generic ones that tell them nothing about what the assistant is good
 *   at *here*).
 * - When a route has a "moment" (e.g. landed on a failed run), we surface
 *   a single short nudge string above the modal trigger — once per
 *   browser session per route-class via sessionStorage.
 *
 * The hook is intentionally light: no network calls, no run-status
 * polling. Once the user opens the modal we already inject grounded
 * run/benchmark/test-case context server-side; the suggestions only need
 * to *route* the user toward useful questions, not pre-answer them.
 */

export interface AssistantSuggestions {
  /** 3 prompt strings to show as quick-send buttons in the modal's empty state. */
  suggestions: string[];
  /** Optional one-time nudge tooltip shown above the trigger. Cleared after dismissal. */
  nudge: string | null;
  /** Mark the current nudge as seen for this session. */
  dismissNudge: () => void;
}

export interface RouteContext {
  /** Stable identifier used as the sessionStorage key for nudge dedup. */
  key: string;
  suggestions: string[];
  nudge?: string;
}

export const DEFAULT_SUGGESTIONS: string[] = [
  "Explain this benchmark's results",
  'Help me write a test case',
  'What do these traces mean?',
];

export function classifyRoute(pathname: string): RouteContext {
  // Order matters — match more specific routes first.
  // Run detail across both legacy (/runs/:id, /benchmarks/:b/runs/:r) and
  // evals3 (/evaluations/runs/:id, /evaluations/benchmarks/:b/runs/:r/inspect) shapes.
  if (
    /^\/runs\/[^/]+\/?$/.test(pathname) ||
    /^\/benchmarks\/[^/]+\/runs\/[^/]+/.test(pathname) ||
    /^\/evaluations\/runs\/[^/]+/.test(pathname) ||
    /^\/evaluations\/benchmarks\/[^/]+\/runs\/[^/]+/.test(pathname)
  ) {
    return {
      key: 'run-detail',
      suggestions: [
        'Why did this run fail or succeed?',
        'How do I apply the improvement strategies?',
        'What was the agent supposed to do here?',
      ],
      nudge: 'Want me to explain this run?',
    };
  }
  // Benchmark detail (legacy + evals3).
  if (
    /^\/benchmarks\/[^/]+/.test(pathname) ||
    /^\/evaluations\/benchmarks\/[^/]+/.test(pathname)
  ) {
    return {
      key: 'benchmark-detail',
      suggestions: [
        'Which test cases regressed?',
        'Compare these runs by accuracy',
        "What's the highest-priority fix?",
      ],
      nudge: 'Want a read on this benchmark?',
    };
  }
  // Benchmark list (legacy + evals3).
  if (
    /^\/benchmarks\/?$/.test(pathname) ||
    /^\/evaluations\/benchmarks\/?$/.test(pathname)
  ) {
    return {
      key: 'benchmarks-list',
      suggestions: [
        "Which benchmark's struggling most?",
        'Pick a benchmark to start with',
        'Summarize recent benchmark activity',
      ],
    };
  }
  // Test cases (legacy + evals3).
  if (/^\/test-cases\/[^/]+/.test(pathname) || /^\/evaluations\/test-cases\/[^/]+/.test(pathname)) {
    return {
      key: 'test-case-detail',
      suggestions: [
        'Help me improve the expected outcomes',
        'Suggest more edge cases',
        'Convert this to a code-based test',
      ],
      nudge: 'Strengthen this test case?',
    };
  }
  if (/^\/traces\b/.test(pathname) || /^\/agent-traces\b/.test(pathname)) {
    return {
      key: 'traces',
      suggestions: [
        "Where's the bottleneck?",
        'Which LLM call was most expensive?',
        'Explain this span tree',
      ],
      nudge: 'Spot the slow span?',
    };
  }
  if (/^\/settings/.test(pathname)) {
    return {
      key: 'settings',
      suggestions: [
        'How do I add a new agent?',
        'Help me configure OpenSearch storage',
        'How do I write a config file?',
      ],
    };
  }
  if (pathname === '/' || pathname === '') {
    return {
      key: 'dashboard',
      suggestions: [
        'What changed in the last 24 hours?',
        'Which agent is slipping?',
        'What should I focus on today?',
      ],
      nudge: 'Need a quick read on today?',
    };
  }
  return { key: 'default', suggestions: DEFAULT_SUGGESTIONS };
}

const NUDGE_KEY_PREFIX = 'agent-health.assistant-nudge.';

function isNudgeSeen(key: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.sessionStorage.getItem(NUDGE_KEY_PREFIX + key) === '1';
  } catch {
    return true; // sessionStorage blocked — be conservative, don't pester
  }
}

function markNudgeSeen(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(NUDGE_KEY_PREFIX + key, '1');
  } catch {
    /* ignore */
  }
}

export function useAssistantSuggestions(): AssistantSuggestions {
  const location = useLocation();

  const ctx = useMemo(() => classifyRoute(location.pathname), [location.pathname]);

  const [nudgeVisible, setNudgeVisible] = useState<boolean>(() => {
    if (!ctx.nudge) return false;
    return !isNudgeSeen(ctx.key);
  });

  // Re-evaluate when the route changes.
  useEffect(() => {
    if (!ctx.nudge) {
      setNudgeVisible(false);
      return;
    }
    setNudgeVisible(!isNudgeSeen(ctx.key));
  }, [ctx.key, ctx.nudge]);

  // Auto-dismiss after a few seconds so it never blocks anything.
  useEffect(() => {
    if (!nudgeVisible) return;
    const t = window.setTimeout(() => {
      setNudgeVisible(false);
      markNudgeSeen(ctx.key);
    }, 8000);
    return () => window.clearTimeout(t);
  }, [nudgeVisible, ctx.key]);

  return {
    suggestions: ctx.suggestions,
    nudge: nudgeVisible ? (ctx.nudge ?? null) : null,
    dismissNudge: () => {
      setNudgeVisible(false);
      markNudgeSeen(ctx.key);
    },
  };
}
