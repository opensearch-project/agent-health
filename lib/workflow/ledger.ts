/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FeedbackLedger — cumulative, append-only human steering for one workflow run.
 *
 * This is the upgrade over a single-shot `--feedback` flag: a correction given
 * on ticket #3 is appended here and injected into the agent's context for
 * tickets #4..#N (steering compounds), and the whole ledger is embedded into
 * the consolidated PR bodies as rationale.
 */

export interface LedgerEntry {
  at: string;
  text: string;
  ticketId?: string;
  source: 'human' | 'signal' | 'system';
}

export class FeedbackLedger {
  private entries: LedgerEntry[] = [];

  /** Append a correction. Defaults to a human-sourced entry. */
  append(text: string, opts: { ticketId?: string; source?: LedgerEntry['source'] } = {}): void {
    const trimmed = text?.trim();
    if (!trimmed) return;
    this.entries.push({
      at: new Date().toISOString(),
      text: trimmed,
      ticketId: opts.ticketId,
      source: opts.source ?? 'human',
    });
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Rendered block — injected into each subsequent agent run as context and
   * embedded into PR bodies. Empty string when there's nothing to say.
   */
  render(): string {
    if (this.entries.length === 0) return '';
    const lines = this.entries.map((e, i) => {
      const tag = e.ticketId ? `[${e.ticketId}] ` : '';
      return `${i + 1}. ${tag}${e.text}`;
    });
    return ['## Cumulative feedback (steers this run)', ...lines].join('\n');
  }
}
