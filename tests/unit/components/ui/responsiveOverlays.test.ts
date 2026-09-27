/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../../');
const read = (relative: string) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

describe('component-scoped responsive overlays', () => {
  it('removes global role and Radix-internal selectors', () => {
    const css = read('index.css');
    expect(css).not.toMatch(/\[role=["']dialog["']\]/);
    expect(css).not.toContain('[data-radix-popper-content-wrapper]');
    expect(css).not.toMatch(/\.mobile-responsive-content \[role=["']tablist["']\]/);
  });

  it.each([
    'components/ui/dialog.tsx',
    'components/ui/alert-dialog.tsx',
    'components/ui/fullscreen-dialog.tsx',
    'components/ui/sheet.tsx',
    'components/assistant-ui/AssistantModal.tsx',
    'components/RunDetailsContent.tsx',
    'components/traces/TraceFullScreenView.tsx',
  ])('keeps mobile viewport bounds on %s', relative => {
    const source = read(relative);
    expect(source).toContain('max-lg:!max-w-[calc(100vw-1rem)]');
    expect(source).toContain('max-lg:!max-h-[calc(100dvh-1rem)]');
    expect(source).toContain('max-lg:overflow-y-auto');
  });

  it.each([
    'components/ui/select.tsx',
    'components/ui/dropdown-menu.tsx',
    'components/ui/tooltip.tsx',
    'components/ui/popover.tsx',
  ])('bounds overlay content without styling a third-party wrapper in %s', relative => {
    expect(read(relative)).toContain('max-lg:max-w-[calc(100vw-0.5rem)]');
  });

  it('owns responsive tab scrolling in the tabs primitive', () => {
    const tabs = read('components/ui/tabs.tsx');
    expect(tabs).toContain('max-lg:overflow-x-auto');
    expect(tabs).toContain('max-lg:shrink-0');
  });
});
