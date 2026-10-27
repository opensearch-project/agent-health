/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface RenderErrorBoundaryProps {
  /**
   * Short human label for what failed to render, e.g. "trajectory step 7".
   * Shown in the fallback card so the user knows which section is missing.
   */
  label: string;
  /** Extra classes for the fallback card. */
  className?: string;
  /** Optional hook (tests / telemetry). Defaults to `console.error`. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  children: React.ReactNode;
}

interface RenderErrorBoundaryState {
  error: Error | null;
}

/**
 * Minimal React error boundary for *data-driven* render sections.
 *
 * React unmounts the entire tree up to the nearest boundary when a render
 * throws. The app's routes had no boundary at all, so a single malformed
 * trajectory step (see `lib/trajectoryStepDisplay.ts → stepContentText`)
 * blanked the whole Run inspector / `/runs/:id` page. Wrapping each
 * data-driven section in this boundary turns that into a compact inline card
 * naming the failed section and the error message, while every sibling
 * section keeps rendering.
 *
 * Function components can't implement `componentDidCatch`, hence the class.
 */
export class RenderErrorBoundary extends React.Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RenderErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, info);
    } else {
      console.error(`[RenderErrorBoundary] failed to render ${this.props.label}:`, error, info.componentStack);
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = error.message || String(error);
    return (
      <div
        role="alert"
        data-testid="render-error-boundary"
        className={`rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs ${this.props.className ?? ''}`}
      >
        <div className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span>Couldn&apos;t render {this.props.label}</span>
        </div>
        <pre className="mt-1 font-mono whitespace-pre-wrap break-words text-muted-foreground">{message}</pre>
      </div>
    );
  }
}
