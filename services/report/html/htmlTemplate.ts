/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReportData, ReportRunData, FormatterOptions } from '@/services/report/types';
import type { TestCaseComparisonRow, TrajectoryStep, EvaluationReport, ImprovementStrategy } from '@/types';
import { getJudgeReasoningText } from '@/lib/matchers/judgeAccessor';

// ============ Utility Functions ============

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a date string for display
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format a percentage value
 */
function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Format a number with K/M suffixes for compact display
 */
export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Format a cost value as USD
 */
function formatCost(value: number | undefined | null): string {
  if (value === undefined || value === null) return '-';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Format milliseconds into a human-readable duration
 */
export function formatDurationMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// ============ SVG / CSS Helper Functions ============

/**
 * Generate an SVG donut chart showing passed vs failed ratio.
 * Uses stroke-dasharray technique on circle elements.
 */
export function generateDonutSvg(passed: number, failed: number, size: number = 120): string {
  const total = passed + failed;
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // Edge case: no results
  if (total === 0) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#D3DAE6" stroke-width="10" />
        <text x="${center}" y="${center}" text-anchor="middle" dominant-baseline="central"
              font-size="16" font-weight="700" fill="#69707D">N/A</text>
      </svg>`;
  }

  const passPercent = Math.round((passed / total) * 100);
  const passLength = (passed / total) * circumference;
  const failLength = (failed / total) * circumference;

  // All pass
  if (failed === 0) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#015aa3" stroke-width="10" />
        <text x="${center}" y="${center}" text-anchor="middle" dominant-baseline="central"
              font-size="16" font-weight="700" fill="#015aa3">100%</text>
      </svg>`;
  }

  // All fail
  if (passed === 0) {
    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#b91c1c" stroke-width="10" />
        <text x="${center}" y="${center}" text-anchor="middle" dominant-baseline="central"
              font-size="16" font-weight="700" fill="#b91c1c">0%</text>
      </svg>`;
  }

  // Mixed results - pass arc starts at top (-90deg rotation), fail arc follows
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#D3DAE6" stroke-width="10" />
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none"
              stroke="#015aa3" stroke-width="10"
              stroke-dasharray="${passLength} ${circumference - passLength}"
              stroke-dashoffset="0"
              transform="rotate(-90 ${center} ${center})" />
      <circle cx="${center}" cy="${center}" r="${radius}" fill="none"
              stroke="#b91c1c" stroke-width="10"
              stroke-dasharray="${failLength} ${circumference - failLength}"
              stroke-dashoffset="${-passLength}"
              transform="rotate(-90 ${center} ${center})" />
      <text x="${center}" y="${center}" text-anchor="middle" dominant-baseline="central"
            font-size="16" font-weight="700" fill="#1a1a1a">${passPercent}%</text>
    </svg>`;
}

/**
 * Generate a small inline SVG check icon
 */
function generateCheckIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:inline-block;vertical-align:middle">
    <circle cx="8" cy="8" r="7" fill="#dcfce7" stroke="#15803d" stroke-width="1"/>
    <path d="M5 8l2 2 4-4" stroke="#15803d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

/**
 * Generate a small inline SVG X icon
 */
function generateXIcon(): string {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="display:inline-block;vertical-align:middle">
    <circle cx="8" cy="8" r="7" fill="#fef2f2" stroke="#b91c1c" stroke-width="1"/>
    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#b91c1c" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

/**
 * Compute an inline background-color for heatmap cells.
 * Port of components/comparison/RunSummaryTable.tsx getHeatmapClass logic.
 */
export function getHeatmapBg(value: number, min: number, max: number, higherIsBetter: boolean = true): string {
  if (min === max) return '';

  let normalized = (value - min) / (max - min);
  if (!higherIsBetter) normalized = 1 - normalized;

  // 5-level quantization matching the UI
  if (normalized >= 0.8) return 'background-color: rgba(16,185,129,0.10)';
  if (normalized >= 0.6) return 'background-color: rgba(16,185,129,0.05)';
  if (normalized >= 0.4) return '';
  if (normalized >= 0.2) return 'background-color: rgba(239,68,68,0.05)';
  return 'background-color: rgba(239,68,68,0.10)';
}

// ============ CSS Styles ============

const CSS_STYLES = `
  :root {
    --os-blue: #015aa3;
    --green-700: #15803d;
    --green-50: #f0fdf4;
    --red-700: #b91c1c;
    --red-50: #fef2f2;
    --amber-600: #d97706;
    --amber-50: #fffbeb;
    --blue-50: #eff6ff;
    --purple-700: #7e22ce;
    --bg: #ffffff;
    --bg-muted: #f5f7fa;
    --text: #1a1a1a;
    --text-muted: #69707D;
    --border: #D3DAE6;
    --shadow: 0 1px 3px rgba(0,0,0,0.08);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 2rem;
  }

  .container { max-width: 1200px; margin: 0 auto; }

  h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; color: var(--text); }
  h2 { font-size: 1.125rem; font-weight: 600; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--border); color: var(--text); }
  h3 { font-size: 0.9375rem; font-weight: 600; margin-bottom: 0.5rem; color: var(--text); }

  /* Card */
  .card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1.25rem;
    margin-bottom: 1rem;
    box-shadow: var(--shadow);
  }

  /* Metric grid */
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.75rem;
  }

  .metric-card {
    background: var(--bg-muted);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    text-align: center;
  }
  .metric-card .metric-label {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
  }
  .metric-card .metric-value {
    font-size: 1.25rem;
    font-weight: 700;
  }
  .metric-card .metric-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.125rem;
  }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid;
  }
  .badge-passed {
    background: var(--green-50);
    color: var(--green-700);
    border-color: rgba(21,128,61,0.25);
  }
  .badge-failed {
    background: var(--red-50);
    color: var(--red-700);
    border-color: rgba(185,28,28,0.25);
  }
  .badge-label {
    background: var(--blue-50);
    color: var(--os-blue);
    border-color: rgba(1,90,163,0.2);
    margin-right: 0.25rem;
  }

  /* Tables */
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.875rem; }
  th {
    background: var(--bg-muted);
    text-align: left;
    padding: 0.625rem 0.75rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border-bottom: 2px solid var(--border);
    font-weight: 600;
  }
  td {
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }
  tr:hover { background: rgba(0,0,0,0.015); }

  /* Progress bar */
  .progress-bar {
    width: 100%;
    height: 0.5rem;
    background: var(--border);
    border-radius: 9999px;
    overflow: hidden;
    margin-top: 0.25rem;
  }
  .progress-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.3s ease;
  }

  /* Trajectory steps */
  .step { margin-bottom: 0.5rem; padding: 0.625rem 0.75rem; border-radius: 0.5rem; border-left: 3px solid; }
  .step-thinking { border-color: var(--amber-600); background: rgba(217,119,6,0.05); }
  .step-action { border-color: #3b82f6; background: rgba(59,130,246,0.05); }
  .step-tool_result { border-color: var(--os-blue); background: rgba(1,90,163,0.05); }
  .step-tool_result.failed { border-color: var(--red-700); background: rgba(185,28,28,0.05); }
  .step-response { border-color: var(--purple-700); background: rgba(126,34,206,0.05); }
  .step-assistant { border-color: var(--purple-700); background: rgba(126,34,206,0.05); }
  .step-type { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 0.25rem; }
  .step-thinking .step-type { color: var(--amber-600); }
  .step-action .step-type { color: #3b82f6; }
  .step-tool_result .step-type { color: var(--os-blue); }
  .step-tool_result.failed .step-type { color: var(--red-700); }
  .step-response .step-type { color: var(--purple-700); }
  .step-assistant .step-type { color: var(--purple-700); }
  .step-content { font-size: 0.8125rem; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; color: var(--text); }

  /* Improvement strategies */
  .strategy { margin-bottom: 0.5rem; padding: 0.625rem 0.75rem; border-radius: 0.5rem; border-left: 4px solid; font-size: 0.8125rem; }
  .strategy-high { background: rgba(185,28,28,0.04); border-color: var(--red-700); }
  .strategy-medium { background: rgba(217,119,6,0.04); border-color: var(--amber-600); }
  .strategy-low { background: rgba(1,90,163,0.04); border-color: var(--os-blue); }
  .strategy-badge {
    display: inline-block;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border: 1px solid;
    margin-right: 0.5rem;
  }
  .strategy-badge-high { background: var(--red-50); color: var(--red-700); border-color: rgba(185,28,28,0.3); }
  .strategy-badge-medium { background: var(--amber-50); color: var(--amber-600); border-color: rgba(217,119,6,0.3); }
  .strategy-badge-low { background: var(--blue-50); color: var(--os-blue); border-color: rgba(1,90,163,0.3); }

  /* Collapsible details */
  details { margin-bottom: 0.75rem; }
  summary {
    cursor: pointer;
    padding: 0.75rem 1rem;
    background: var(--bg-muted);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    font-weight: 500;
    font-size: 0.875rem;
    color: var(--text);
  }
  summary:hover { background: #eef1f5; }
  details[open] summary { border-radius: 0.5rem 0.5rem 0 0; border-bottom-color: transparent; }
  details > .details-content { padding: 1rem; border: 1px solid var(--border); border-top: none; border-radius: 0 0 0.5rem 0.5rem; }

  /* Judge reasoning */
  .judge-reasoning {
    background: var(--bg-muted);
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .truncation-notice { color: var(--text-muted); font-style: italic; font-size: 0.8rem; padding: 0.5rem; }

  /* Executive summary flex layout */
  .exec-summary {
    display: flex;
    align-items: flex-start;
    gap: 1.5rem;
    flex-wrap: wrap;
  }
  .exec-donut { flex-shrink: 0; }
  .exec-metrics { flex: 1; min-width: 280px; }

  /* Run cards grid for multi-run */
  .run-cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
  }
  .run-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1rem;
    box-shadow: var(--shadow);
  }
  .run-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .run-card-name { font-weight: 600; font-size: 0.875rem; color: var(--text); }
  .run-card-meta { font-size: 0.75rem; color: var(--text-muted); }

  /* Header */
  .report-header {
    border-top: 4px solid var(--os-blue);
    background: linear-gradient(180deg, rgba(1,90,163,0.03), transparent);
    border-radius: 0.75rem;
    border: 1px solid var(--border);
    padding: 1.5rem;
    margin-bottom: 1.5rem;
    box-shadow: var(--shadow);
  }
  .header-brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .header-logo {
    width: 36px;
    height: 36px;
    background: var(--os-blue);
    border-radius: 0.375rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 0.875rem;
    flex-shrink: 0;
  }
  .header-titles { display: flex; flex-direction: column; }
  .header-app-name { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); font-weight: 600; }
  .header-meta { color: var(--text-muted); font-size: 0.8125rem; margin-top: 0.25rem; }

  /* Footer */
  .footer {
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
  }

  /* Print / PDF optimization */
  @media print {
    body { padding: 1rem; }
    .card, .run-card, .report-header { box-shadow: none; }
    details[open] summary ~ * { display: block !important; }
    details > summary::marker { display: none; }
    details { break-inside: avoid; }
  }

  /* Status text */
  .text-pass { color: var(--green-700); }
  .text-fail { color: var(--red-700); }
  .text-blue { color: var(--os-blue); }
  .text-amber { color: var(--amber-600); }
  .text-purple { color: var(--purple-700); }
  .text-muted { color: var(--text-muted); }
`;

// ============ Template Sections ============

function renderHeader(data: ReportData, title?: string): string {
  const description = data.benchmark.description
    ? `<p style="color:var(--text-muted);margin-top:0.25rem">${escapeHtml(data.benchmark.description)}</p>`
    : '';

  return `
    <div class="report-header">
      <div class="header-brand">
        <div class="header-logo">AH</div>
        <div class="header-titles">
          <span class="header-app-name">Agent Health</span>
          <h1>${escapeHtml(title || `Benchmark Report: ${data.benchmark.name}`)}</h1>
        </div>
      </div>
      ${description}
      <div class="header-meta">
        Generated ${formatDate(data.generatedAt)} &middot; ${data.runs.length} run${data.runs.length !== 1 ? 's' : ''} &middot; ${data.benchmark.testCaseCount} test case${data.benchmark.testCaseCount !== 1 ? 's' : ''}
      </div>
    </div>
  `;
}

function renderExecutiveSummarySingleRun(run: ReportRunData): string {
  const agg = run.aggregates;
  const donut = generateDonutSvg(agg.passedCount, agg.failedCount, 120);

  const accuracyColor = agg.avgAccuracy >= 80 ? 'var(--os-blue)' : agg.avgAccuracy >= 50 ? 'var(--amber-600)' : 'var(--red-700)';
  const passRateColor = agg.passRatePercent >= 80 ? 'var(--green-700)' : agg.passRatePercent >= 50 ? 'var(--amber-600)' : 'var(--red-700)';

  return `
    <h2>Executive Summary</h2>
    <div class="card">
      <div class="exec-summary">
        <div class="exec-donut">
          ${donut}
          <div style="text-align:center;margin-top:0.25rem">
            <span class="text-pass" style="font-weight:600">${agg.passedCount}P</span>
            <span class="text-muted"> / </span>
            <span class="text-fail" style="font-weight:600">${agg.failedCount}F</span>
          </div>
        </div>
        <div class="exec-metrics">
          <div class="metric-grid">
            <div class="metric-card">
              <div class="metric-label">Pass Rate</div>
              <div class="metric-value" style="color:${passRateColor}">${formatPercent(agg.passRatePercent)}</div>
              <div class="metric-sub">${agg.passedCount} of ${agg.totalTestCases} passed</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Accuracy</div>
              <div class="metric-value" style="color:${accuracyColor}">${formatPercent(agg.avgAccuracy)}</div>
              <div class="progress-bar"><div class="progress-fill" style="width:${Math.round(agg.avgAccuracy)}%;background:${accuracyColor}"></div></div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Agent</div>
              <div class="metric-value" style="font-size:0.9375rem;color:var(--text)">${escapeHtml(run.agentKey)}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Model</div>
              <div class="metric-value" style="font-size:0.9375rem;color:var(--text)">${escapeHtml(run.modelId)}</div>
            </div>
            ${agg.totalTokens !== undefined ? `
            <div class="metric-card">
              <div class="metric-label">Total Tokens</div>
              <div class="metric-value text-blue">${formatNumber(agg.totalTokens)}</div>
            </div>` : ''}
            ${agg.totalCostUsd !== undefined ? `
            <div class="metric-card">
              <div class="metric-label">Total Cost</div>
              <div class="metric-value text-amber">${formatCost(agg.totalCostUsd)}</div>
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderExecutiveSummaryMultiRun(runs: ReportRunData[]): string {
  const cards = runs.map((run, idx) => {
    const agg = run.aggregates;
    const donut = generateDonutSvg(agg.passedCount, agg.failedCount, 80);
    const passRateColor = agg.passRatePercent >= 80 ? 'var(--green-700)' : agg.passRatePercent >= 50 ? 'var(--amber-600)' : 'var(--red-700)';

    return `
      <div class="run-card">
        <div class="run-card-header">
          <div>
            <div class="run-card-name">Run #${idx + 1}: ${escapeHtml(run.name)}</div>
            <div class="run-card-meta">${escapeHtml(run.agentKey)} &middot; ${escapeHtml(run.modelId)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:1rem">
          <div style="flex-shrink:0">${donut}</div>
          <div style="flex:1">
            <div style="margin-bottom:0.375rem">
              <span style="font-size:0.6875rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)">Pass Rate</span>
              <div style="font-size:1.125rem;font-weight:700;color:${passRateColor}">${formatPercent(agg.passRatePercent)}</div>
            </div>
            <div style="margin-bottom:0.375rem">
              <span style="font-size:0.6875rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted)">Accuracy</span>
              <div style="font-size:1.125rem;font-weight:700;color:var(--os-blue)">${formatPercent(agg.avgAccuracy)}</div>
              <div class="progress-bar"><div class="progress-fill" style="width:${Math.round(agg.avgAccuracy)}%;background:var(--os-blue)"></div></div>
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted)">
              <span class="text-pass">${agg.passedCount}P</span> / <span class="text-fail">${agg.failedCount}F</span> of ${agg.totalTestCases}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <h2>Executive Summary</h2>
    <div class="run-cards-grid">${cards}</div>
  `;
}

function renderRunSummaryTable(runs: ReportRunData[]): string {
  const rows = runs.map((run, idx) => {
    const passRateColor = run.aggregates.passRatePercent >= 80 ? 'var(--green-700)' : run.aggregates.passRatePercent >= 50 ? 'var(--amber-600)' : 'var(--red-700)';
    const accuracyColor = run.aggregates.avgAccuracy >= 80 ? 'var(--os-blue)' : run.aggregates.avgAccuracy >= 50 ? 'var(--amber-600)' : 'var(--red-700)';

    return `
    <tr>
      <td style="font-weight:500">#${idx + 1} ${escapeHtml(run.name)}</td>
      <td>${escapeHtml(run.agentKey)}</td>
      <td>${escapeHtml(run.modelId)}</td>
      <td>${formatDate(run.createdAt)}</td>
      <td style="text-align:center;font-weight:600;color:${passRateColor}">${formatPercent(run.aggregates.passRatePercent)}</td>
      <td style="text-align:center;font-weight:600;color:${accuracyColor}">${formatPercent(run.aggregates.avgAccuracy)}</td>
      <td style="text-align:center">
        <span class="text-pass" style="font-weight:600">${run.aggregates.passedCount}</span>
        <span class="text-muted"> / </span>
        <span class="text-fail" style="font-weight:600">${run.aggregates.failedCount}</span>
      </td>
    </tr>
  `;
  }).join('');

  return `
    <h2>Run Summary</h2>
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Agent</th>
          <th>Model</th>
          <th>Date</th>
          <th style="text-align:center">Pass Rate</th>
          <th style="text-align:center">Accuracy</th>
          <th style="text-align:center">Passed / Failed</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderComparisonTable(rows: TestCaseComparisonRow[], runs: ReportRunData[]): string {
  // Compute min/max accuracy for heatmap
  let minAcc = 100;
  let maxAcc = 0;
  for (const row of rows) {
    for (const run of runs) {
      const result = row.results[run.id];
      if (result && result.accuracy !== undefined && result.status !== 'missing') {
        minAcc = Math.min(minAcc, result.accuracy);
        maxAcc = Math.max(maxAcc, result.accuracy);
      }
    }
  }

  const headerCells = runs.map((r, idx) => `<th colspan="2" style="text-align:center">#${idx + 1} ${escapeHtml(r.name)}</th>`).join('');

  const bodyRows = rows.map((row) => {
    const labels = row.labels.map((l) => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join(' ');

    const runCells = runs.map((run) => {
      const result = row.results[run.id];
      if (!result || result.status === 'missing') {
        return '<td colspan="2" style="text-align:center;color:var(--text-muted)">-</td>';
      }
      const isPassed = result.passFailStatus === 'passed';
      const statusHtml = isPassed
        ? `${generateCheckIcon()} <span class="text-pass" style="font-weight:500">PASS</span>`
        : `${generateXIcon()} <span class="text-fail" style="font-weight:500">FAIL</span>`;

      const accuracy = result.accuracy !== undefined ? formatPercent(result.accuracy) : '-';
      const heatmap = result.accuracy !== undefined ? getHeatmapBg(result.accuracy, minAcc, maxAcc, true) : '';
      const heatmapStyle = heatmap ? ` style="text-align:center;${heatmap}"` : ' style="text-align:center"';

      return `<td style="text-align:center">${statusHtml}</td><td${heatmapStyle}><strong>${accuracy}</strong></td>`;
    }).join('');

    return `
      <tr>
        <td style="font-weight:500">${escapeHtml(row.testCaseName)}</td>
        <td>${labels || '<span class="text-muted">-</span>'}</td>
        ${runCells}
      </tr>
    `;
  }).join('');

  return `
    <h2>Per Test Case Comparison</h2>
    <table>
      <thead>
        <tr>
          <th>Test Case</th>
          <th>Labels</th>
          ${headerCells}
        </tr>
        <tr>
          <th></th>
          <th></th>
          ${runs.map(() => '<th style="text-align:center">Status</th><th style="text-align:center">Accuracy</th>').join('')}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

function renderTrajectoryStep(step: TrajectoryStep): string {
  const typeClass = `step-${step.type}`;
  const failedClass = step.type === 'tool_result' && step.status === 'FAILURE' ? ' failed' : '';
  const toolInfo = step.toolName ? ` - ${escapeHtml(step.toolName)}` : '';

  return `
    <div class="step ${typeClass}${failedClass}">
      <div class="step-type">${escapeHtml(step.type)}${toolInfo}</div>
      <div class="step-content">${escapeHtml(step.content || '')}</div>
    </div>
  `;
}

function renderImprovementStrategies(strategies: ImprovementStrategy[]): string {
  if (!strategies || strategies.length === 0) return '';

  const grouped: Record<string, ImprovementStrategy[]> = { high: [], medium: [], low: [] };
  for (const s of strategies) {
    const priority = s.priority || 'medium';
    if (!grouped[priority]) grouped[priority] = [];
    grouped[priority].push(s);
  }

  const renderGroup = (items: ImprovementStrategy[], priority: string): string => {
    if (items.length === 0) return '';
    return items.map((s) => `
      <div class="strategy strategy-${priority}">
        <span class="strategy-badge strategy-badge-${priority}">${escapeHtml(priority)}</span>
        <strong>${escapeHtml(s.category)}</strong>: ${escapeHtml(s.issue)}
        <br><span class="text-muted" style="font-size:0.8125rem">Recommendation: ${escapeHtml(s.recommendation)}</span>
      </div>
    `).join('');
  };

  return `
    <h3>Improvement Strategies</h3>
    ${renderGroup(grouped.high, 'high')}
    ${renderGroup(grouped.medium, 'medium')}
    ${renderGroup(grouped.low, 'low')}
  `;
}

function renderTestCaseDetails(
  rows: TestCaseComparisonRow[],
  runs: ReportRunData[],
  reports: Record<string, EvaluationReport>,
  options?: FormatterOptions
): string {
  const maxSteps = options?.maxTrajectorySteps ?? 50;
  const includeTrajectories = options?.includeTrajectories !== false;

  const details = rows.map((row) => {
    // Compute aggregate pass/fail for this test case across runs
    let tcPassed = 0;
    let tcFailed = 0;
    for (const run of runs) {
      const result = row.results[run.id];
      if (result && result.status !== 'missing') {
        if (result.passFailStatus === 'passed') tcPassed++;
        else tcFailed++;
      }
    }

    const runDetails = runs.map((run) => {
      const result = row.results[run.id];
      if (!result || result.status === 'missing' || !result.reportId) return '';

      const report = reports[result.reportId];
      if (!report) return '';

      let trajectoryHtml = '';
      if (includeTrajectories && report.trajectory?.length > 0) {
        const steps = report.trajectory.slice(0, maxSteps);
        const truncated = report.trajectory.length - steps.length;
        trajectoryHtml = `
          <h3>Trajectory (${report.trajectory.length} steps)</h3>
          ${steps.map(renderTrajectoryStep).join('')}
          ${truncated > 0 ? `<div class="truncation-notice">${truncated} more steps not shown</div>` : ''}
        `;
      }

      const reasoningText = getJudgeReasoningText(report);
      const reasoning = reasoningText
        ? `<h3>Judge Reasoning</h3><div class="judge-reasoning">${escapeHtml(reasoningText)}</div>`
        : '';

      const strategies = renderImprovementStrategies(report.improvementStrategies || []);

      const isPassed = report.passFailStatus === 'passed';
      const statusBadge = isPassed
        ? '<span class="badge badge-passed">PASSED</span>'
        : '<span class="badge badge-failed">FAILED</span>';

      const accuracy = report.metrics?.accuracy ?? 0;
      const accuracyColor = accuracy >= 80 ? 'var(--os-blue)' : accuracy >= 50 ? 'var(--amber-600)' : 'var(--red-700)';

      return `
        <div class="card" style="margin-top:0.5rem">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
            <h3 style="margin-bottom:0">${escapeHtml(run.name)} ${statusBadge}</h3>
            <span style="font-weight:700;color:${accuracyColor}">${formatPercent(accuracy)}</span>
          </div>
          <div class="progress-bar" style="margin-bottom:0.75rem"><div class="progress-fill" style="width:${Math.round(accuracy)}%;background:${accuracyColor}"></div></div>
          ${reasoning}
          ${strategies}
          ${trajectoryHtml}
        </div>
      `;
    }).join('');

    if (!runDetails.trim()) return '';

    const labels = row.labels.map((l) => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join(' ');
    const summaryStats = `<span class="text-muted" style="font-size:0.8125rem;margin-left:0.5rem">${tcPassed}P / ${tcFailed}F</span>`;

    return `
      <details>
        <summary>${escapeHtml(row.testCaseName)} ${labels}${summaryStats}</summary>
        <div class="details-content">
          ${runDetails}
        </div>
      </details>
    `;
  }).join('');

  if (!details.trim()) return '';

  return `
    <h2>Test Case Details</h2>
    ${details}
  `;
}

// ============ Single-Run vs Multi-Run Content ============

function renderSingleRunContent(data: ReportData, options?: FormatterOptions): string {
  const run = data.runs[0];

  // For single run, render a flat test case results table instead of comparison
  const testCaseRows = data.comparisonRows.map((row) => {
    const result = row.results[run.id];
    if (!result || result.status === 'missing') {
      return `
        <tr>
          <td style="font-weight:500">${escapeHtml(row.testCaseName)}</td>
          <td>${row.labels.map((l) => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join(' ') || '<span class="text-muted">-</span>'}</td>
          <td style="text-align:center" class="text-muted">-</td>
          <td style="text-align:center" class="text-muted">-</td>
        </tr>`;
    }

    const isPassed = result.passFailStatus === 'passed';
    const statusHtml = isPassed
      ? `${generateCheckIcon()} <span class="text-pass" style="font-weight:500">PASS</span>`
      : `${generateXIcon()} <span class="text-fail" style="font-weight:500">FAIL</span>`;
    const accuracy = result.accuracy !== undefined ? formatPercent(result.accuracy) : '-';

    return `
      <tr>
        <td style="font-weight:500">${escapeHtml(row.testCaseName)}</td>
        <td>${row.labels.map((l) => `<span class="badge badge-label">${escapeHtml(l)}</span>`).join(' ') || '<span class="text-muted">-</span>'}</td>
        <td style="text-align:center">${statusHtml}</td>
        <td style="text-align:center"><strong>${accuracy}</strong></td>
      </tr>`;
  }).join('');

  const testCaseTable = `
    <h2>Test Case Results</h2>
    <table>
      <thead>
        <tr>
          <th>Test Case</th>
          <th>Labels</th>
          <th style="text-align:center">Status</th>
          <th style="text-align:center">Accuracy</th>
        </tr>
      </thead>
      <tbody>${testCaseRows}</tbody>
    </table>
  `;

  return `
    ${renderExecutiveSummarySingleRun(run)}
    ${testCaseTable}
    ${renderTestCaseDetails(data.comparisonRows, data.runs, data.reports, options)}
  `;
}

function renderMultiRunContent(data: ReportData, options?: FormatterOptions): string {
  return `
    ${renderExecutiveSummaryMultiRun(data.runs)}
    ${renderRunSummaryTable(data.runs)}
    ${renderComparisonTable(data.comparisonRows, data.runs)}
    ${renderTestCaseDetails(data.comparisonRows, data.runs, data.reports, options)}
  `;
}

// ============ Main Template ============

/**
 * Generate a complete self-contained HTML report
 */
export function generateHtmlReport(data: ReportData, options?: FormatterOptions): string {
  const title = options?.title || `Benchmark Report: ${data.benchmark.name}`;
  const isSingleRun = data.runs.length === 1;

  const content = isSingleRun
    ? renderSingleRunContent(data, options)
    : renderMultiRunContent(data, options);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${CSS_STYLES}</style>
</head>
<body>
  <div class="container">
    ${renderHeader(data, options?.title)}
    ${content}
    <div class="footer">
      Generated by Agent Health &middot; ${formatDate(data.generatedAt)}
    </div>
  </div>
</body>
</html>`;
}
