/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Zap,
  Server,
  Compass,
  Plug,
  Gauge,
  TrendingUp,
  Eye,
  Ruler,
  Bug,
  LineChart,
  ArrowRight,
  Copy,
  Check,
  Terminal,
  Cloud,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { loadSampleData } from '@/config/sampleData';
import { cn } from '@/lib/utils';
/**
 * First Run Experience (Overview landing page when no data is configured).
 *
 * Narrative-first surface for users who do not yet understand agent
 * observability. Structure:
 *  1. Hero — promise + two primary CTAs.
 *  2. Journey — Explore → Connect → Evaluate → Improve & Scale.
 *  3. Value — four outcome-framed statements.
 *  4. Scale moment — subtle path to self-hosted / managed deployment.
 */
interface FirstRunExperienceProps {
  /** Conditionally render the "Also available: AI Dev Tools" footer strip. */
  showCodingAgentsBanner?: boolean;
}

// -----------------------------------------------------------------------------
// Command constants (preserved verbatim from previous FRE implementation)
// -----------------------------------------------------------------------------

const DOCKER_INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/opensearch-project/agent-health/main/scripts/install.sh | bash';

const CFN_CREATE_STACK_CMD =
  'aws cloudformation create-stack --stack-name AgentHealthObservability --template-body file://deployment/cloudformation/agent-health-observability.yaml --capabilities CAPABILITY_NAMED_IAM';

const CFN_CONFIGURE_CMD =
  'npx @opensearch-project/agent-health configure --from-stack AgentHealthObservability';

// -----------------------------------------------------------------------------
// Content (single source of truth for copy)
// -----------------------------------------------------------------------------

const JOURNEY_STEPS = [
  {
    icon: Compass,
    title: 'Explore',
    copy: 'See a working agent in action, with real traces and evaluations. No setup.',
  },
  {
    icon: Plug,
    title: 'Connect',
    copy: 'Point Agent Health at your agent. Runs locally, no infrastructure needed.',
  },
  {
    icon: Gauge,
    title: 'Evaluate',
    copy: 'Run it against benchmarks. An AI judge scores accuracy, cost, and reasoning.',
  },
  {
    icon: TrendingUp,
    title: 'Improve & scale',
    copy: 'Send telemetry, catch regressions, and persist history as your agent grows.',
  },
] as const;

const VALUE_CARDS = [
  {
    icon: Eye,
    title: 'Understand what your agent is doing',
    copy: 'Step-by-step execution shows every tool call, model response, and decision.',
  },
  {
    icon: Ruler,
    title: 'Measure accuracy and cost',
    copy: 'Built-in evaluators score quality against expected outcomes and track token cost per run.',
  },
  {
    icon: Bug,
    title: 'Debug failures with real data',
    copy: 'Jump from a failed evaluation straight into the exact run that produced it.',
  },
  {
    icon: LineChart,
    title: 'Improve performance over time',
    copy: 'Compare runs across versions to see what got better, what regressed, and why.',
  },
] as const;

// -----------------------------------------------------------------------------
// Copyable code block
// -----------------------------------------------------------------------------

interface CopyableCommandProps {
  command: string;
  label: string;
  copiedId: string | null;
  onCopy: (text: string, id: string) => void;
  id: string;
}

const CopyableCommand: React.FC<CopyableCommandProps> = ({
  command,
  label,
  copiedId,
  onCopy,
  id,
}) => {
  const isCopied = copiedId === id;
  return (
    <div className="relative">
      <div className="bg-secondary rounded-lg p-3 pr-10 font-mono text-xs break-all">
        {command}
      </div>
      <button
        type="button"
        onClick={() => onCopy(command, id)}
        className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-muted transition-colors"
        aria-label={label}
      >
        {isCopied ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
    </div>
  );
};

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export const FirstRunExperience: React.FC<FirstRunExperienceProps> = ({
  showCodingAgentsBanner,
}) => {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [sampleDataError, setSampleDataError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleViewSampleData = async () => {
    setIsLoading(true);
    setSampleDataError(null);
    try {
      await loadSampleData();
      navigate('/agent-traces');
      // Force a full reload so data state is re-evaluated against sample data.
      window.location.reload();
    } catch (error) {
      console.error('[FirstRunExperience] Failed to load sample data:', error);
      setSampleDataError(
        'Failed to load sample data. Please try again or contact support if the issue persists.',
      );
      setIsLoading(false);
    }
  };

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Leave the command visible and selectable on clipboard API failure.
      console.warn('[FirstRunExperience] Clipboard API not available');
    }
  };

  return (
    <div
      className="p-6 max-w-6xl mx-auto space-y-14"
      data-testid="first-run-experience"
    >
      {/* ================================================================== */}
      {/* HERO                                                                */}
      {/* ================================================================== */}
      <section className="text-center space-y-5 pt-2">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] max-w-3xl mx-auto">
          Know if your agent is actually working.
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Agents are non-deterministic. See, measure, and improve them locally in under a minute — no setup required.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Button
            size="lg"
            onClick={handleViewSampleData}
            disabled={isLoading}
            aria-busy={isLoading}
            className="w-full sm:w-auto bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
          >
            <Zap className="mr-1 h-5 w-5" />
            {isLoading ? 'Loading…' : 'Explore sample data'}
          </Button>
          <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
            <Link to="/settings">
              <Server className="mr-1 h-5 w-5" />
              Connect your agent
            </Link>
          </Button>
        </div>

        <button
          type="button"
          onClick={() => {
            document
              .getElementById('self-host')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <Terminal className="h-3.5 w-3.5" />
          <span>When ready — self-host with Docker or manage in AWS</span>
          <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
        </button>

        {sampleDataError && (
          <p
            role="alert"
            className="text-sm text-destructive max-w-md mx-auto"
          >
            {sampleDataError}
          </p>
        )}
      </section>

      {/* ================================================================== */}
      {/* ALSO AVAILABLE                                                      */}
      {/* ================================================================== */}
      {showCodingAgentsBanner && (
        <Link
          to="/coding-agents"
          className="group flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/40 px-5 py-3 text-sm hover:border-purple-500/40 hover:bg-background/60 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate">
              <span className="font-medium text-foreground">Also available:</span>{' '}
              AI Dev Tools analytics for Claude Code, Kiro, and Codex.
            </span>
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-purple-400 group-hover:text-purple-300 shrink-0">
            View analytics
            <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
          </span>
        </Link>
      )}

      {/* ================================================================== */}
      {/* JOURNEY                                                             */}
      {/* ================================================================== */}
      <section aria-labelledby="journey-heading" className="space-y-6">
        <div className="text-center">
          <h2 id="journey-heading" className="text-2xl font-semibold tracking-tight">
            From zero to trusted agent, in four steps.
          </h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 lg:gap-0 relative">
          {JOURNEY_STEPS.map((step, index) => {
            const Icon = step.icon;
            const isLast = index === JOURNEY_STEPS.length - 1;
            return (
              <div
                key={step.title}
                className={cn(
                  'relative flex flex-col gap-3 px-4 lg:px-5',
                  // Vertical rail on mobile (left-border), horizontal connector on desktop.
                  'lg:border-l-0 border-l border-dashed border-border pl-6 lg:pl-5 ml-4 lg:ml-0',
                )}
              >
                {/* Icon + number */}
                <div className="flex items-center gap-3">
                  <div className="relative w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400 shrink-0">
                    <Icon className="h-5 w-5" />
                    <span className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-background border border-border text-[11px] font-semibold flex items-center justify-center text-muted-foreground">
                      {index + 1}
                    </span>
                  </div>
                  {/* Horizontal connector (desktop only) */}
                  {!isLast && (
                    <div
                      aria-hidden
                      className="hidden lg:flex flex-1 items-center gap-1"
                    >
                      <div className="flex-1 h-px bg-gradient-to-r from-purple-500/40 to-transparent" />
                      <ArrowRight className="h-3.5 w-3.5 text-purple-500/60 shrink-0" />
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-snug">
                    {step.copy}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ================================================================== */}
      {/* VALUE                                                               */}
      {/* ================================================================== */}
      <section aria-labelledby="value-heading" className="space-y-6">
        <div className="text-center">
          <h2 id="value-heading" className="text-2xl font-semibold tracking-tight">
            What you get, out of the box.
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {VALUE_CARDS.map(({ icon: Icon, title, copy }) => (
            <div
              key={title}
              className="p-5 rounded-xl border border-border bg-card/50 hover:border-purple-500/40 hover:-translate-y-0.5 transition-all"
            >
              <div className="w-9 h-9 rounded-lg bg-purple-500/10 text-purple-400 flex items-center justify-center mb-3">
                <Icon className="h-[18px] w-[18px]" />
              </div>
              <h3 className="text-sm font-semibold mb-1.5 leading-snug">
                {title}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {copy}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================== */}
      {/* SCALE MOMENT                                                        */}
      {/* ================================================================== */}
      <section
        id="self-host"
        aria-labelledby="scale-heading"
        className="relative rounded-2xl border border-border p-6 sm:p-8 overflow-hidden bg-gradient-to-br from-purple-500/[0.06] via-transparent to-blue-500/[0.04] scroll-mt-24"
      >
        <h2 id="scale-heading" className="text-xl font-semibold tracking-tight mb-2">
          When your agent graduates from prototype.
        </h2>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
          Local is great for testing. Production traffic is a different beast. When the data gets
          big — thousands of runs, months of history, cross-team comparisons — Agent Health scales
          with you. Persist evaluations, stream high-volume telemetry, and keep a long-term record
          of how your agent is evolving.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {/* Self-hosted */}
          <div className="rounded-xl border border-border/60 bg-background/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Self-hosted (Docker)
              </span>
            </div>
            <CopyableCommand
              command={DOCKER_INSTALL_CMD}
              label="Copy Docker install command"
              id="docker"
              copiedId={copiedId}
              onCopy={handleCopy}
            />
            <p className="text-xs text-muted-foreground">
              Clones the repo, brings up the stack, and launches Agent Health locally.
            </p>
          </div>

          {/* Managed */}
          <div className="rounded-xl border border-border/60 bg-background/40 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Managed (CloudFormation)
              </span>
            </div>
            <CopyableCommand
              command={CFN_CREATE_STACK_CMD}
              label="Copy CloudFormation create-stack command"
              id="cfn-create"
              copiedId={copiedId}
              onCopy={handleCopy}
            />
            <CopyableCommand
              command={CFN_CONFIGURE_CMD}
              label="Copy Agent Health configure command"
              id="cfn-configure"
              copiedId={copiedId}
              onCopy={handleCopy}
            />
            <p className="text-xs text-muted-foreground">
              Provisions observability storage, then auto-configures Agent Health.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
