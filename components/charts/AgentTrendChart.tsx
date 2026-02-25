/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { formatCost, formatTokens, formatDuration } from '@/services/metrics';
import { TrendDataPoint, getAgentColor, getAgentDisplayName } from '@/lib/dashboardMetrics';

export type TrendMetric = 'passRate' | 'cost' | 'tokens' | 'latency';

interface AgentTrendChartProps {
  data: TrendDataPoint[];
  metric: TrendMetric;
  height?: number | string;
}

interface ChartDataPoint {
  date: string;
  [agentKey: string]: number | string;
}

const METRIC_CONFIG: Record<TrendMetric, {
  dataKey: keyof TrendDataPoint;
  label: string;
  formatter: (value: number) => string;
  unit: string;
}> = {
  passRate: {
    dataKey: 'passRate',
    label: 'Pass Rate',
    formatter: (value: number) => `${value.toFixed(1)}%`,
    unit: '%',
  },
  cost: {
    dataKey: 'avgCostUsd',
    label: 'Avg Cost',
    formatter: (value: number) => formatCost(value),
    unit: '$',
  },
  tokens: {
    dataKey: 'avgTokens',
    label: 'Avg Tokens',
    formatter: (value: number) => formatTokens(value),
    unit: '',
  },
  latency: {
    dataKey: 'avgDurationMs',
    label: 'Avg Latency',
    formatter: (value: number) => formatDuration(value),
    unit: 'ms',
  },
};

/**
 * Transform trend data into chart-friendly format.
 * Groups data points by date, with each agent as a separate series.
 */
function transformDataForChart(
  data: TrendDataPoint[],
  metric: TrendMetric
): { chartData: ChartDataPoint[]; agents: string[] } {
  const config = METRIC_CONFIG[metric];
  const dataKey = config.dataKey;

  // Get unique dates and agents
  const dates = [...new Set(data.map(d => d.date))].sort();
  const agents = [...new Set(data.map(d => d.agentKey))];

  // Create chart data with one entry per date
  const chartData: ChartDataPoint[] = dates.map(date => {
    const point: ChartDataPoint = { date };

    // Add value for each agent on this date
    for (const agent of agents) {
      const dataPoint = data.find(d => d.date === date && d.agentKey === agent);
      point[agent] = dataPoint ? (dataPoint[dataKey] as number) : 0;
    }

    return point;
  });

  return { chartData, agents };
}

/**
 * Format date for x-axis display
 */
function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const AgentTrendChart: React.FC<AgentTrendChartProps> = ({
  data,
  metric,
  height = "100%",
}) => {
  const config = METRIC_CONFIG[metric];
  
  // Ensure height is in the correct format for ResponsiveContainer
  const chartHeight = typeof height === 'number' ? height : height as `${number}%` | '100%';

  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground text-sm"
        style={{ height }}
      >
        No data available for the selected time range
      </div>
    );
  }

  const { chartData, agents } = transformDataForChart(data, metric);

  // If only one data point, show a message
  if (chartData.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground text-sm"
        style={{ height }}
      >
        Need at least 2 data points to show trend
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={chartHeight}>
      <LineChart
        data={chartData}
        margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 12 }}
          className="text-muted-foreground"
          tickLine={false}
          axisLine={false}
          tickFormatter={formatDateLabel}
        />
        <YAxis
          tick={{ fontSize: 12 }}
          className="text-muted-foreground"
          tickFormatter={config.formatter}
          tickLine={false}
          axisLine={false}
          width={70}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
          }}
          labelStyle={{ color: 'hsl(var(--foreground))' }}
          labelFormatter={(label) => formatDateLabel(label as string)}
          formatter={(value: number, name: string) => [
            config.formatter(value),
            getAgentDisplayName(name),
          ]}
        />
        <Legend
          wrapperStyle={{ paddingTop: '10px' }}
          formatter={(value) => (
            <span className="text-sm text-muted-foreground">
              {getAgentDisplayName(value)}
            </span>
          )}
        />
        {agents.map((agent) => (
          <Line
            key={agent}
            type="monotone"
            dataKey={agent}
            name={agent}
            stroke={getAgentColor(agent)}
            strokeWidth={2}
            dot={{ fill: getAgentColor(agent), strokeWidth: 2, r: 4 }}
            activeDot={{ r: 6, strokeWidth: 0 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
};
