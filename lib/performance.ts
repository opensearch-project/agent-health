/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Performance Measurement Utilities
 *
 * Provides instrumentation for measuring and logging performance metrics
 * in both development and production environments.
 */

import { isDebugEnabled } from './debug';

interface PerformanceMark {
  name: string;
  startTime: number;
}

export interface PerformanceMetric {
  name: string;
  duration: number;
  timestamp: number;
}

// In-memory storage for performance marks and metrics
const marks = new Map<string, PerformanceMark>();
const metrics: PerformanceMetric[] = [];

// Listeners notified whenever a metric is recorded or the list is cleared
// (the debug latency HUD re-renders from this instead of polling).
type MetricsListener = () => void;
let metricsListeners: MetricsListener[] = [];

function notifyMetricsListeners(): void {
  for (const l of metricsListeners) l();
}

/**
 * Subscribe to metric changes (a measurement ended / metrics cleared).
 * Returns an unsubscribe function.
 */
export function subscribeToMetrics(fn: MetricsListener): () => void {
  metricsListeners.push(fn);
  return () => {
    metricsListeners = metricsListeners.filter(l => l !== fn);
  };
}

// Performance monitoring enabled in development, when the app's debug mode
// (lib/debug.ts, the Settings "Verbose Logging" toggle) is on, or when the
// legacy `DEBUG_PERFORMANCE` flag is set.
const isEnabled = () => {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('DEBUG_PERFORMANCE') === 'true' ||
           isDebugEnabled() ||
           process.env.NODE_ENV === 'development';
  }
  return process.env.DEBUG_PERFORMANCE === 'true' ||
         process.env.NODE_ENV === 'development';
};

/**
 * Start a performance measurement
 */
export function startMeasure(name: string): void {
  if (!isEnabled()) return;

  marks.set(name, {
    name,
    startTime: performance.now(),
  });
}

/**
 * End a performance measurement and log the duration
 */
export function endMeasure(name: string, logToConsole = true): number | null {
  if (!isEnabled()) return null;

  const mark = marks.get(name);
  if (!mark) {
    console.warn(`[Performance] No start mark found for: ${name}`);
    return null;
  }

  const duration = performance.now() - mark.startTime;
  const metric: PerformanceMetric = {
    name,
    duration,
    timestamp: Date.now(),
  };

  metrics.push(metric);
  marks.delete(name);
  notifyMetricsListeners();

  if (logToConsole) {
    const color = duration < 50 ? '🟢' : duration < 200 ? '🟡' : '🔴';
    console.log(
      `[Performance] ${color} ${name}: ${duration.toFixed(2)}ms`
    );
  }

  return duration;
}

/**
 * Measure a synchronous function
 */
export function measureSync<T>(name: string, fn: () => T, logToConsole = true): T {
  if (!isEnabled()) return fn();

  startMeasure(name);
  try {
    return fn();
  } finally {
    endMeasure(name, logToConsole);
  }
}

/**
 * Measure an async function
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>,
  logToConsole = true
): Promise<T> {
  if (!isEnabled()) return fn();

  startMeasure(name);
  try {
    return await fn();
  } finally {
    endMeasure(name, logToConsole);
  }
}

/**
 * Get all recorded metrics
 */
export function getMetrics(): PerformanceMetric[] {
  return [...metrics];
}

/**
 * Get metrics for a specific measurement name
 */
export function getMetricsByName(name: string): PerformanceMetric[] {
  return metrics.filter(m => m.name === name);
}

/**
 * Get average duration for a metric
 */
export function getAverageDuration(name: string): number | null {
  const metricsForName = getMetricsByName(name);
  if (metricsForName.length === 0) return null;

  const sum = metricsForName.reduce((acc, m) => acc + m.duration, 0);
  return sum / metricsForName.length;
}

/**
 * Clear all metrics
 */
export function clearMetrics(): void {
  metrics.length = 0;
  marks.clear();
  notifyMetricsListeners();
}

/**
 * Log a summary of all metrics
 */
export function logSummary(): void {
  if (!isEnabled() || metrics.length === 0) return;

  console.group('📊 Performance Summary');

  // Group metrics by name
  const grouped = new Map<string, PerformanceMetric[]>();
  metrics.forEach(m => {
    if (!grouped.has(m.name)) {
      grouped.set(m.name, []);
    }
    grouped.get(m.name)!.push(m);
  });

  // Calculate stats for each metric
  grouped.forEach((metricsForName, name) => {
    const durations = metricsForName.map(m => m.duration);
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);

    console.log(
      `${name}:`,
      `avg=${avg.toFixed(2)}ms`,
      `min=${min.toFixed(2)}ms`,
      `max=${max.toFixed(2)}ms`,
      `count=${metricsForName.length}`
    );
  });

  console.groupEnd();
}

/**
 * Enable performance monitoring
 */
export function enable(): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem('DEBUG_PERFORMANCE', 'true');
  } else {
    process.env.DEBUG_PERFORMANCE = 'true';
  }
  console.log('✅ Performance monitoring enabled');
}

/**
 * Disable performance monitoring
 */
export function disable(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('DEBUG_PERFORMANCE');
  } else {
    delete process.env.DEBUG_PERFORMANCE;
  }
  console.log('❌ Performance monitoring disabled');
}
