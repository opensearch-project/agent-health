/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DeepDiveHeaderMetrics — the ComparisonDeepDive ("What's actually
 * different") panel's header: WHICH test case the span-citation tools are
 * scoped to.
 *
 * Owner feedback on the deep-dive panel (screenshot-verified, across two
 * rounds):
 *   1. The panel's "Performance & Outcome" bars showed a bare "100 pts" /
 *      "50 pts" Score row with no unit context, which in a multi-hundred-case
 *      comparison misreads as a CASE COUNT rather than a judge score.
 *   2. That whole bars block was redundant chrome for numbers (duration,
 *      tool calls) already visible elsewhere for the same case.
 *   3. Follow-up round #1: replaced the bars with one compact "Score: N% ·
 *      Duration: … · Tools: …" line instead of a chart.
 *   4. Follow-up round #2 (this round): even that compact line is now
 *      redundant — every one of those metrics (pass rate, accuracy, cost,
 *      duration, tokens, LLM/tool calls) already lives on the scoreboard's
 *      run rows. Drop the metrics line entirely. The "Case: <name>" line
 *      SURVIVES — it still anchors which one case the query_spans/
 *      query_logs tools (and any span citations in the narrative) are
 *      actually scoped to, now that the default prompt discusses the WHOLE
 *      comparison and only traces this one representative case.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';

export interface DeepDiveHeaderMetricsProps {
  /** Name of the ONE test case the trace tools/span citations are scoped to. */
  testCaseName?: string | null;
  /** Id of that test case, for the "view full case" link. Renders as plain text when absent. */
  testCaseId?: string | null;
}

/**
 * Case identity line: "Case: <name>" (linked when an id is known).
 * Renders nothing when there is no case name to show.
 */
export const DeepDiveHeaderMetrics: React.FC<DeepDiveHeaderMetricsProps> = ({
  testCaseName,
  testCaseId,
}) => {
  if (!testCaseName) return null;
  return (
    <p
      className="text-xs font-medium text-foreground/90 flex items-center gap-1 mt-0.5 min-w-0"
      data-testid="deep-dive-case-label"
    >
      <span className="text-muted-foreground font-normal flex-shrink-0">Case:</span>
      {testCaseId ? (
        <Link
          to={`/evaluations/test-cases/${testCaseId}`}
          className="truncate text-opensearch-blue hover:underline inline-flex items-center gap-1 min-w-0"
        >
          <span className="truncate">{testCaseName}</span>
          <ExternalLink size={11} className="flex-shrink-0" />
        </Link>
      ) : (
        <span className="truncate">{testCaseName}</span>
      )}
    </p>
  );
};
