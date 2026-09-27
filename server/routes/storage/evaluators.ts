/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluators Routes - Versioned CRUD operations
 *
 * Storage-backend agnostic: uses IStorageModule adapter (file or OpenSearch).
 * System evaluators (built-in templates) are always included in responses.
 */

import { Router, Request, Response } from 'express';
import { debug } from '@/lib/debug';
import { getStorageModule } from '@/server/adapters';
import { SYSTEM_EVALUATORS, toEvaluator, isSystemEvaluatorId, getSystemEvaluatorById } from '@/server/prompts/evaluatorTemplates';
import type { Evaluator, StorageMetadata } from '@/types';
import {
  isDeterministicEvaluator,
  normalizeDeterministicEvaluator,
  validateDeterministicEvaluator,
} from '@/lib/evaluators/deterministic';

const router = Router();

/**
 * Check if an ID belongs to system evaluators (read-only)
 */
function isSystemId(id: string): boolean {
  return isSystemEvaluatorId(id);
}

/**
 * Get system evaluators as full Evaluator objects with timestamps
 */
function getSystemEvaluators(): Evaluator[] {
  return SYSTEM_EVALUATORS.map(toEvaluator);
}

// GET /api/storage/evaluators - List all (latest versions)
router.get('/api/storage/evaluators', async (req: Request, res: Response) => {
  try {
    const { ids } = req.query;
    const filterIds = ids ? (ids as string).split(',').filter(Boolean) : null;

    let customData: Evaluator[] = [];
    const warnings: string[] = [];
    let storageReachable = false;
    const storage = getStorageModule();
    const storageConfigured = storage.isConfigured();

    // Fetch custom evaluators from storage backend
    if (storageConfigured) {
      try {
        if (filterIds) {
          // Filter by specific IDs - get latest version of each non-system evaluator
          const nonSystemIds = filterIds.filter(id => !isSystemId(id));
          for (const id of nonSystemIds) {
            const evaluator = await storage.evaluators.getById(id);
            if (evaluator) customData.push(evaluator);
          }
        } else {
          // Get all custom evaluators
          const result = await storage.evaluators.getAll();
          customData = result.items;
        }
        storageReachable = true;
      } catch (e: any) {
        console.warn('[StorageAPI] Storage unavailable, returning system evaluators only:', e.message);
        warnings.push(`Storage unavailable: ${e.message}`);
      }
    }

    // Get system evaluators (filtered by IDs if specified)
    let systemData = getSystemEvaluators();
    if (filterIds) {
      const systemIds = filterIds.filter(id => isSystemId(id));
      systemData = systemData.filter(ev => systemIds.includes(ev.id));
    }

    // Sort: system evaluators first (alphabetically), then custom evaluators by updatedAt descending
    systemData.sort((a, b) => a.name.localeCompare(b.name));
    customData.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    // System evaluators first, then custom evaluators
    const allData = [...systemData, ...customData];

    // Build metadata
    const meta: StorageMetadata = {
      storageConfigured,
      storageReachable,
      realDataCount: customData.length,
      sampleDataCount: systemData.length,
      ...(warnings.length > 0 && { warnings }),
    };

    res.json({
      evaluators: allData,
      total: allData.length,
      meta,
    });
  } catch (error: any) {
    console.error('[StorageAPI] List evaluators failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/evaluators/:id - Get latest version
router.get('/api/storage/evaluators/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check system evaluators first
    if (isSystemId(id)) {
      const systemTemplate = getSystemEvaluatorById(id);
      if (systemTemplate) {
        return res.json(toEvaluator(systemTemplate));
      }
      return res.status(404).json({ error: 'Evaluator not found' });
    }

    // Fetch from storage
    const storage = getStorageModule();
    const evaluator = await storage.evaluators.getById(id);
    if (!evaluator) {
      return res.status(404).json({ error: 'Evaluator not found' });
    }
    res.json(evaluator);
  } catch (error: any) {
    console.error('[StorageAPI] Get evaluator failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/evaluators/:id/versions - Get all versions
router.get('/api/storage/evaluators/:id/versions', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // System evaluators have only one version
    if (isSystemId(id)) {
      const systemTemplate = getSystemEvaluatorById(id);
      if (systemTemplate) {
        const evaluator = toEvaluator(systemTemplate);
        return res.json({ versions: [evaluator], total: 1 });
      }
      return res.status(404).json({ error: 'Evaluator not found' });
    }

    const storage = getStorageModule();
    const versions = await storage.evaluators.getVersions(id);
    if (versions.length === 0) {
      return res.status(404).json({ error: 'Evaluator not found' });
    }
    res.json({ versions, total: versions.length });
  } catch (error: any) {
    console.error('[StorageAPI] Get evaluator versions failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/evaluators/:id/versions/:version - Get specific version
router.get('/api/storage/evaluators/:id/versions/:version', async (req: Request, res: Response) => {
  try {
    const { id, version } = req.params;

    // System evaluators have only version 1
    if (isSystemId(id)) {
      if (version === '1') {
        const systemTemplate = getSystemEvaluatorById(id);
        if (systemTemplate) {
          return res.json(toEvaluator(systemTemplate));
        }
      }
      return res.status(404).json({ error: 'Evaluator version not found' });
    }

    const storage = getStorageModule();
    const evaluator = await storage.evaluators.getVersion(id, parseInt(version));
    if (!evaluator) {
      return res.status(404).json({ error: 'Evaluator version not found' });
    }
    res.json(evaluator);
  } catch (error: any) {
    console.error('[StorageAPI] Get evaluator version failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Validate + normalize a `kind: 'deterministic'` evaluator body (see
 * lib/evaluators/deterministic.ts). Returns the 400 error text, or the
 * normalized body (`systemPrompt: ''`, synthesized `scoringConfig`, metric
 * defaults filled). LLM evaluators pass through untouched.
 */
function prepareEvaluatorBody(body: Record<string, any>): { error?: string; evaluator: Record<string, any> } {
  if (body.kind !== undefined && body.kind !== 'llm' && body.kind !== 'deterministic') {
    return { error: "kind must be 'llm' or 'deterministic'", evaluator: body };
  }
  if (!isDeterministicEvaluator(body)) return { evaluator: body };
  const errors = validateDeterministicEvaluator(body);
  if (errors.length > 0) {
    return { error: `Invalid deterministic evaluator: ${errors.join('; ')}`, evaluator: body };
  }
  return { evaluator: normalizeDeterministicEvaluator(body) };
}

// POST /api/storage/evaluators - Create new (version 1)
//
// Body: the LLM shape ({ name, systemPrompt, scoringConfig, inferenceConfig })
// OR a deterministic evaluator ({ name, kind: 'deterministic', metrics[],
// passPolicy, inputs }) — see docs/EVALUATORS.md "Deterministic evaluators".
router.post('/api/storage/evaluators', async (req: Request, res: Response) => {
  try {
    const prepared = prepareEvaluatorBody({ ...req.body });
    if (prepared.error) {
      return res.status(400).json({ error: prepared.error });
    }
    const evaluator = prepared.evaluator;

    // Reject creating with system evaluator IDs
    if (evaluator.id && isSystemId(evaluator.id)) {
      return res.status(400).json({ error: 'Cannot create evaluator with system evaluator ID. System evaluators are reserved.' });
    }

    // Validation
    if (!evaluator.name) {
      return res.status(400).json({ error: 'Evaluator name is required' });
    }
    if (!evaluator.systemPrompt && !isDeterministicEvaluator(evaluator)) {
      return res.status(400).json({ error: 'Evaluator system prompt is required' });
    }
    if (!evaluator.scoringConfig) {
      return res.status(400).json({ error: 'Evaluator scoring config is required' });
    }

    const storage = getStorageModule();
    const created = await storage.evaluators.create(evaluator);

    debug('StorageAPI', `Created evaluator: ${created.id} v1`);
    res.status(201).json(created);
  } catch (error: any) {
    console.error('[StorageAPI] Create evaluator failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/storage/evaluators/:id - Create new version
router.put('/api/storage/evaluators/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject modifying system evaluators
    if (isSystemId(id)) {
      return res.status(400).json({ error: 'Cannot modify system evaluators. Duplicate them to create a custom version.' });
    }

    const storage = getStorageModule();
    // Validate the MERGED document: a deterministic evaluator's partial
    // update (e.g. just `passPolicy`) must still yield a valid whole. An
    // unknown id falls through to storage.update, which throws as before.
    const current = await storage.evaluators.getById(id).catch(() => null);
    const merged = { ...(current ?? {}), ...req.body };
    const prepared = prepareEvaluatorBody(merged);
    if (prepared.error) {
      return res.status(400).json({ error: prepared.error });
    }
    const updates = isDeterministicEvaluator(merged)
      ? {
          ...req.body,
          kind: 'deterministic',
          systemPrompt: '',
          inferenceConfig: {},
          metrics: prepared.evaluator.metrics,
          passPolicy: prepared.evaluator.passPolicy,
          inputs: prepared.evaluator.inputs,
          scoringConfig: prepared.evaluator.scoringConfig,
        }
      : req.body;
    const updated = await storage.evaluators.update(id, updates);

    debug('StorageAPI', `Updated evaluator: ${id} → v${updated.currentVersion}`);
    res.json(updated);
  } catch (error: any) {
    console.error('[StorageAPI] Update evaluator failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/evaluators/:id - Delete all versions
router.delete('/api/storage/evaluators/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Reject deleting system evaluators
    if (isSystemId(id)) {
      return res.status(400).json({ error: 'Cannot delete system evaluators. System evaluators are protected.' });
    }

    const storage = getStorageModule();
    const result = await storage.evaluators.delete(id);

    if (result.deleted === 0) {
      return res.status(404).json({ error: 'Evaluator not found' });
    }

    debug('StorageAPI', `Deleted evaluator: ${id} (${result.deleted} version(s))`);
    res.json({ deleted: result.deleted });
  } catch (error: any) {
    console.error('[StorageAPI] Delete evaluator failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
