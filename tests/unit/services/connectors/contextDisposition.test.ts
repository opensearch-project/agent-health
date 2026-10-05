/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { agentPromptContext } from '@/services/connectors/types';

describe('agentPromptContext', () => {
  it('keeps legacy and prompt items while excluding connector and documentation items', () => {
    const context = [
      { description: 'legacy', value: 'a' },
      { description: 'prompt', value: 'b', disposition: 'prompt' as const },
      { description: 'directive', value: 'c', disposition: 'connector' as const },
      { description: 'docs', value: 'd', disposition: 'documentation' as const },
    ];
    expect(agentPromptContext(context)).toEqual(context.slice(0, 2));
  });
});
