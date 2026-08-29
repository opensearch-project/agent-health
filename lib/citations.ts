/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export type ParsedCitation =
  | { type: 'step'; stepNumber: number }
  | { type: 'span'; runId: string; spanId: string };

/** Parse the citation schemes emitted by agent-health judges. */
export function parseCitationHref(href?: string): ParsedCitation | null {
  if (!href) return null;

  const step = /^step:(\d+)$/i.exec(href);
  if (step) return { type: 'step', stepNumber: Number(step[1]) };

  // Comparison and trace judges cite spans as
  // [human label](span:<runId>:<spanId>).
  const span = /^span:([^:]+):(.+)$/.exec(href);
  if (span) return { type: 'span', runId: span[1], spanId: span[2] };

  return null;
}

/**
 * Turn plain `Step N` references into the same custom-link form used by span
 * citations. Existing Markdown links and code are left untouched, and a step
 * outside the trajectory range remains plain text rather than a dead link.
 */
export function linkifyStepCitations(markdown: string, stepCount: number): string {
  if (!markdown || stepCount <= 0) return markdown;

  const protectedMarkdown = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]]*\]\([^)]+\))/g;
  return markdown
    .split(protectedMarkdown)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/\b(Step\s+(\d+))\b/gi, (match, label: string, number: string) => {
        const stepNumber = Number(number);
        return stepNumber >= 1 && stepNumber <= stepCount
          ? `[${label}](step:${stepNumber})`
          : match;
      });
    })
    .join('');
}

/** Keep custom citation schemes while retaining ReactMarkdown's XSS boundary. */
export function sanitizeCitationUrl(url: string): string {
  if (!url) return '';
  const value = url.trim();
  if (/^step:\d+$/i.test(value) || /^span:[^:]+:.+$/i.test(value)) return value;
  return /^(https?:|mailto:|\/|#|\.{1,2}\/)/i.test(value) ? value : '';
}
