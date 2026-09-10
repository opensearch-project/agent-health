/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReportData, FormatterOutput, FormatterOptions } from '@/services/report/types';
import { BaseFormatter } from '@/services/report/base/BaseFormatter';
import { HtmlFormatter } from '@/services/report/html/HtmlFormatter';

/**
 * Minimum Node.js version required by puppeteer 25+ (engines.node >=22.12.0).
 * npm installs the optional dep on older Node with only an engine warning, so
 * without this guard a Node 20 install fails deep inside puppeteer with an
 * inscrutable syntax/runtime error instead of an actionable message.
 */
const PUPPETEER_MIN_NODE_MAJOR = 22;
const PUPPETEER_MIN_NODE_MINOR = 12;

export function assertNodeSupportsPuppeteer(nodeVersion: string = process.versions.node): void {
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major < PUPPETEER_MIN_NODE_MAJOR || (major === PUPPETEER_MIN_NODE_MAJOR && minor < PUPPETEER_MIN_NODE_MINOR)) {
    throw new Error(
      `PDF generation requires Node.js >=${PUPPETEER_MIN_NODE_MAJOR}.${PUPPETEER_MIN_NODE_MINOR} ` +
      `(puppeteer 25's engine floor), but this process is running Node ${nodeVersion}.\n` +
      'Upgrade Node to 22.12+ to export PDF reports, or use the HTML report format instead — ' +
      'every other agent-health feature is unaffected.'
    );
  }
}

/**
 * Dynamically load puppeteer (optional dependency).
 *
 * In Jest (CJS), bare require() works and jest.mock() intercepts it.
 * In ESM bundles (esbuild), bare require() is unavailable so we dynamically
 * import the esmRequire helper which uses createRequire(import.meta.url).
 */
async function loadPuppeteer(): Promise<any> {
  // Try bare require first — works in Jest CJS and standard Node CJS
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('puppeteer');
  } catch {
    // bare require() unavailable (ESM bundle) — fall through
  }

  // ESM fallback: use createRequire via dynamic import (avoids import.meta at parse time)
  try {
    const { esmRequire } = await import('./esmRequire');
    return esmRequire('puppeteer');
  } catch {
    throw new Error(
      'PDF generation requires puppeteer. Install it with: npm install puppeteer\n' +
      'Note: puppeteer is an optional dependency and only needed for PDF report generation.'
    );
  }
}

/**
 * PDF Report Formatter
 * Converts HTML report to PDF using puppeteer (optional dependency)
 * Node.js only - exported from services/report/server.ts
 */
export class PdfFormatter extends BaseFormatter {
  readonly format = 'pdf' as const;
  readonly name = 'PDF Report';
  readonly extension = 'pdf';

  private htmlFormatter = new HtmlFormatter();

  /**
   * Runtime engine gate, called before puppeteer is loaded. An instance
   * method (not inlined into loadPuppeteer) so unit tests that mock the
   * `puppeteer` module can stub it — CI runs the unit suite on Node 18/20
   * where the real guard must throw.
   */
  protected assertRuntimeSupported(): void {
    assertNodeSupportsPuppeteer();
  }

  async generate(data: ReportData, options?: FormatterOptions): Promise<FormatterOutput> {
    // Fail fast with an actionable message on unsupported Node — BEFORE any
    // HTML rendering or puppeteer loading happens.
    this.assertRuntimeSupported();

    // Generate HTML first
    const htmlOutput = await this.htmlFormatter.generate(data, options);

    // Dynamically load puppeteer
    const puppeteer = await loadPuppeteer();

    // Convert HTML to PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.setContent(htmlOutput.content as string, { waitUntil: 'networkidle0' });

      const pdfBuffer = await page.pdf({
        format: 'A4',
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
        printBackground: true,
      });

      return {
        content: Buffer.from(pdfBuffer),
        mimeType: 'application/pdf',
        filename: this.generateFilename(data.benchmark.name),
      };
    } finally {
      await browser.close();
    }
  }
}

/** Singleton instance */
export const pdfFormatter = new PdfFormatter();
