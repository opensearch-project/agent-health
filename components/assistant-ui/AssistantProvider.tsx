/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAssistantRuntime } from '@/hooks/useAssistantRuntime';

export const AssistantProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const runtime = useAssistantRuntime();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
};
