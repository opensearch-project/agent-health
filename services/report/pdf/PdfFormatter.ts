/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReportData, FormatterOutput, FormatterOptions } from '@/services/report/types';
import { BaseFormatter } from '@/services/report/base/BaseFormatter';
import { HtmlFormatter } from '@/services/report/html/HtmlFormatter';

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
  } catch (err: any) {
    // puppeteer >= 25 is ESM-only and supports Node >= 22.12; on older Node the
    // optional dependency is skipped at install time (or, if force-installed,
    // cannot be require()d), so say so instead of a bare module-not-found.
    throw new Error(
      'PDF generation requires puppeteer. Install it with: npm install puppeteer\n' +
      'Note: puppeteer is an optional dependency and only needed for PDF report generation. ' +
      `It needs Node >= 22.12 (running ${process.version}). ` +
      `(${err?.message ?? String(err)})`
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

  async generate(data: ReportData, options?: FormatterOptions): Promise<FormatterOutput> {
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
