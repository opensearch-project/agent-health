/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for observioAgent - avoids import.meta.url issues in Jest
 *
 * All functions are jest.fn() so tests can configure return values.
 */

export const OBSERVIO_PORT = 3001;

export const findObservioRoot = jest.fn().mockReturnValue(null);

export const isPortFree = jest.fn().mockResolvedValue(true);

export const spawnObservioAgent = jest.fn().mockReturnValue(null);

export const killObservioAgent = jest.fn().mockResolvedValue(false);
