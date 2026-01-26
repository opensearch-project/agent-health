/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for version utility - avoids import.meta.url issues in Jest
 */

export const getVersion = jest.fn().mockReturnValue('1.0.0');
