/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest mock for lib/config
 * Provides test-friendly defaults without import.meta
 */

export interface EnvConfig {
  backendUrl: string;
  judgeApiUrl: string;
  storageApiUrl: string;
  agentProxyUrl: string;
  openSearchProxyUrl: string;
  awsRegion: string;
  awsProfile: string;
  bedrockModelId: string;
  openSearchLogsEndpoint: string;
  openSearchLogsUsername: string;
  openSearchLogsPassword: string;
  openSearchLogsTracesIndex: string;
  openSearchLogsIndex: string;
  mlcommonsEndpoint: string;
  mlcommonsHeaderOpenSearchUrl: string;
  mlcommonsHeaderAuthorization: string;
  mlcommonsHeaderAwsRegion: string;
  mlcommonsHeaderAwsServiceName: string;
  mlcommonsHeaderAwsAccessKeyId: string;
  mlcommonsHeaderAwsSecretAccessKey: string;
  mlcommonsHeaderAwsSessionToken: string;
  travelPlannerEndpoint: string;
  claudeCodeTelemetryEnabled: boolean;
  otelExporterEndpoint: string;
  otelServiceName: string;
  otelExporterProtocol: string;
  otelExporterHeaders: string;
}

const BACKEND_URL = 'http://localhost:4001';

export const ENV_CONFIG: EnvConfig = {
  backendUrl: BACKEND_URL,
  judgeApiUrl: `${BACKEND_URL}/api/judge`,
  storageApiUrl: `${BACKEND_URL}/api/storage`,
  agentProxyUrl: `${BACKEND_URL}/api/agent`,
  openSearchProxyUrl: `${BACKEND_URL}/api/opensearch/logs`,
  awsRegion: 'us-east-1',
  awsProfile: 'default',
  bedrockModelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  openSearchLogsEndpoint: '',
  openSearchLogsUsername: '',
  openSearchLogsPassword: '',
  openSearchLogsTracesIndex: 'otel-v1-apm-span-*',
  openSearchLogsIndex: 'ml-commons-logs-*',
  mlcommonsEndpoint: 'http://localhost:9200/_plugins/_ml/agents/{agent_id}/_execute/stream',
  mlcommonsHeaderOpenSearchUrl: '',
  mlcommonsHeaderAuthorization: '',
  mlcommonsHeaderAwsRegion: '',
  mlcommonsHeaderAwsServiceName: 'es',
  mlcommonsHeaderAwsAccessKeyId: '',
  mlcommonsHeaderAwsSecretAccessKey: '',
  mlcommonsHeaderAwsSessionToken: '',
  travelPlannerEndpoint: 'http://localhost:3000',
  claudeCodeTelemetryEnabled: false,
  otelExporterEndpoint: '',
  otelServiceName: 'claude-code-agent',
  otelExporterProtocol: '',
  otelExporterHeaders: '',
};

export function buildMLCommonsHeaders(): Record<string, string> {
  return {};
}
