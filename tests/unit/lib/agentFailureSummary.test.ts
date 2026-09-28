/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { presentAgentFailureSummary } from '@/lib/agentFailureSummary';

describe('presentAgentFailureSummary', () => {
  it('breaker-opened summaries on connection failures (or a mixed streak) → "Agent unreachable" badge + endpoint remedy', () => {
    for (const s of [
      'Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, h:1); 2 further cases were not attempted',
      'Agent endpoint unreachable — 3 consecutive agent failures (EMPTY_RESPONSE, h:1)',
    ]) {
      expect(presentAgentFailureSummary(s)).toEqual({
        unreachable: true,
        badge: 'Agent unreachable',
        remedy: 'check the agent endpoint and re-run; nothing was judged.',
      });
    }
  });

  it('a breaker opened on empty responses ALONE → "Empty responses" badge (the endpoint answers) with the not-attempted remedy', () => {
    const p = presentAgentFailureSummary('Agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, h:1); 2 further cases were not attempted');
    expect(p.unreachable).toBe(true);
    expect(p.badge).toBe('Empty responses');
    expect(p.remedy).toContain('remaining cases were not attempted');
    // Singular form too.
    expect(presentAgentFailureSummary('Agent endpoint unreachable — 1 consecutive empty response (EMPTY_RESPONSE, h:1)').badge).toBe('Empty responses');
  });

  it('empty-response count summaries → "Empty responses" badge + a remedy that does not claim nothing was judged', () => {
    const p = presentAgentFailureSummary('2 cases returned an empty response (no steps, no answer, no results) — not judged');
    expect(p.unreachable).toBe(false);
    expect(p.badge).toBe('Empty responses');
    expect(p.remedy).toContain('nothing to judge on these cases');
    expect(p.remedy).not.toContain('nothing was judged');
  });
});
