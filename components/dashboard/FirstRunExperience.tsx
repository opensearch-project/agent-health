/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Zap, Activity, Gauge, TrendingUp, ArrowRight, Server, Database, Copy, Check, ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { loadSampleData } from '@/config/sampleData';
import { CodingAgentsBanner } from './CodingAgentsBanner';

/**
 * First Run Experience component
 *
 * Displayed when users have no configured storage cluster.
 * Progressive onboarding flow:
 * 1. Explore sample data (primary CTA - no setup needed)
 * 2. Connect your agent
 * 3. Enable trace collection (Docker / AWS)
 * 4. Persist evaluations (OpenSearch storage)
 */
interface FirstRunExperienceProps {
  showCodingAgentsBanner?: boolean;
}

export const FirstRunExperience: React.FC<FirstRunExperienceProps> = ({ showCodingAgentsBanner }) => {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isStep3Expanded, setIsStep3Expanded] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleViewSampleData = async () => {
    setIsLoading(true);
    try {
      await loadSampleData();

      // Navigate to dashboard (which will now show data)
      // The page will reload and ensure data state is re-evaluated
      navigate('/agent-traces');

      // Force a page reload to ensure data state is re-evaluated
      window.location.reload();
    } catch (error) {
      console.error('[FirstRunExperience] Failed to load sample data:', error);

      // Show error message using alert (simple fallback)
      alert('Failed to load sample data. Please try again or contact support if the issue persists.');

      setIsLoading(false);
    }
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCommand(id);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedCommand(null), 2000);
    } catch {
      // Fallback for environments where clipboard API isn't available
      console.warn('[FirstRunExperience] Clipboard API not available');
    }
  };

  const dockerCommand = 'curl -fsSL https://raw.githubusercontent.com/opensearch-project/agent-health/main/scripts/install.sh | bash';
  const aiPrompt = 'Clone opensearch-project/agent-health, run docker compose up -d, copy .env.docker to .env, then run npx @opensearch-project/agent-health';
  const cfnCliCommand = 'aws cloudformation create-stack --stack-name AgentHealthObservability --template-body file://deployment/cloudformation/agent-health-observability.yaml --capabilities CAPABILITY_NAMED_IAM';

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-16" data-testid="first-run-experience">
      {/* Hero Section */}
      <div className="text-center space-y-6">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight">
            Welcome to Agent Health
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Explore sample benchmarks, connect your agent, and set up observability — at your own pace.
          </p>
        </div>

        <div className="pt-2 space-y-4">
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Button
              size="lg"
              onClick={handleViewSampleData}
              disabled={isLoading}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
            >
              <Zap className="mr-2 h-5 w-5" />
              {isLoading ? 'Loading...' : 'Explore Sample Data'}
            </Button>

            <Button
              size="lg"
              variant="outline"
              asChild
            >
              <Link to="/settings">
                <Server className="mr-2 h-5 w-5" />
                Connect Your Agent
              </Link>
            </Button>

            <Button
              size="lg"
              variant="outline"
              className="text-muted-foreground"
              onClick={() => {
                setIsStep3Expanded(true);
                setTimeout(() => {
                  document.getElementById('step-3-docker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
              }}
            >
              <Terminal className="mr-2 h-5 w-5" />
              Docker Compose
            </Button>

            <Button
              size="lg"
              variant="outline"
              className="text-muted-foreground"
              onClick={() => {
                setIsStep3Expanded(true);
                setTimeout(() => {
                  document.getElementById('step-3-aws')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
              }}
            >
              <Database className="mr-2 h-5 w-5" />
              AWS CloudFormation
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">No setup required — explore pre-loaded benchmarks, traces, and evaluations.</p>

          {showCodingAgentsBanner && (
            <div className="max-w-2xl mx-auto pt-2">
              <CodingAgentsBanner />
            </div>
          )}
        </div>
      </div>

      {/* Two-Card Layout */}
      <div className="grid gap-8 lg:grid-cols-2">
        {/* Left Card: Workflow */}
        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">How it works</h2>
              <p className="text-sm text-muted-foreground">
                A continuous cycle that drives measurable improvement:
              </p>
            </div>

            {/* Workflow Icons */}
            <div className="relative pb-6">
              <div className="flex items-center justify-center gap-2 py-2">
                <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <Activity className="h-5 w-5 text-blue-500" />
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center">
                  <Gauge className="h-5 w-5 text-purple-500" />
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <div className="w-10 h-10 rounded-full bg-violet-500/20 flex items-center justify-center">
                  <TrendingUp className="h-5 w-5 text-violet-500" />
                </div>
              </div>

              {/* U-shaped return arrow underneath - spans from first to last circle center */}
              <svg
                className="absolute left-1/2 -translate-x-1/2 bottom-0"
                width="184"
                height="32"
                viewBox="0 0 184 32"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M 164 4 L 164 22 Q 164 26 160 26 L 24 26 Q 20 26 20 22 L 20 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                  className="text-muted-foreground/40"
                  strokeDasharray="3 3"
                />
                <path
                  d="M 17 8 L 20 4 L 23 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  fill="none"
                  className="text-muted-foreground/40"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            {/* Workflow Details */}
            <div className="space-y-5">
              <Link to="/agent-traces" className="flex items-start gap-3 group hover:bg-accent/50 rounded-lg p-2 -m-2 transition-colors">
                <Activity className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold group-hover:text-primary">Trace</h3>
                  <p className="text-sm text-muted-foreground">
                    See exactly what your agent did.
                  </p>
                </div>
              </Link>

              <Link to="/benchmarks" className="flex items-start gap-3 group hover:bg-accent/50 rounded-lg p-2 -m-2 transition-colors">
                <Gauge className="h-5 w-5 text-purple-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold group-hover:text-primary">Evaluate</h3>
                  <p className="text-sm text-muted-foreground">
                    Benchmark and measure quality before production.
                  </p>
                </div>
              </Link>

              <Link to="/runs/demo-report-001?tab=judge" className="flex items-start gap-3 group hover:bg-accent/50 rounded-lg p-2 -m-2 transition-colors">
                <TrendingUp className="h-5 w-5 text-violet-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold group-hover:text-primary">Improve</h3>
                  <p className="text-sm text-muted-foreground">
                    Make informed decisions with recorded history.
                  </p>
                </div>
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Right Card: Getting Started Steps */}
        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Getting Started</h2>
              <p className="text-sm text-muted-foreground">
                Go at your own pace — start exploring, then connect when ready.
              </p>
            </div>

            <div className="space-y-5">
              {/* Step 1: Explore Sample Data */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-sm font-semibold text-blue-500">1</span>
                </div>
                <div className="space-y-2 flex-1">
                  <h3 className="text-sm font-semibold">Explore Sample Data</h3>
                  <p className="text-sm text-muted-foreground">
                    Pre-loaded benchmarks, traces, and evaluations — no setup needed.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleViewSampleData}
                    disabled={isLoading}
                    className="text-blue-500 border-blue-500/30 hover:bg-blue-500/10"
                  >
                    {isLoading ? 'Loading...' : 'Explore'}
                    {!isLoading && <ArrowRight className="ml-1 h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>

              {/* Step 2: Connect Your Agent */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-sm font-semibold text-purple-500">2</span>
                </div>
                <div className="space-y-2 flex-1">
                  <h3 className="text-sm font-semibold">Connect Your Agent</h3>
                  <p className="text-sm text-muted-foreground">
                    Configure your agent endpoint and connector type to run your own evaluations.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="text-purple-500 border-purple-500/30 hover:bg-purple-500/10"
                  >
                    <Link to="/settings">
                      Configure
                      <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>

              {/* Step 3: Enable Trace Collection */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-sm font-semibold text-violet-500">3</span>
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">Enable Trace Collection</h3>
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">optional</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Set up an observability pipeline to collect OpenTelemetry traces from your agents.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIsStep3Expanded(!isStep3Expanded)}
                    className="text-violet-500 border-violet-500/30 hover:bg-violet-500/10"
                  >
                    {isStep3Expanded ? 'Hide options' : 'View options'}
                    {isStep3Expanded
                      ? <ChevronUp className="ml-1 h-3.5 w-3.5" />
                      : <ChevronDown className="ml-1 h-3.5 w-3.5" />
                    }
                  </Button>

                  {/* Expandable deployment options */}
                  {isStep3Expanded && (
                    <div className="mt-3 space-y-4">
                      {/* Docker option */}
                      <div id="step-3-docker" className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Terminal className="h-4 w-4 text-muted-foreground" />
                          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Self-hosted (Docker)</span>
                        </div>
                        <div className="relative">
                          <div className="bg-secondary rounded-lg p-3 pr-10 font-mono text-xs break-all">
                            {dockerCommand}
                          </div>
                          <button
                            onClick={() => handleCopy(dockerCommand, 'docker')}
                            className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-muted transition-colors"
                            type="button"
                            aria-label="Copy command"
                          >
                            {copiedCommand === 'docker'
                              ? <Check className="h-3.5 w-3.5 text-green-500" />
                              : <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                            }
                          </button>
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">Or paste this into your AI coding tool:</p>
                          <div className="relative">
                            <div className="bg-secondary rounded-lg p-3 pr-10 font-mono text-xs italic">
                              &ldquo;{aiPrompt}&rdquo;
                            </div>
                            <button
                              type="button"
                              onClick={() => handleCopy(aiPrompt, 'ai')}
                              className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-muted transition-colors"
                              aria-label="Copy prompt"
                            >
                              {copiedCommand === 'ai'
                                ? <Check className="h-3.5 w-3.5 text-green-500" />
                                : <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                              }
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* AWS option */}
                      <div id="step-3-aws" className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Database className="h-4 w-4 text-muted-foreground" />
                          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">AWS Managed (CloudFormation)</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Deploy via CLI:</p>
                        <div className="relative">
                          <div className="bg-secondary rounded-lg p-3 pr-10 font-mono text-xs">
                            {cfnCliCommand}
                          </div>
                          <button
                            onClick={() => handleCopy(cfnCliCommand, 'cfn-cli')}
                            className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-muted transition-colors"
                            type="button"
                            aria-label="Copy command"
                          >
                            {copiedCommand === 'cfn-cli'
                              ? <Check className="h-3.5 w-3.5 text-green-500" />
                              : <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                            }
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Then auto-configure Agent Health:
                        </p>
                        <div className="relative">
                          <div className="bg-secondary rounded-lg p-3 pr-10 font-mono text-xs">
                            npx @opensearch-project/agent-health configure --from-stack AgentHealthObservability
                          </div>
                          <button
                            onClick={() => handleCopy('npx @opensearch-project/agent-health configure --from-stack AgentHealthObservability', 'cfn')}
                            className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-muted transition-colors"
                            type="button"
                            aria-label="Copy command"
                          >
                            {copiedCommand === 'cfn'
                              ? <Check className="h-3.5 w-3.5 text-green-500" />
                              : <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                            }
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 4: Persist Evaluations */}
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-sm font-semibold text-green-500">4</span>
                </div>
                <div className="space-y-2 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">Persist Evaluations</h3>
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">optional</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Store evaluation results in OpenSearch for history, trends, and team collaboration.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    asChild
                    className="text-green-500 border-green-500/30 hover:bg-green-500/10"
                  >
                    <Link to="/settings#storage">
                      Configure
                      <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
