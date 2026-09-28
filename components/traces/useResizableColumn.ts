/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useResizableColumn — drag-to-resize width for the span label column shared
 * by the trace tree table and the timeline chart. Drag with the mouse or use
 * ArrowLeft / ArrowRight on the focused handle; the width is clamped to
 * [min, max] and reset to the default on double-click (or Home).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Span } from '@/types';

export interface NameColumnEstimate {
  /** Horizontal indent per tree depth. */
  indentPx: number;
  /** Fixed per-row chrome next to the name (caret / icon / time cell / padding). */
  fixedPx: number;
  /** Average glyph width at the row's font size. */
  charPx: number;
  min: number;
  max: number;
}

/**
 * Initial name-column width sized from the longest span name at its depth so
 * typical `execute_tool <name>` rows are not ellipsized out of the box, while
 * the cap keeps the timeline bars visible at laptop widths. Dragging the
 * handle overrides it.
 */
export function estimateNameColumnWidth(spanTree: Span[], opts: NameColumnEstimate): number {
  let widest = 0;
  const walk = (spans: Span[], depth: number) => {
    for (const s of spans) {
      widest = Math.max(widest, depth * opts.indentPx + (s.name?.length || 0) * opts.charPx);
      if (s.children?.length) walk(s.children, depth + 1);
    }
  };
  walk(spanTree, 0);
  return Math.round(Math.max(opts.min, Math.min(opts.max, widest + opts.fixedPx)));
}

export interface ResizableColumn {
  width: number;
  isResizing: boolean;
  /** Spread onto the drag handle element. */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    tabIndex: 0;
    role: 'separator';
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    'aria-label': string;
    title: string;
  };
}

const KEY_STEP_PX = 16;

export function useResizableColumn(defaultWidth: number, min: number, max: number, label = 'Resize name column'): ResizableColumn {
  // The default is read once on mount; a user's drag sticks for the life of
  // the component, and double-click / Home brings the default back.
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // the timeline chart pans on mousedown — don't start a pan
    drag.current = { startX: e.clientX, startWidth: width };
    setIsResizing(true);
  }, [width]);

  const onDoubleClick = useCallback(() => setWidth(defaultWidth), [defaultWidth]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' ? KEY_STEP_PX : e.key === 'ArrowLeft' ? -KEY_STEP_PX : 0;
    if (delta !== 0) {
      e.preventDefault();
      setWidth(w => Math.max(min, Math.min(max, w + delta)));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(defaultWidth);
    }
  }, [min, max, defaultWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      const next = drag.current.startWidth + (e.clientX - drag.current.startX);
      setWidth(Math.max(min, Math.min(max, next)));
    };
    const up = () => {
      drag.current = null;
      setIsResizing(false);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, min, max]);

  return {
    width,
    isResizing,
    handleProps: {
      onMouseDown,
      onDoubleClick,
      onKeyDown,
      tabIndex: 0,
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-label': label,
      title: 'Drag or use ← → to resize · double-click to reset',
    },
  };
}
