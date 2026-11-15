/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge API Route - Evaluate agent trajectories
 */

import { Request, Response, Router } from 'express';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  describeDefaultAgentJudgeModel,
  AGENT_JUDGE_MODEL_ENV,
} from '@/server/services/piAgenticJudgeService';
import { isJudgeParseError } from '@/server/services/judgeResponseParser';
import { loadConfigSync } from '@/lib/config/index';
import serverConfig from '@/server/config';
import { debug } from '@/lib/debug';
import { readEnv } from '@/lib/envCompat';
import { getStorageModule } from '@/server/adapters';
import { runJudge, JudgeRequestError, describeJudgeFailure, isProviderRequestRejection } from '@/services/judge/runJudge';

export { isProviderRequestRejection } from '@/services/judge/runJudge';

const router = Router();

/**
 * SSRF guard for model-discovery endpoints that forward a provider credential
 * (Anthropic API key, GitHub token) to an operator-configurable base URL.
 *
 * Both URLs are env-driven (`ANTHROPIC_BASE_URL`, `GITHUB_MODELS_URL`) so an
 * operator can point them at a proxy/gateway — but a credential must never be
 * sent to an arbitrary host. We require https and an allowlisted hostname
 * (the provider's own hosts, plus localhost for test proxies). Operators who
 * genuinely need a different host must opt in explicitly via
 * `AH_ALLOW_CUSTOM_MODEL_ENDPOINTS=1`, which is the documented escape hatch.
 *
 * Returns `null` when the URL is safe to call; otherwise an error string
 * (the caller returns 400 and does NOT forward the credential).
 */
function validateDiscoveryUrl(rawUrl: string, allowedHosts: string[]): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return `Invalid discovery URL: ${rawUrl}`;
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    return `Refusing to send credential over non-https URL: ${u.protocol}//${u.hostname}`;
  }
  const optIn = readEnv('AH_ALLOW_CUSTOM_MODEL_ENDPOINTS', 'AGENT_HEALTH_ALLOW_CUSTOM_MODEL_ENDPOINTS') === '1';
  if (optIn) return null;
  const host = u.hostname.toLowerCase();
  const ok = allowedHosts.some(h => host === h || host.endsWith(`.${h}`)) || host === 'localhost' || host === '127.0.0.1';
  if (!ok) {
    return `Refusing to forward credential to non-allowlisted host '${host}'. ` +
      `Allowed: ${allowedHosts.join(', ')}. Set AH_ALLOW_CUSTOM_MODEL_ENDPOINTS=1 to override.`;
  }
  return null;
}

/**
 * GET /api/judge/openai-compatible-models
 * Discover available models from the configured OpenAI-compatible endpoint.
 * Returns { models: string[], endpoint: string, configured: boolean }
 */
router.get('/api/judge/openai-compatible-models', async (_req: Request, res: Response) => {
  const endpoint = serverConfig.OPENAI_COMPATIBLE_ENDPOINT;
  // Derive the /models URL from the chat completions endpoint
  const modelsUrl = endpoint.replace(/\/chat\/completions$/, '/models');

  debug('JudgeAPI', 'Fetching OpenAI-compatible models from:', modelsUrl);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (serverConfig.OPENAI_COMPATIBLE_API_KEY) {
    headers['Authorization'] = `Bearer ${serverConfig.OPENAI_COMPATIBLE_API_KEY}`;
  }

  try {
    const response = await fetch(modelsUrl, { headers });
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `OpenAI-compatible /models returned ${response.status}`,
        details: body,
        endpoint: modelsUrl,
        configured: !!serverConfig.OPENAI_COMPATIBLE_API_KEY,
      });
    }
    const data = await response.json();
    // OpenAI /models returns { object: "list", data: [{ id, ... }] }
    const models: string[] = (data.data || data.models || []).map((m: any) => m.id || m).filter(Boolean);
    debug('JudgeAPI', 'Discovered', models.length, 'OpenAI-compatible models');
    return res.json({
      models,
      endpoint: modelsUrl,
      configured: !!serverConfig.OPENAI_COMPATIBLE_API_KEY,
    });
  } catch (err: any) {
    return res.status(503).json({
      error: `Cannot reach OpenAI-compatible endpoint: ${err.message}`,
      endpoint: modelsUrl,
      configured: !!serverConfig.OPENAI_COMPATIBLE_API_KEY,
    });
  }
});

/**
 * GET /api/judge/bedrock-models
 * Discover available Anthropic models from AWS Bedrock via ListInferenceProfiles.
 * Returns { models: Array<{id, name}>, region: string, configured: boolean }
 */
router.get('/api/judge/bedrock-models', async (_req: Request, res: Response) => {
  const region = serverConfig.AWS_REGION;
  debug('JudgeAPI', 'Fetching Bedrock inference profiles from region:', region);

  try {
    const client = new BedrockClient({
      region,
      // See resolveSigv4Credentials() in opensearchClientFactory.ts: without
      // ignoreCache, @smithy/shared-ini-file-loader's process-lifetime cache
      // of ~/.aws/credentials means a rotated profile is invisible to this
      // model-listing check until the process restarts.
      credentials: fromNodeProviderChain({ ignoreCache: true }),
    });

    const command = new ListInferenceProfilesCommand({});
    const response = await client.send(command);

    const profiles = response.inferenceProfileSummaries || [];
    const anthropicModels = profiles
      .filter(p => (p.inferenceProfileId || '').includes('anthropic'))
      .map(p => ({
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
      }));

    debug('JudgeAPI', 'Discovered', anthropicModels.length, 'Anthropic Bedrock models');
    return res.json({
      models: anthropicModels,
      region,
      configured: true,
    });
  } catch (err: any) {
    debug('JudgeAPI', 'Bedrock discovery failed:', err.message);
    return res.status(503).json({
      error: `Cannot discover Bedrock models: ${err.message}`,
      region,
      configured: false,
    });
  }
});

/**
 * GET /api/judge/anthropic-models
 * Discover available models from the Anthropic direct API (GET /v1/models).
 * Anthropic ids (e.g. `claude-opus-4-1-20250805`) differ from the Bedrock
 * inference-profile ids and the Copilot slugs for the same model — each
 * provider names the same model differently, so discovery per provider is
 * the only reliable way to get usable ids.
 * Returns { models: Array<{id, name}>, configured: boolean }
 */
router.get('/api/judge/anthropic-models', async (_req: Request, res: Response) => {
  const configured = !!serverConfig.ANTHROPIC_API_KEY;
  const modelsUrl = `${serverConfig.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/models`;
  debug('JudgeAPI', 'Fetching Anthropic models from:', modelsUrl);
  if (!configured) {
    return res.status(503).json({
      error: 'Anthropic API not configured — set ANTHROPIC_API_KEY.',
      endpoint: modelsUrl,
      configured,
    });
  }
  // SSRF guard: never forward ANTHROPIC_API_KEY to a non-allowlisted host.
  const anthropicUrlError = validateDiscoveryUrl(modelsUrl, ['api.anthropic.com']);
  if (anthropicUrlError) {
    return res.status(400).json({ error: anthropicUrlError, endpoint: modelsUrl, configured });
  }
  try {
    const response = await fetch(modelsUrl, {
      headers: {
        'x-api-key': serverConfig.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `Anthropic /v1/models returned ${response.status}`,
        details: body,
        endpoint: modelsUrl,
        configured,
      });
    }
    const data = await response.json();
    // Anthropic /v1/models returns { data: [{ id, display_name, ... }] }
    const models = (data.data || []).map((m: any) => ({
      id: m.id,
      name: m.display_name || m.id,
    })).filter((m: any) => m.id);
    debug('JudgeAPI', 'Discovered', models.length, 'Anthropic models');
    return res.json({ models, endpoint: modelsUrl, configured });
  } catch (err: any) {
    return res.status(503).json({
      error: `Cannot reach Anthropic API: ${err.message}`,
      endpoint: modelsUrl,
      configured,
    });
  }
});

/**
 * GET /api/judge/github-models
 * Discover models from the GitHub Models catalog (and, by extension, the
 * Copilot model surface). Returns the vendor-prefixed ids GitHub uses
 * (e.g. `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`) — these are the
 * ids you'd reference when judging via Copilot/GitHub Models, distinct from
 * the Anthropic-direct and Bedrock ids for the same underlying model.
 * Returns { models: Array<{id, name}>, configured: boolean }
 */
router.get('/api/judge/github-models', async (_req: Request, res: Response) => {
  const configured = !!serverConfig.GITHUB_TOKEN;
  const url = serverConfig.GITHUB_MODELS_URL;
  debug('JudgeAPI', 'Fetching GitHub Models catalog from:', url);
  if (!configured) {
    return res.status(503).json({
      error: 'GitHub Models not configured — set GITHUB_TOKEN (a PAT with models:read).',
      endpoint: url,
      configured,
    });
  }
  // SSRF guard: never forward GITHUB_TOKEN to a non-allowlisted host.
  const githubUrlError = validateDiscoveryUrl(url, ['models.github.ai', 'api.githubcopilot.com', 'github.com']);
  if (githubUrlError) {
    return res.status(400).json({ error: githubUrlError, endpoint: url, configured });
  }
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${serverConfig.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({
        error: `GitHub Models catalog returned ${response.status}`,
        details: body,
        endpoint: url,
        configured,
      });
    }
    const data = await response.json();
    // GitHub Models catalog returns an array of { id, name, publisher, ... }
    // (older shape) or { models: [...] }. Handle both.
    const list: any[] = Array.isArray(data) ? data : (data.models || data.data || []);
    const models = list.map((m: any) => ({
      id: m.id || m.name,
      name: m.friendly_name || m.name || m.id,
    })).filter((m: any) => m.id);
    debug('JudgeAPI', 'Discovered', models.length, 'GitHub Models');
    return res.json({ models, endpoint: url, configured });
  } catch (err: any) {
    return res.status(503).json({
      error: `Cannot reach GitHub Models catalog: ${err.message}`,
      endpoint: url,
      configured,
    });
  }
});

/**
 * GET /api/judge/models
 *
 * The judge-model catalog (same entries as GET /api/models) annotated with
 * what each entry ACTUALLY judges with. For plain providers the entry's
 * `model_id` is the model. For the agent (trace) judge provider the
 * `model_id` (`agent-trace-judge`) names a judge KIND whose underlying LLM
 * is chosen at runtime from the pi registry — so the entry carries
 * `resolvedModel`: the provider-qualified id a run started now would be
 * judged by, plus how it was chosen (`auto` | `env-pin` | `evaluator-pin`)
 * and the env var that pins it. The run dialog shows this next to the label
 * ("Agent Trace Judge — Claude Sonnet 4.5") so users know which LLM is
 * behind the judge before they start a run.
 *
 * Resolution is best-effort: when the pi SDK is not installed or no model
 * is credentialed, `resolvedModel` is omitted and `resolveError` says why —
 * the catalog itself always returns 200.
 *
 * Returns { models: Array<ModelConfig & { key, resolvedModel?, resolvedModelName?, resolvedSource?, pinEnv? }>, total }
 */
router.get('/api/judge/models', async (_req: Request, res: Response) => {
  try {
    const config = loadConfigSync();
    const entries = Object.entries(config.models).map(([key, m]) => ({ key, ...m }));
    const needsResolution = entries.some((m) => m.provider === 'agent');
    const described = needsResolution ? await describeDefaultAgentJudgeModel() : undefined;
    const models = entries.map((m) => {
      if (m.provider !== 'agent') return m;
      return {
        ...m,
        pinEnv: AGENT_JUDGE_MODEL_ENV,
        ...(described && 'id' in described
          ? { resolvedModel: described.id, resolvedModelName: described.name, resolvedSource: described.source }
          : { resolveError: described && 'error' in described ? described.error : undefined }),
      };
    });
    return res.json({ models, total: models.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/judge - Evaluate agent trajectory
 *
 * Thin HTTP wrapper over `runJudge` (services/judge/runJudge.ts): the
 * validation, evaluator resolution, provider dispatch and verdict engine all
 * live there so an executor outside the server can judge in-process with the
 * identical contract. This handler only maps results and typed errors to the
 * HTTP responses callers have always received.
 */
router.post('/api/judge', async (req: Request, res: Response) => {
  try {
    const result = await runJudge(req.body, {
      // Lazy: only a stored (non-system) evaluator id needs the storage module.
      getEvaluator: (id) => getStorageModule().evaluators.getById(id),
      config: loadConfigSync(),
    });
    res.json(result);
  } catch (error: any) {
    if (error instanceof JudgeRequestError) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }

    console.error('[JudgeAPI] Error during evaluation:', error);

    // A judge reply with no parseable verdict (empty final turn, malformed
    // JSON) is NOT a transient provider error — retrying the same prompt ten
    // times with exponential backoff just burns ~8 minutes per case (owner
    // incident). Return a distinct 422 + code so the client caps retries and
    // keeps the raw text for the report. Provider-agnostic: every provider
    // funnels through parseJudgeResponse, so the wording can't misattribute
    // the failure to the wrong CLI (pre-fix the `agent` provider's empty
    // reply was reported as "Failed to parse Pi judge response. The CLI may
    // have returned invalid JSON.").
    if (isJudgeParseError(error)) {
      return res.status(422).json({
        error: `Judge evaluation failed: ${error.message}`,
        code: error.code,
        rawResponse: error.rawResponse,
        details: error.message,
      });
    }

    // The model provider REJECTED the request (AWS SDK `ValidationException`,
    // `$fault: 'client'` with HTTP 400 — blank system prompt, unsupported
    // inference parameter, malformed body). The same request will be rejected
    // again; retrying it ten times with exponential back-off only burns
    // ~8.5 min per case. Answer 400 so `callBedrockJudge` fails fast (it
    // treats every 4xx as non-retryable) and the report carries the real
    // provider message. Throttling (429) and server faults keep the 500 path
    // below and stay retryable.
    if (isProviderRequestRejection(error)) {
      return res.status(400).json({
        error: `Judge evaluation failed: the judge model provider rejected the request (${error.name}): ${error.message}`,
        code: 'JUDGE_REQUEST_REJECTED',
        details: error.message,
      });
    }

    let config: ReturnType<typeof loadConfigSync> | undefined;
    try { config = loadConfigSync(); } catch { config = undefined; }
    const errorMessage = describeJudgeFailure(error, req.body?.modelId, config);

    res.status(500).json({
      error: `Judge evaluation failed: ${errorMessage}`,
      details: error.message
    });
  }
});

export default router;
