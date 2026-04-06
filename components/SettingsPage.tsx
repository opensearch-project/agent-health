/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, Trash2, Database, CheckCircle2, XCircle, Upload, Download, Loader2, Server, Plus, Edit2, X, Save, ExternalLink, Eye, EyeOff, ChevronDown, ChevronRight, RefreshCw, Palette, Circle } from 'lucide-react';
import { getTheme, setTheme, type Theme } from '@/lib/theme';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { ConnectorProtocol, ClusterAuthType } from '@/types';
import { CONNECTOR_TYPE_INFO } from '@/lib/constants';
import { storageAdmin } from '@/services/storage/opensearchClient';
import {
  hasLocalStorageData,
  getLocalStorageCounts,
  migrateToOpenSearch,
  exportLocalStorageData,
  clearLocalStorageData,
  MigrationStats,
} from '@/services/storage';
import {
  getConfigStatus,
  saveStorageConfig,
  saveObservabilityConfig,
  clearStorageConfig,
  clearObservabilityConfig,
  retryStorageConnection,
  useFileStorage,
  type ConfigStatus,
  type SaveStorageConfigResult,
} from '@/lib/dataSourceConfig';
import { DEFAULT_CONFIG, refreshConfig } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';

interface StorageStats {
  testCases: number;
  experiments: number;
  runs: number;
  analytics: number;
  isConnected: boolean;
}

interface AgentEndpoint {
  id: string;
  name: string;
  endpoint: string;
  connectorType?: ConnectorProtocol;
  useTraces?: boolean;
}

const LEGACY_STORAGE_KEY = 'agenteval_custom_endpoints';

/**
 * Derive the custom endpoint list from DEFAULT_CONFIG.agents (populated by refreshConfig).
 */
function getCustomEndpointsFromConfig(): AgentEndpoint[] {
  return DEFAULT_CONFIG.agents
    .filter(a => a.isCustom)
    .map(a => ({
      id: a.key,
      name: a.name,
      endpoint: a.endpoint,
      connectorType: a.connectorType,
      useTraces: a.useTraces,
    }));
}

export const SettingsPage: React.FC = () => {

  const [debugMode, setDebugMode] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<Theme>('dark');
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Migration state
  const [hasLocalData, setHasLocalData] = useState(false);
  const [localCounts, setLocalCounts] = useState<{ testCases: number; experiments: number; reports: number } | null>(null);
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState<string>('');
  const [migrationResult, setMigrationResult] = useState<MigrationStats | null>(null);

  // Agent endpoints state
  const [customEndpoints, setCustomEndpoints] = useState<AgentEndpoint[]>([]);
  const [isAddingEndpoint, setIsAddingEndpoint] = useState(false);
  const [editingEndpointId, setEditingEndpointId] = useState<string | null>(null);
  const [newEndpointName, setNewEndpointName] = useState('');
  const [newEndpointUrl, setNewEndpointUrl] = useState('');
  const [newConnectorType, setNewConnectorType] = useState<ConnectorProtocol>('agui-streaming');
  const [newUseTraces, setNewUseTraces] = useState(false);
  const [endpointUrlError, setEndpointUrlError] = useState<string | null>(null);
  const [showBuiltInAgents, setShowBuiltInAgents] = useState(false);

  // Data source configuration state (form inputs - not stored values)
  const [storageConfig, setStorageConfigState] = useState({
    endpoint: '',
    authType: 'basic' as ClusterAuthType,
    username: '',
    password: '',
    awsProfile: '',
    awsRegion: '',
    awsService: 'es' as 'es' | 'aoss',
    tlsSkipVerify: false,
  });
  const [observabilityConfig, setObservabilityConfigState] = useState({
    endpoint: '',
    authType: 'basic' as ClusterAuthType,
    username: '',
    password: '',
    awsProfile: '',
    awsRegion: '',
    awsService: 'es' as 'es' | 'aoss',
    tlsSkipVerify: false,
    tracesIndex: '',
    logsIndex: '',
    metricsIndex: '',
  });
  // Server-side config status (source of truth - no credentials)
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [showStoragePassword, setShowStoragePassword] = useState(false);
  const [showObservabilityPassword, setShowObservabilityPassword] = useState(false);
  const [showAdvancedIndexes, setShowAdvancedIndexes] = useState(false);
  const [storageTestStatus, setStorageTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [storageTestMessage, setStorageTestMessage] = useState('');
  const [observabilityTestStatus, setObservabilityTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [observabilityTestMessage, setObservabilityTestMessage] = useState('');

  // Index fix modal state
  const [indexFixState, setIndexFixState] = useState<{
    visible: boolean;
    progress: Array<{ indexName: string; status: string; documentCount?: number; error?: string }>;
    done: boolean;
    error?: string;
  }>({ visible: false, progress: [], done: false });

  const loadStorageStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const health = await storageAdmin.health();
      const stats = await storageAdmin.stats();

      setStorageStats({
        testCases: stats.stats.evals_test_cases?.count || 0,
        experiments: stats.stats.evals_experiments?.count || 0,
        runs: stats.stats.evals_runs?.count || 0,
        analytics: stats.stats.evals_analytics?.count || 0,
        isConnected: health.status === 'connected' || health.status === 'ok',
      });
    } catch (error) {
      console.error('Failed to load storage stats:', error);
      setStorageStats({
        testCases: 0,
        experiments: 0,
        runs: 0,
        analytics: 0,
        isConnected: false,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Sentinel value used in the password field to mean "a password is stored on
  // the server; the user has not changed it yet."  It is never sent to the server —
  // we convert it back to undefined so the server-side ?? merge keeps the stored value.
  const PASSWORD_STORED_SENTINEL = '__STORED__';

  // Load config status from server
  const loadConfigStatus = useCallback(async () => {
    try {
      const status = await getConfigStatus();
      setConfigStatus(status);
      // Pre-fill form with endpoint + username; use sentinel for password when stored.
      if (status.storage.endpoint) {
        setStorageConfigState(prev => ({
          ...prev,
          endpoint: status.storage.endpoint || '',
          authType: status.storage.authType || 'basic',
          username: status.storage.username || '',
          password: status.storage.hasPassword ? PASSWORD_STORED_SENTINEL : '',
          awsProfile: status.storage.awsProfile || '',
          awsRegion: status.storage.awsRegion || '',
          awsService: status.storage.awsService || 'es',
        }));
      }
      if (status.observability.endpoint) {
        setObservabilityConfigState(prev => ({
          ...prev,
          endpoint: status.observability.endpoint || '',
          authType: status.observability.authType || 'basic',
          username: status.observability.username || '',
          password: status.observability.hasPassword ? PASSWORD_STORED_SENTINEL : '',
          awsProfile: status.observability.awsProfile || '',
          awsRegion: status.observability.awsRegion || '',
          awsService: status.observability.awsService || 'es',
          tracesIndex: status.observability.indexes?.traces || '',
          logsIndex: status.observability.indexes?.logs || '',
          metricsIndex: status.observability.indexes?.metrics || '',
        }));
      }
    } catch (error) {
      console.error('Failed to load config status:', error);
    }
  }, []);

  // Scroll to section if URL hash is present (e.g., /settings#storage)
  const location = useLocation();
  const hasScrolled = useRef(false);
  useEffect(() => {
    if (location.hash && !hasScrolled.current) {
      const id = location.hash.replace('#', '');
      // Delay to allow the page to render before scrolling
      const timer = setTimeout(() => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          hasScrolled.current = true;
        }
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [location.hash, isLoading]);

  useEffect(() => {
    // Load debug state from server API (single source of truth: agent-health.config.json)
    // and sync to localStorage for fast browser-side checks
    fetch(`${ENV_CONFIG.backendUrl}/api/debug`)
      .then(res => res.json())
      .then(data => {
        setDebugMode(data.enabled);
        localStorage.setItem('agenteval_debug', String(data.enabled));

        // IMPORTANT: Also sync DEBUG_PERFORMANCE with debug mode state
        if (data.enabled) {
          localStorage.setItem('DEBUG_PERFORMANCE', 'true');
        } else {
          localStorage.removeItem('DEBUG_PERFORMANCE');
        }
      })
      .catch(() => {
        // Fallback to localStorage if API fails
        try {
          const cached = localStorage.getItem('agenteval_debug') === 'true';
          setDebugMode(cached);

          // Also sync DEBUG_PERFORMANCE
          if (cached) {
            localStorage.setItem('DEBUG_PERFORMANCE', 'true');
          } else {
            localStorage.removeItem('DEBUG_PERFORMANCE');
          }
        } catch {
          setDebugMode(false);
          localStorage.removeItem('DEBUG_PERFORMANCE');
        }
      });

    setCurrentTheme(getTheme());
    loadStorageStats();
    loadConfigStatus();

    // Check for localStorage data to migrate
    const hasData = hasLocalStorageData();
    setHasLocalData(hasData);
    if (hasData) {
      setLocalCounts(getLocalStorageCounts());
    }

    // Migrate legacy localStorage custom endpoints to server, then derive from config
    const initCustomEndpoints = async () => {
      try {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
          const legacyEndpoints: AgentEndpoint[] = JSON.parse(legacy);
          for (const ep of legacyEndpoints) {
            try {
              await fetch(`${ENV_CONFIG.backendUrl}/api/agents/custom`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: ep.name, endpoint: ep.endpoint }),
              });
            } catch {
              // Best effort — skip endpoints that fail to migrate
            }
          }
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      } catch {
        // Ignore parse errors on legacy data
      }

      await refreshConfig();
      setCustomEndpoints(getCustomEndpointsFromConfig());
    };

    initCustomEndpoints();
  }, [loadStorageStats, loadConfigStatus]);

  // Validate URL format
  const validateEndpointUrl = (url: string): string | null => {
    if (!url.trim()) return 'URL is required';
    try {
      const parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'URL must use http or https protocol';
      }
      return null;
    } catch {
      return 'Invalid URL format';
    }
  };

  // Agent endpoints handlers
  const handleAddEndpoint = async () => {
    if (!newEndpointName.trim() || !newEndpointUrl.trim()) return;

    const urlError = validateEndpointUrl(newEndpointUrl);
    if (urlError) {
      setEndpointUrlError(urlError);
      return;
    }

    try {
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/agents/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newEndpointName.trim(),
          endpoint: newEndpointUrl.trim(),
          connectorType: newConnectorType,
          useTraces: newUseTraces,
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        setEndpointUrlError(err.error || 'Failed to add endpoint');
        return;
      }
      await refreshConfig();
      setCustomEndpoints(getCustomEndpointsFromConfig());
    } catch (error) {
      setEndpointUrlError(error instanceof Error ? error.message : 'Failed to add endpoint');
      return;
    }

    setNewEndpointName('');
    setNewEndpointUrl('');
    setNewConnectorType('agui-streaming');
    setNewUseTraces(false);
    setEndpointUrlError(null);
    setIsAddingEndpoint(false);
  };

  const handleUpdateEndpoint = async (id: string) => {
    if (!newEndpointName.trim() || !newEndpointUrl.trim()) return;

    const urlError = validateEndpointUrl(newEndpointUrl);
    if (urlError) {
      setEndpointUrlError(urlError);
      return;
    }

    try {
      // Delete the old one, then create a new one
      await fetch(`${ENV_CONFIG.backendUrl}/api/agents/custom/${id}`, { method: 'DELETE' });
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/agents/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newEndpointName.trim(),
          endpoint: newEndpointUrl.trim(),
          connectorType: newConnectorType,
          useTraces: newUseTraces,
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        setEndpointUrlError(err.error || 'Failed to update endpoint');
        return;
      }
      await refreshConfig();
      setCustomEndpoints(getCustomEndpointsFromConfig());
    } catch (error) {
      setEndpointUrlError(error instanceof Error ? error.message : 'Failed to update endpoint');
      return;
    }

    setEditingEndpointId(null);
    setNewEndpointName('');
    setNewEndpointUrl('');
    setNewConnectorType('agui-streaming');
    setNewUseTraces(false);
    setEndpointUrlError(null);
  };

  const handleDeleteEndpoint = async (id: string) => {
    if (!window.confirm('Remove this endpoint?')) return;

    try {
      await fetch(`${ENV_CONFIG.backendUrl}/api/agents/custom/${id}`, { method: 'DELETE' });
      await refreshConfig();
      setCustomEndpoints(getCustomEndpointsFromConfig());
    } catch (error) {
      console.error('Failed to delete custom endpoint:', error);
    }
  };

  const startEditEndpoint = (endpoint: AgentEndpoint) => {
    setEditingEndpointId(endpoint.id);
    setNewEndpointName(endpoint.name);
    setNewEndpointUrl(endpoint.endpoint);
    setNewConnectorType(endpoint.connectorType ?? 'agui-streaming');
    setNewUseTraces(endpoint.useTraces ?? false);
  };

  const cancelEdit = () => {
    setEditingEndpointId(null);
    setIsAddingEndpoint(false);
    setNewEndpointName('');
    setNewEndpointUrl('');
    setNewConnectorType('agui-streaming');
    setNewUseTraces(false);
    setEndpointUrlError(null);
  };

  const handleDebugToggle = async (checked: boolean) => {
    // Update local state immediately for responsiveness
    setDebugMode(checked);

    // Update localStorage for BOTH debug logging AND performance monitoring
    try {
      localStorage.setItem('agenteval_debug', String(checked));

      // Also control performance monitoring with the same toggle
      if (checked) {
        localStorage.setItem('DEBUG_PERFORMANCE', 'true');
      } else {
        localStorage.removeItem('DEBUG_PERFORMANCE');
      }
    } catch {
      // Ignore localStorage errors
    }

    // Persist to server (agent-health.config.json) - single source of truth
    try {
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked }),
      });

      if (!response.ok) {
        throw new Error('Failed to update debug mode');
      }

      const data = await response.json();
      setDebugMode(data.enabled); // Sync with server's actual state
      localStorage.setItem('agenteval_debug', String(data.enabled)); // Sync localStorage too

      // Sync performance monitoring too
      if (data.enabled) {
        localStorage.setItem('DEBUG_PERFORMANCE', 'true');
      } else {
        localStorage.removeItem('DEBUG_PERFORMANCE');
      }
    } catch (error) {
      console.error('Failed to toggle debug mode:', error);
      // Revert to server state on error
      fetch(`${ENV_CONFIG.backendUrl}/api/debug`)
        .then(res => res.json())
        .then(data => {
          setDebugMode(data.enabled);
          localStorage.setItem('agenteval_debug', String(data.enabled));
          if (data.enabled) {
            localStorage.setItem('DEBUG_PERFORMANCE', 'true');
          } else {
            localStorage.removeItem('DEBUG_PERFORMANCE');
          }
        })
        .catch(() => {}); // Ignore fetch error, keep local state
    }
  };

  const handleThemeChange = (theme: Theme) => {
    setTheme(theme);
    setCurrentTheme(theme);
  };

  const handleMigrate = async () => {
    if (!window.confirm('Migrate localStorage data to OpenSearch? Existing items will be skipped.')) {
      return;
    }

    setIsMigrating(true);
    setMigrationStatus('Starting migration...');
    setMigrationResult(null);

    try {
      const stats = await migrateToOpenSearch({
        skipExisting: true,
        onProgress: (message) => setMigrationStatus(message),
      });

      setMigrationResult(stats);
      setMigrationStatus('Migration complete!');

      // Reload stats
      loadStorageStats();
      setLocalCounts(getLocalStorageCounts());
      setHasLocalData(hasLocalStorageData());
    } catch (error) {
      setMigrationStatus(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsMigrating(false);
    }
  };

  const handleExportLocalData = () => {
    const json = exportLocalStorageData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agenteval-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLocalData = () => {
    if (!window.confirm('Clear all localStorage data? This cannot be undone. Make sure you have migrated or exported your data first.')) {
      return;
    }

    clearLocalStorageData();
    setHasLocalData(false);
    setLocalCounts(null);
    setMigrationResult(null);
    setMigrationStatus('');
  };

  // Data source configuration handlers
  const handleTestStorageConnection = async () => {
    if (!storageConfig.endpoint) {
      setStorageTestStatus('error');
      setStorageTestMessage('Endpoint URL is required');
      return;
    }

    setStorageTestStatus('testing');
    setStorageTestMessage('Testing connection...');

    try {
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: storageConfig.endpoint,
          authType: storageConfig.authType !== 'basic' ? storageConfig.authType : undefined,
          username: storageConfig.username || undefined,
          // Strip sentinel — server will use its stored password for the test
          password: storageConfig.password === PASSWORD_STORED_SENTINEL
            ? undefined
            : (storageConfig.password || undefined),
          awsProfile: storageConfig.awsProfile || undefined,
          awsRegion: storageConfig.awsRegion || undefined,
          awsService: storageConfig.awsService !== 'es' ? storageConfig.awsService : undefined,
          tlsSkipVerify: storageConfig.tlsSkipVerify || undefined,
        }),
      });

      if (!response.ok && response.status === 0) {
        setStorageTestStatus('error');
        setStorageTestMessage('Could not reach the backend server. Make sure it is running.');
        return;
      }

      const result = await response.json().catch(() => null);
      if (!result) {
        setStorageTestStatus('error');
        setStorageTestMessage(`Backend returned an invalid response (HTTP ${response.status}). Make sure the server is running.`);
        return;
      }
      if (result.status === 'ok') {
        setStorageTestStatus('success');
        setStorageTestMessage(`Connected to ${result.clusterName || 'cluster'} (${result.clusterStatus})`);
      } else {
        setStorageTestStatus('error');
        setStorageTestMessage(result.message || 'Connection failed');
      }
    } catch (error) {
      setStorageTestStatus('error');
      setStorageTestMessage(error instanceof Error ? error.message : 'Connection test failed');
    }
  };

  const handleSaveStorageConfig = async () => {
    if (!storageConfig.endpoint) {
      alert('Endpoint URL is required');
      return;
    }

    try {
      // Strip sentinel — an unchanged sentinel means "keep whatever is stored";
      // the server-side ?? merge will preserve it.
      const storagePasswordToSend = storageConfig.password === PASSWORD_STORED_SENTINEL
        ? undefined
        : (storageConfig.password || undefined);

      const result = await saveStorageConfig({
        endpoint: storageConfig.endpoint,
        authType: storageConfig.authType !== 'basic' ? storageConfig.authType : undefined,
        username: storageConfig.username || undefined,
        password: storagePasswordToSend,
        awsProfile: storageConfig.awsProfile || undefined,
        awsRegion: storageConfig.awsRegion || undefined,
        awsService: storageConfig.awsService !== 'es' ? storageConfig.awsService : undefined,
        tlsSkipVerify: storageConfig.tlsSkipVerify,
      });

      // Show fix results in modal if reindexing was performed
      if (result.fixResults && result.fixResults.length > 0) {
        setIndexFixState({
          visible: true,
          progress: result.fixResults,
          done: true,
        });
      }

      setStorageTestStatus('idle');
      setStorageTestMessage('Configuration saved to server');
      // Reload to re-apply sentinel state for any stored credentials
      loadStorageStats();
      loadConfigStatus();
      setTimeout(() => setStorageTestMessage(''), 3000);
    } catch (error) {
      setStorageTestStatus('error');
      setStorageTestMessage(error instanceof Error ? error.message : 'Failed to save configuration');
    }
  };

  const handleClearStorageConfig = async () => {
    if (!window.confirm('Clear storage configuration? Will fall back to environment variables.')) {
      return;
    }
    try {
      await clearStorageConfig();
      setStorageConfigState({ endpoint: '', authType: 'basic', username: '', password: '', awsProfile: '', awsRegion: '', awsService: 'es', tlsSkipVerify: false });
      setStorageTestStatus('idle');
      setStorageTestMessage('Configuration cleared - using environment variables');
      setTimeout(() => setStorageTestMessage(''), 3000);
      loadStorageStats();
      loadConfigStatus();
    } catch (error) {
      setStorageTestStatus('error');
      setStorageTestMessage(error instanceof Error ? error.message : 'Failed to clear configuration');
    }
  };

  const handleTestObservabilityConnection = async () => {
    if (!observabilityConfig.endpoint) {
      setObservabilityTestStatus('error');
      setObservabilityTestMessage('Endpoint URL is required');
      return;
    }

    setObservabilityTestStatus('testing');
    setObservabilityTestMessage('Testing connection...');

    try {
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/observability/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: observabilityConfig.endpoint,
          authType: observabilityConfig.authType !== 'basic' ? observabilityConfig.authType : undefined,
          username: observabilityConfig.username || undefined,
          // Strip sentinel — server will use its stored password for the test
          password: observabilityConfig.password === PASSWORD_STORED_SENTINEL
            ? undefined
            : (observabilityConfig.password || undefined),
          awsProfile: observabilityConfig.awsProfile || undefined,
          awsRegion: observabilityConfig.awsRegion || undefined,
          awsService: observabilityConfig.awsService !== 'es' ? observabilityConfig.awsService : undefined,
          tlsSkipVerify: observabilityConfig.tlsSkipVerify || undefined,
          indexes: {
            traces: observabilityConfig.tracesIndex || undefined,
            logs: observabilityConfig.logsIndex || undefined,
            metrics: observabilityConfig.metricsIndex || undefined,
          },
        }),
      });

      if (!response.ok && response.status === 0) {
        setObservabilityTestStatus('error');
        setObservabilityTestMessage('Could not reach the backend server. Make sure it is running.');
        return;
      }

      const result = await response.json().catch(() => null);
      if (!result) {
        setObservabilityTestStatus('error');
        setObservabilityTestMessage(`Backend returned an invalid response (HTTP ${response.status}). Make sure the server is running.`);
        return;
      }
      if (result.status === 'ok') {
        setObservabilityTestStatus('success');
        const msg = result.message
          ? `Connected to ${result.clusterName || 'cluster'}. ${result.message}`
          : `Connected to ${result.clusterName || 'cluster'} (${result.clusterStatus})`;
        setObservabilityTestMessage(msg);
      } else {
        setObservabilityTestStatus('error');
        setObservabilityTestMessage(result.message || 'Connection failed');
      }
    } catch (error) {
      setObservabilityTestStatus('error');
      setObservabilityTestMessage(error instanceof Error ? error.message : 'Connection test failed');
    }
  };

  const handleSaveObservabilityConfig = async () => {
    if (!observabilityConfig.endpoint) {
      alert('Endpoint URL is required');
      return;
    }

    try {
      // Strip sentinel — same logic as storage save above.
      const obsPasswordToSend = observabilityConfig.password === PASSWORD_STORED_SENTINEL
        ? undefined
        : (observabilityConfig.password || undefined);

      await saveObservabilityConfig({
        endpoint: observabilityConfig.endpoint,
        authType: observabilityConfig.authType !== 'basic' ? observabilityConfig.authType : undefined,
        username: observabilityConfig.username || undefined,
        password: obsPasswordToSend,
        awsProfile: observabilityConfig.awsProfile || undefined,
        awsRegion: observabilityConfig.awsRegion || undefined,
        awsService: observabilityConfig.awsService !== 'es' ? observabilityConfig.awsService : undefined,
        tlsSkipVerify: observabilityConfig.tlsSkipVerify,
        indexes: {
          traces: observabilityConfig.tracesIndex || undefined,
          logs: observabilityConfig.logsIndex || undefined,
          metrics: observabilityConfig.metricsIndex || undefined,
        },
      });
      setObservabilityTestStatus('idle');
      setObservabilityTestMessage('Configuration saved to server');
      // Reload to re-apply sentinel state for any stored credentials
      loadConfigStatus();
      setTimeout(() => setObservabilityTestMessage(''), 3000);
    } catch (error) {
      setObservabilityTestStatus('error');
      setObservabilityTestMessage(error instanceof Error ? error.message : 'Failed to save configuration');
    }
  };

  const handleClearObservabilityConfig = async () => {
    if (!window.confirm('Clear observability configuration? Will fall back to environment variables.')) {
      return;
    }
    try {
      await clearObservabilityConfig();
      setObservabilityConfigState({
        endpoint: '',
        authType: 'basic',
        username: '',
        password: '',
        awsProfile: '',
        awsRegion: '',
        awsService: 'es',
        tlsSkipVerify: false,
        tracesIndex: '',
        logsIndex: '',
        metricsIndex: '',
      });
      setObservabilityTestStatus('idle');
      setObservabilityTestMessage('Configuration cleared - using environment variables');
      setTimeout(() => setObservabilityTestMessage(''), 3000);
      loadConfigStatus();
    } catch (error) {
      setObservabilityTestStatus('error');
      setObservabilityTestMessage(error instanceof Error ? error.message : 'Failed to clear configuration');
    }
  };

  return (
    <>
    <div className="p-6 max-w-4xl mx-auto" data-testid="settings-page">
      <h2 className="text-2xl font-bold mb-6" data-testid="settings-title">Settings</h2>

      {/* Preferences */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette size={18} />
            Preferences
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <Label className="text-sm font-medium">Theme</Label>
            <div className="flex gap-3">
              <Button
                variant={currentTheme === 'light' ? 'default' : 'outline'}
                onClick={() => handleThemeChange('light')}
                className="flex-1"
              >
                Light Mode
              </Button>
              <Button
                variant={currentTheme === 'dark' ? 'default' : 'outline'}
                onClick={() => handleThemeChange('dark')}
                className="flex-1"
              >
                Dark Mode
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose your preferred color theme for the interface
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Agent Endpoints */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server size={18} />
            Agent Endpoints
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Built-in Agents (collapsible) */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowBuiltInAgents(!showBuiltInAgents)}
              className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wide hover:text-foreground"
            >
              {showBuiltInAgents ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Built-in Agents ({DEFAULT_CONFIG.agents.filter(a => !a.isCustom).length})
            </button>

            {showBuiltInAgents && DEFAULT_CONFIG.agents.filter(a => !a.isCustom).map((agent) => (
              <div
                key={agent.key}
                className="p-3 border rounded-lg bg-muted/5 flex items-start justify-between gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm flex items-center gap-2">
                    {agent.name}
                    <span className="text-xs px-2 py-1 rounded inline-block bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700/50">
                      built-in
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-1">
                    <ExternalLink size={10} />
                    {agent.endpoint || <span className="italic">Not configured</span>}
                  </div>
                  {agent.description && (
                    <div className="text-xs text-muted-foreground mt-1">{agent.description}</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Custom Endpoints Section */}
          <div className="border-t pt-4 mt-4">
            <div className="flex items-center justify-between mb-3">
              <Label className="text-xs text-muted-foreground uppercase tracking-wide">Custom Endpoints</Label>
              {!isAddingEndpoint && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsAddingEndpoint(true)}
                >
                  <Plus size={14} className="mr-1" />
                  Add
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Add custom agent endpoints. These are persisted to agent-health.config.json in your project directory.
            </p>
          </div>

          {/* Add new endpoint form */}
          {isAddingEndpoint && (
            <div className="p-4 border rounded-lg bg-muted/20 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-endpoint-name" className="text-xs">Name</Label>
                <Input
                  id="new-endpoint-name"
                  placeholder="My Agent"
                  value={newEndpointName}
                  onChange={(e) => setNewEndpointName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-endpoint-url" className="text-xs">Endpoint URL</Label>
                <Input
                  id="new-endpoint-url"
                  placeholder="http://localhost:3000/api/agent"
                  value={newEndpointUrl}
                  onChange={(e) => {
                    setNewEndpointUrl(e.target.value);
                    setEndpointUrlError(null);
                  }}
                  className={endpointUrlError ? 'border-red-500' : ''}
                />
                {endpointUrlError && (
                  <p className="text-xs text-red-500">{endpointUrlError}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Connector Type</Label>
                <Select value={newConnectorType} onValueChange={(v) => setNewConnectorType(v as ConnectorProtocol)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(CONNECTOR_TYPE_INFO) as [ConnectorProtocol, typeof CONNECTOR_TYPE_INFO[ConnectorProtocol]][]).map(([type, info]) => (
                      <SelectItem key={type} value={type}>
                        {type === 'agui-streaming' ? `${type} (default)` : type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {CONNECTOR_TYPE_INFO[newConnectorType] ? (
                  <>
                    <p className="text-xs text-muted-foreground">{CONNECTOR_TYPE_INFO[newConnectorType].description}</p>
                    {CONNECTOR_TYPE_INFO[newConnectorType].serverOnly && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">Server-only — runs via CLI or benchmark runner, not from the browser UI.</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-amber-600 dark:text-amber-400">Unknown connector type: {newConnectorType}. Please select a supported connector type.</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="new-use-traces"
                  checked={newUseTraces}
                  onCheckedChange={setNewUseTraces}
                />
                <Label htmlFor="new-use-traces" className="text-xs">Enable Traces</Label>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddEndpoint} disabled={!newEndpointName.trim() || !newEndpointUrl.trim()}>
                  <Save size={14} className="mr-1" />
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEdit}>
                  <X size={14} className="mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* List of custom endpoints */}
          {customEndpoints.length > 0 ? (
            <div className="space-y-2">
              {customEndpoints.map((ep) => (
                <div
                  key={ep.id}
                  className="p-3 border rounded-lg bg-muted/10 flex items-start justify-between gap-3"
                >
                  {editingEndpointId === ep.id ? (
                    <div className="flex-1 space-y-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Name</Label>
                        <Input
                          value={newEndpointName}
                          onChange={(e) => setNewEndpointName(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Endpoint URL</Label>
                        <Input
                          value={newEndpointUrl}
                          onChange={(e) => {
                            setNewEndpointUrl(e.target.value);
                            setEndpointUrlError(null);
                          }}
                          className={endpointUrlError ? 'border-red-500' : ''}
                        />
                        {endpointUrlError && (
                          <p className="text-xs text-red-500">{endpointUrlError}</p>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Connector Type</Label>
                        <Select value={newConnectorType} onValueChange={(v) => setNewConnectorType(v as ConnectorProtocol)}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(Object.entries(CONNECTOR_TYPE_INFO) as [ConnectorProtocol, typeof CONNECTOR_TYPE_INFO[ConnectorProtocol]][]).map(([type, info]) => (
                              <SelectItem key={type} value={type}>
                                {type === 'agui-streaming' ? `${type} (default)` : type}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {CONNECTOR_TYPE_INFO[newConnectorType] ? (
                          <>
                            <p className="text-xs text-muted-foreground">{CONNECTOR_TYPE_INFO[newConnectorType].description}</p>
                            {CONNECTOR_TYPE_INFO[newConnectorType].serverOnly && (
                              <p className="text-xs text-amber-600 dark:text-amber-400">Server-only — runs via CLI or benchmark runner, not from the browser UI.</p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-amber-600 dark:text-amber-400">Unknown connector type: {newConnectorType}. Please select a supported connector type.</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`edit-use-traces-${ep.id}`}
                          checked={newUseTraces}
                          onCheckedChange={setNewUseTraces}
                        />
                        <Label htmlFor={`edit-use-traces-${ep.id}`} className="text-xs">Enable Traces</Label>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleUpdateEndpoint(ep.id)}>
                          <Save size={14} className="mr-1" />
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={cancelEdit}>
                          <X size={14} className="mr-1" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{ep.name}</div>
                        <div className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-1">
                          <ExternalLink size={10} />
                          {ep.endpoint}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                          <span>{ep.connectorType ?? 'agui-streaming'}</span>
                          {ep.useTraces && <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-900 border border-green-300 dark:bg-green-950/50 dark:text-green-300 dark:border-green-700/50">traces</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEditEndpoint(ep)}
                        >
                          <Edit2 size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteEndpoint(ep.id)}
                          className="text-red-400 hover:text-red-300"
                          aria-label={`Remove ${ep.name}`}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            !isAddingEndpoint && (
              <div className="text-center py-6 text-muted-foreground text-sm">
                No custom endpoints configured.
                <br />
                <span className="text-xs">Click "Add Endpoint" to configure a new agent endpoint.</span>
              </div>
            )
          )}

          <Alert className="bg-blue-50 border-blue-200 dark:bg-blue-900/10 dark:border-blue-700/20">
            <AlertDescription className="text-xs text-blue-700 dark:text-blue-300">
              Custom endpoints will appear in the agent selector during evaluations.
              For authentication, use environment variables in the server configuration.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Evaluation Storage Configuration */}
      <Card id="storage" className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database size={18} />
            Evaluation Storage
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Test cases, experiments, and run results.
            Uses local filesystem (<code className="text-xs bg-muted/50 px-1 rounded">agent-health-data/</code>) if not configured.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Optionally configure an OpenSearch cluster for persistent storage. Credentials are stored on the server (in agent-health.config.json), not in your browser.
          </p>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="storage-endpoint" className="text-xs">Endpoint URL</Label>
              <Input
                id="storage-endpoint"
                placeholder="https://opensearch.example.com:9200"
                value={storageConfig.endpoint}
                onChange={(e) => setStorageConfigState({ ...storageConfig, endpoint: e.target.value })}
              />
            </div>

            {/* Authentication Type */}
            <div className="space-y-1.5">
              <Label className="text-xs">Authentication Type</Label>
              <Select
                value={storageConfig.authType}
                onValueChange={(v) => setStorageConfigState({ ...storageConfig, authType: v as ClusterAuthType })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Auth</SelectItem>
                  <SelectItem value="basic">Basic Auth (username/password)</SelectItem>
                  <SelectItem value="sigv4">AWS SigV4</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {storageConfig.authType === 'none' ? (
              /* No Auth - no credentials needed */
              <div className="space-y-3 p-3 border rounded-lg bg-muted/10">
                <p className="text-xs text-muted-foreground">
                  No authentication — connects directly without credentials. Suitable for local development clusters.
                </p>
              </div>
            ) : storageConfig.authType === 'basic' ? (
              /* Basic Auth fields */
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="storage-username" className="text-xs">Username (optional)</Label>
                  <Input
                    id="storage-username"
                    placeholder="Leave blank to use env var"
                    value={storageConfig.username}
                    onChange={(e) => setStorageConfigState({ ...storageConfig, username: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="storage-password" className="text-xs">Password (optional)</Label>
                  <div className="relative">
                    <Input
                      id="storage-password"
                      type={showStoragePassword ? 'text' : 'password'}
                      placeholder={storageConfig.password === PASSWORD_STORED_SENTINEL ? '••••••••' : 'Leave blank to use env var'}
                      value={storageConfig.password === PASSWORD_STORED_SENTINEL ? '' : storageConfig.password}
                      onChange={(e) => setStorageConfigState({ ...storageConfig, password: e.target.value })}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowStoragePassword(!showStoragePassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showStoragePassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {storageConfig.password === PASSWORD_STORED_SENTINEL && (
                    <p className="text-xs text-muted-foreground">Password stored — leave blank to keep it, or type a new one to replace it</p>
                  )}
                </div>
              </div>
            ) : (
              /* AWS SigV4 fields */
              <div className="space-y-3 p-3 border rounded-lg bg-muted/10">
                <p className="text-xs text-muted-foreground">
                  Uses the AWS credential chain (env vars, ~/.aws/credentials, IAM role, etc.)
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="storage-aws-region" className="text-xs">AWS Region (required)</Label>
                    <Input
                      id="storage-aws-region"
                      placeholder="us-east-1"
                      value={storageConfig.awsRegion}
                      onChange={(e) => setStorageConfigState({ ...storageConfig, awsRegion: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="storage-aws-profile" className="text-xs">AWS Profile (optional)</Label>
                    <Input
                      id="storage-aws-profile"
                      placeholder="default"
                      value={storageConfig.awsProfile}
                      onChange={(e) => setStorageConfigState({ ...storageConfig, awsProfile: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">AWS Service</Label>
                  <Select
                    value={storageConfig.awsService}
                    onValueChange={(v) => setStorageConfigState({ ...storageConfig, awsService: v as 'es' | 'aoss' })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="es">es (Managed OpenSearch)</SelectItem>
                      <SelectItem value="aoss">aoss (Serverless)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* TLS Verification Toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="storage-tls-skip" className="text-xs">Skip TLS Verification</Label>
                <p className="text-xs text-muted-foreground">Enable for self-signed certificates</p>
              </div>
              <Switch
                id="storage-tls-skip"
                checked={storageConfig.tlsSkipVerify}
                onCheckedChange={(checked) => setStorageConfigState({ ...storageConfig, tlsSkipVerify: checked })}
              />
            </div>
          </div>

          {/* Config source indicator */}
          {configStatus?.storage && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Currently configured via:</span>
              <span className={`px-2 py-0.5 rounded ${
                configStatus.storage.source === 'file'
                  ? 'bg-green-100 text-green-900 border border-green-300 dark:bg-green-950/50 dark:text-green-300 dark:border-green-700/50'
                  : configStatus.storage.source === 'environment'
                  ? 'bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700/50'
                  : 'bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700/50'
              }`}>
                {configStatus.storage.source === 'file' ? 'Config file (agent-health.config.json)' :
                 configStatus.storage.source === 'environment' ? 'Environment variables' :
                 'Not configured'}
              </span>
            </div>
          )}

          {/* Runtime storage state */}
          {configStatus?.runtime?.storage.backend === 'error' && (
            <Alert variant="destructive" className="py-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span className="text-sm">
                  Storage configured but unreachable: {configStatus.runtime.storage.error}
                </span>
                <span className="flex gap-2 ml-4 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await retryStorageConnection();
                        const status = await getConfigStatus();
                        setConfigStatus(status);
                      } catch (e: any) {
                        console.error('Retry failed:', e.message);
                      }
                    }}
                  >
                    <RefreshCw size={14} className="mr-1" />
                    Retry
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await useFileStorage();
                        const status = await getConfigStatus();
                        setConfigStatus(status);
                      } catch (e: any) {
                        console.error('Use file storage failed:', e.message);
                      }
                    }}
                  >
                    <Database size={14} className="mr-1" />
                    Use File Storage
                  </Button>
                </span>
              </AlertDescription>
            </Alert>
          )}

          {configStatus?.runtime?.storage.drifted && configStatus.runtime.storage.backend !== 'error' && (
            <Alert className="py-2 border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/20">
              <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
              <AlertDescription className="flex items-center justify-between">
                <span className="text-sm text-yellow-800 dark:text-yellow-300">
                  Config file changed. Runtime storage may be out of date.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-4 shrink-0"
                  onClick={async () => {
                    try {
                      await retryStorageConnection();
                      const status = await getConfigStatus();
                      setConfigStatus(status);
                    } catch (e: any) {
                      console.error('Apply failed:', e.message);
                    }
                  }}
                >
                  <RefreshCw size={14} className="mr-1" />
                  Apply Now
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {configStatus?.runtime?.storage && !configStatus.runtime.storage.drifted && configStatus.runtime.storage.backend !== 'error' && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Runtime:</span>
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded ${
                configStatus.runtime.storage.backend === 'opensearch'
                  ? 'bg-green-100 text-green-900 border border-green-300 dark:bg-green-950/50 dark:text-green-300 dark:border-green-700/50'
                  : 'bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700/50'
              }`}>
                {configStatus.runtime.storage.backend === 'opensearch' && <CheckCircle2 size={12} />}
                {configStatus.runtime.storage.backend === 'opensearch'
                  ? `OpenSearch (${configStatus.runtime.storage.configuredEndpoint})`
                  : 'File Storage'}
              </span>
            </div>
          )}

          {/* Test connection status */}
          {storageTestMessage && (
            <div className={`flex items-center gap-2 text-sm ${
              storageTestStatus === 'success' ? 'text-green-400' :
              storageTestStatus === 'error' ? 'text-red-400' :
              storageTestStatus === 'testing' ? 'text-blue-400' : 'text-muted-foreground'
            }`}>
              {storageTestStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
              {storageTestStatus === 'success' && <CheckCircle2 size={14} />}
              {storageTestStatus === 'error' && <XCircle size={14} />}
              {storageTestMessage}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestStorageConnection}
              disabled={!storageConfig.endpoint || storageTestStatus === 'testing'}
            >
              {storageTestStatus === 'testing' ? (
                <>
                  <Loader2 size={14} className="mr-1 animate-spin" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </Button>
            <Button
              size="sm"
              onClick={handleSaveStorageConfig}
              disabled={!storageConfig.endpoint}
              className="bg-opensearch-blue hover:bg-blue-600"
            >
              <Save size={14} className="mr-1" />
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearStorageConfig}
              disabled={!storageConfig.endpoint}
            >
              <Trash2 size={14} className="mr-1" />
              Clear
            </Button>
          </div>

          {/* Connection Status and Stats */}
          <div className="border-t pt-4 mt-4">
            {storageStats && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {storageStats.isConnected ? (
                      <>
                        <CheckCircle2 size={16} className="text-opensearch-blue" />
                        <span className="text-sm text-opensearch-blue">Connected to OpenSearch</span>
                      </>
                    ) : (
                      <>
                        <XCircle size={16} className="text-red-400" />
                        <span className="text-sm text-red-400">Not connected - start backend with `npm run dev:server`</span>
                      </>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => loadStorageStats()}
                    disabled={isLoading}
                    className="text-xs"
                  >
                    <RefreshCw size={12} className={`mr-1 ${isLoading ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>
                </div>

                {/* Index Stats */}
                {storageStats.isConnected && (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-3 bg-muted/30 rounded-lg">
                      <div className="text-muted-foreground text-xs uppercase mb-1">Test Cases</div>
                      <div className="text-lg font-semibold">{storageStats.testCases}</div>
                    </div>
                    <div className="p-3 bg-muted/30 rounded-lg">
                      <div className="text-muted-foreground text-xs uppercase mb-1">Experiments</div>
                      <div className="text-lg font-semibold">{storageStats.experiments}</div>
                    </div>
                    <div className="p-3 bg-muted/30 rounded-lg">
                      <div className="text-muted-foreground text-xs uppercase mb-1">Runs</div>
                      <div className="text-lg font-semibold">{storageStats.runs}</div>
                    </div>
                    <div className="p-3 bg-muted/30 rounded-lg">
                      <div className="text-muted-foreground text-xs uppercase mb-1">Analytics Records</div>
                      <div className="text-lg font-semibold">{storageStats.analytics}</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isLoading && (
              <p className="text-sm text-muted-foreground">Loading storage stats...</p>
            )}

            {!storageStats?.isConnected && !isLoading && (
              <Alert className="bg-amber-50 border-amber-300 dark:bg-amber-900/20 dark:border-amber-700/30">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertDescription className="text-amber-700 dark:text-amber-400">
                  Cannot connect to OpenSearch backend. Make sure the server is running.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Observability Data Source Configuration */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server size={18} />
            Observability Data Source
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            OTEL instrumentation for traces, logs, and metrics
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Configure the OpenSearch cluster for observability data. Credentials are stored securely on the server (in agent-health.config.json), not in your browser.
          </p>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="obs-endpoint" className="text-xs">Endpoint URL</Label>
              <Input
                id="obs-endpoint"
                placeholder="https://opensearch.example.com:9200"
                value={observabilityConfig.endpoint}
                onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, endpoint: e.target.value })}
              />
            </div>

            {/* Authentication Type */}
            <div className="space-y-1.5">
              <Label className="text-xs">Authentication Type</Label>
              <Select
                value={observabilityConfig.authType}
                onValueChange={(v) => setObservabilityConfigState({ ...observabilityConfig, authType: v as ClusterAuthType })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Auth</SelectItem>
                  <SelectItem value="basic">Basic Auth (username/password)</SelectItem>
                  <SelectItem value="sigv4">AWS SigV4</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {observabilityConfig.authType === 'none' ? (
              /* No Auth - no credentials needed */
              <div className="space-y-3 p-3 border rounded-lg bg-muted/10">
                <p className="text-xs text-muted-foreground">
                  No authentication — connects directly without credentials. Suitable for local development clusters.
                </p>
              </div>
            ) : observabilityConfig.authType === 'basic' ? (
              /* Basic Auth fields */
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="obs-username" className="text-xs">Username (optional)</Label>
                  <Input
                    id="obs-username"
                    placeholder="Leave blank to use env var"
                    value={observabilityConfig.username}
                    onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, username: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="obs-password" className="text-xs">Password (optional)</Label>
                  <div className="relative">
                    <Input
                      id="obs-password"
                      type={showObservabilityPassword ? 'text' : 'password'}
                      placeholder={observabilityConfig.password === PASSWORD_STORED_SENTINEL ? '••••••••' : 'Leave blank to use env var'}
                      value={observabilityConfig.password === PASSWORD_STORED_SENTINEL ? '' : observabilityConfig.password}
                      onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, password: e.target.value })}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowObservabilityPassword(!showObservabilityPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showObservabilityPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {observabilityConfig.password === PASSWORD_STORED_SENTINEL && (
                    <p className="text-xs text-muted-foreground">Password stored — leave blank to keep it, or type a new one to replace it</p>
                  )}
                </div>
              </div>
            ) : (
              /* AWS SigV4 fields */
              <div className="space-y-3 p-3 border rounded-lg bg-muted/10">
                <p className="text-xs text-muted-foreground">
                  Uses the AWS credential chain (env vars, ~/.aws/credentials, IAM role, etc.)
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="obs-aws-region" className="text-xs">AWS Region (required)</Label>
                    <Input
                      id="obs-aws-region"
                      placeholder="us-east-1"
                      value={observabilityConfig.awsRegion}
                      onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, awsRegion: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="obs-aws-profile" className="text-xs">AWS Profile (optional)</Label>
                    <Input
                      id="obs-aws-profile"
                      placeholder="default"
                      value={observabilityConfig.awsProfile}
                      onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, awsProfile: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">AWS Service</Label>
                  <Select
                    value={observabilityConfig.awsService}
                    onValueChange={(v) => setObservabilityConfigState({ ...observabilityConfig, awsService: v as 'es' | 'aoss' })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="es">es (Managed OpenSearch)</SelectItem>
                      <SelectItem value="aoss">aoss (Serverless)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* TLS Verification Toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="obs-tls-skip" className="text-xs">Skip TLS Verification</Label>
                <p className="text-xs text-muted-foreground">Enable for self-signed certificates</p>
              </div>
              <Switch
                id="obs-tls-skip"
                checked={observabilityConfig.tlsSkipVerify}
                onCheckedChange={(checked) => setObservabilityConfigState({ ...observabilityConfig, tlsSkipVerify: checked })}
              />
            </div>

            {/* Advanced: Index Patterns */}
            <div className="border-t pt-3 mt-3">
              <button
                type="button"
                onClick={() => setShowAdvancedIndexes(!showAdvancedIndexes)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showAdvancedIndexes ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Advanced: Index Patterns
              </button>
              {showAdvancedIndexes && (
                <div className="mt-3 space-y-3 pl-4 border-l-2 border-muted">
                  <div className="space-y-1.5">
                    <Label htmlFor="obs-traces-index" className="text-xs">Traces Index</Label>
                    <Input
                      id="obs-traces-index"
                      placeholder="otel-v1-apm-span-* (default)"
                      value={observabilityConfig.tracesIndex}
                      onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, tracesIndex: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="obs-logs-index" className="text-xs">Logs Index</Label>
                    <Input
                      id="obs-logs-index"
                      placeholder="ml-commons-logs-* (default)"
                      value={observabilityConfig.logsIndex}
                      onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, logsIndex: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="obs-metrics-index" className="text-xs">Metrics Index</Label>
                    <Input
                      id="obs-metrics-index"
                      placeholder="otel-v1-apm-service-map* (default)"
                      value={observabilityConfig.metricsIndex}
                      onChange={(e) => setObservabilityConfigState({ ...observabilityConfig, metricsIndex: e.target.value })}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Config source indicator */}
          {configStatus?.observability && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Currently configured via:</span>
              <span className={`px-2 py-0.5 rounded ${
                configStatus.observability.source === 'file' 
                  ? 'bg-green-100 text-green-900 border border-green-300 dark:bg-green-950/50 dark:text-green-300 dark:border-green-700/50'
                  : configStatus.observability.source === 'environment' 
                  ? 'bg-blue-100 text-blue-900 border border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700/50'
                  : 'bg-gray-100 text-gray-900 border border-gray-300 dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700/50'
              }`}>
                {configStatus.observability.source === 'file' ? 'Config file (agent-health.config.json)' :
                 configStatus.observability.source === 'environment' ? 'Environment variables' :
                 'Not configured'}
              </span>
            </div>
          )}

          {/* Test connection status */}
          {observabilityTestMessage && (
            <div className={`flex items-center gap-2 text-sm ${
              observabilityTestStatus === 'success' ? 'text-green-400' :
              observabilityTestStatus === 'error' ? 'text-red-400' :
              observabilityTestStatus === 'testing' ? 'text-blue-400' : 'text-muted-foreground'
            }`}>
              {observabilityTestStatus === 'testing' && <Loader2 size={14} className="animate-spin" />}
              {observabilityTestStatus === 'success' && <CheckCircle2 size={14} />}
              {observabilityTestStatus === 'error' && <XCircle size={14} />}
              {observabilityTestMessage}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestObservabilityConnection}
              disabled={!observabilityConfig.endpoint || observabilityTestStatus === 'testing'}
            >
              {observabilityTestStatus === 'testing' ? (
                <>
                  <Loader2 size={14} className="mr-1 animate-spin" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </Button>
            <Button
              size="sm"
              onClick={handleSaveObservabilityConfig}
              disabled={!observabilityConfig.endpoint}
              className="bg-opensearch-blue hover:bg-blue-600"
            >
              <Save size={14} className="mr-1" />
              Save
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearObservabilityConfig}
              disabled={!observabilityConfig.endpoint}
            >
              <Trash2 size={14} className="mr-1" />
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Data Migration */}
      {hasLocalData && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload size={18} />
              Data Migration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Found existing data in browser localStorage. Migrate it to OpenSearch for persistent storage.
            </p>

            {/* Local Data Stats */}
            {localCounts && (
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div className="p-3 bg-muted/30 rounded-lg">
                  <div className="text-muted-foreground text-xs uppercase mb-1">Test Cases</div>
                  <div className="text-lg font-semibold">{localCounts.testCases}</div>
                </div>
                <div className="p-3 bg-muted/30 rounded-lg">
                  <div className="text-muted-foreground text-xs uppercase mb-1">Experiments</div>
                  <div className="text-lg font-semibold">{localCounts.experiments}</div>
                </div>
                <div className="p-3 bg-muted/30 rounded-lg">
                  <div className="text-muted-foreground text-xs uppercase mb-1">Reports</div>
                  <div className="text-lg font-semibold">{localCounts.reports}</div>
                </div>
              </div>
            )}

            {/* Migration Status */}
            {migrationStatus && (
              <Alert className={migrationStatus.includes('failed') ? 'bg-red-50 border-red-300 dark:bg-red-900/20 dark:border-red-700/30' : 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-700/30'}>
                {isMigrating && <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin" />}
                <AlertDescription className={migrationStatus.includes('failed') ? 'text-red-700 dark:text-red-400' : 'text-blue-700 dark:text-blue-400'}>
                  {migrationStatus}
                </AlertDescription>
              </Alert>
            )}

            {/* Migration Results */}
            {migrationResult && (
              <div className="p-3 bg-muted/30 rounded-lg text-sm space-y-1">
                <div className="font-medium mb-2">Migration Results:</div>
                <div>Test Cases: {migrationResult.testCases.migrated} migrated, {migrationResult.testCases.skipped} skipped</div>
                <div>Experiments: {migrationResult.experiments.migrated} migrated, {migrationResult.experiments.skipped} skipped</div>
                <div>Reports: {migrationResult.reports.migrated} migrated, {migrationResult.reports.skipped} skipped</div>
                {(migrationResult.testCases.errors.length > 0 ||
                  migrationResult.experiments.errors.length > 0 ||
                  migrationResult.reports.errors.length > 0) && (
                  <div className="text-amber-400 mt-2">
                    {migrationResult.testCases.errors.length + migrationResult.experiments.errors.length + migrationResult.reports.errors.length} errors occurred
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                variant="default"
                size="sm"
                onClick={handleMigrate}
                disabled={isMigrating || !storageStats?.isConnected}
                className="bg-opensearch-blue hover:bg-blue-600"
              >
                {isMigrating ? (
                  <>
                    <Loader2 size={14} className="mr-1 animate-spin" />
                    Migrating...
                  </>
                ) : (
                  <>
                    <Upload size={14} className="mr-1" />
                    Migrate to OpenSearch
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExportLocalData}
                disabled={isMigrating}
              >
                <Download size={14} className="mr-1" />
                Export as JSON
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearLocalData}
                disabled={isMigrating}
                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
              >
                <Trash2 size={14} className="mr-1" />
                Clear localStorage
              </Button>
            </div>

            {!storageStats?.isConnected && (
              <p className="text-xs text-amber-400">
                Connect to OpenSearch backend first before migrating.
              </p>
            )}
          </CardContent>
        </Card>
      )}
      {/* Debug Settings */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Debug Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="debug-mode" className="text-sm font-medium">
                Debug Mode
              </Label>
              <p className="text-xs text-muted-foreground">
                Verbose logging and real-time performance metrics overlay
              </p>
            </div>
            <Switch
              id="debug-mode"
              checked={debugMode}
              onCheckedChange={handleDebugToggle}
            />
          </div>

          {debugMode && (
            <Alert className="bg-amber-900/20 border-amber-700/30 mt-4">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              <AlertDescription className="text-amber-400 text-xs">
                <strong>Enabled:</strong> Detailed logs in browser console (enable "Verbose" level) and server terminal.
                A performance overlay will appear on instrumented pages.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>

    {/* Index Fix Progress Modal */}
    <Dialog open={indexFixState.visible} onOpenChange={(open) => {
      if (!open && indexFixState.done) {
        setIndexFixState({ visible: false, progress: [], done: false });
      }
    }}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => {
        if (!indexFixState.done) e.preventDefault();
      }}>
        <DialogHeader>
          <DialogTitle>
            {indexFixState.done ? 'Index Mappings Fixed' : 'Fixing Index Mappings'}
          </DialogTitle>
          <DialogDescription>
            {indexFixState.done
              ? 'Incompatible index mappings have been automatically fixed.'
              : 'Reindexing to fix incompatible field types. Please wait...'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {indexFixState.progress.map((item) => (
            <div key={item.indexName} className="flex items-center gap-3 text-sm">
              {item.status === 'pending' && (
                <Circle size={16} className="text-muted-foreground" />
              )}
              {item.status === 'reindexing' && (
                <Loader2 size={16} className="animate-spin text-blue-400" />
              )}
              {item.status === 'completed' && (
                <CheckCircle2 size={16} className="text-green-400" />
              )}
              {item.status === 'failed' && (
                <XCircle size={16} className="text-red-400" />
              )}
              <div className="flex-1">
                <span className="font-mono text-xs">{item.indexName}</span>
                {item.status === 'reindexing' && item.documentCount != null && (
                  <span className="text-muted-foreground ml-2">
                    ({item.documentCount} documents)
                  </span>
                )}
                {item.status === 'completed' && item.documentCount != null && (
                  <span className="text-muted-foreground ml-2">
                    {item.documentCount} docs reindexed
                  </span>
                )}
                {item.status === 'failed' && item.error && (
                  <span className="text-red-400 ml-2">{item.error}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        {indexFixState.done && (
          <div className="mt-4 flex justify-end">
            <Button
              size="sm"
              onClick={() => setIndexFixState({ visible: false, progress: [], done: false })}
            >
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
};
