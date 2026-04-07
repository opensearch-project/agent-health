/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const ConfigEditor: React.FC = () => {
  const yamlContent = `# Agent Configuration for Evaluation Framework

defaults:
  retry_attempts: ${DEFAULT_CONFIG.defaults.retry_attempts}
  retry_delay_ms: ${DEFAULT_CONFIG.defaults.retry_delay_ms}

agents:
${DEFAULT_CONFIG.agents.map(agent => `  - name: ${agent.name}
    endpoint: ${agent.endpoint}
    description: ${agent.description || 'N/A'}
    enabled: ${agent.enabled !== false}
    models:
${agent.models.map(m => `      - ${m}`).join('\n')}`).join('\n\n')}

models:
${Object.values(DEFAULT_CONFIG.models).map(model => `  ${model.display_name}:
    model_id: ${model.model_id}
    context_window: ${model.context_window}
    max_output_tokens: ${model.max_output_tokens}`).join('\n\n')}
`;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Configuration</h2>

      <Card>
        <Tabs defaultValue="yaml">
          <TabsList className="w-full justify-start rounded-none border-b bg-card h-auto p-0">
            <TabsTrigger
              value="yaml"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
            >
              YAML View (Read Only)
            </TabsTrigger>
            <TabsTrigger
              value="schema"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
            >
              Schema
            </TabsTrigger>
          </TabsList>

          <TabsContent value="yaml" className="mt-0">
            <CardContent className="p-0">
              <pre className="p-4 text-sm font-mono text-muted-foreground bg-muted/50 overflow-x-auto">
                {yamlContent}
              </pre>
            </CardContent>
          </TabsContent>

          <TabsContent value="schema" className="mt-0">
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">
                Schema documentation coming soon.
              </p>
            </CardContent>
          </TabsContent>
        </Tabs>

        <CardFooter className="border-t justify-between">
          <p className="text-xs text-muted-foreground italic">
            This configuration is loaded from the server. Edit <code className="bg-muted px-1 rounded">agent-health.config.json</code> or <code className="bg-muted px-1 rounded">agent-health.config.ts</code> to update.
          </p>
          <Button variant="outline" size="sm">
            <RefreshCw size={14} className="mr-2" />
            Reload from Disk
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};
