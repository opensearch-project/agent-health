/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** Focused empty-run state for users who already imported definitions. */
export const ReadyToRun: React.FC = () => (
  <div
    className="min-h-[calc(100vh-8rem)] flex items-center justify-center p-6"
    data-testid="ready-to-run"
  >
    <Card className="w-full max-w-xl">
      <CardContent className="flex flex-col items-center p-8 text-center">
        <div className="mb-5 rounded-full bg-primary/10 p-4 text-primary">
          <PlayCircle className="h-8 w-8" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Ready to run</h1>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Your benchmark or test case definitions are imported. Run a benchmark to generate the first results for this Overview.
        </p>
        <Button asChild className="mt-6">
          <Link to="/evaluations/benchmarks">
            Run a benchmark
            <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  </div>
);
