/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveConnectorWorkspaceDir } from '@/services/connectors/types';

describe('resolveConnectorWorkspaceDir', () => {
  it('prefers the actual per-run connector workspace over the static configured cwd', () => {
    expect(resolveConnectorWorkspaceDir(
      { workspaceDir: '/tmp/per-run-fixture' },
      { cwd: '/repo/static-fixture' }
    )).toBe('/tmp/per-run-fixture');
  });

  it('falls back to connectorConfig.cwd when the connector reports no per-run workspace', () => {
    expect(resolveConnectorWorkspaceDir(
      { sessionId: 'session-without-workspace' },
      { cwd: '/repo/static-fixture' }
    )).toBe('/repo/static-fixture');
  });
});
