/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Gauge, TrendingUp, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const WORKFLOW_CARD_HIDDEN_KEY = 'agent-health-workflow-card-hidden';

/**
 * How it works panel
 * Presents the continuous improvement loop: Trace → Evaluate → Improve
 */
export const WorkflowNavigator: React.FC = () => {
  const [isHidden, setIsHidden] = useState(false);

  useEffect(() => {
    const hidden = localStorage.getItem(WORKFLOW_CARD_HIDDEN_KEY) === 'true';
    setIsHidden(hidden);
  }, []);

  const handleDontShowAgain = () => {
    localStorage.setItem(WORKFLOW_CARD_HIDDEN_KEY, 'true');
    setIsHidden(true);
    // Dispatch custom event to notify Dashboard
    window.dispatchEvent(new CustomEvent('workflow-card-hidden'));
  };

  if (isHidden) {
    return null;
  }

  return (
    <Card className="relative overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">How it works</CardTitle>
        <CardDescription className="text-xs">
          Agent Health turns traces into insight, and insight into measurable improvement.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Three stages with icons showing the cycle */}
        <div className="relative pb-6">
          <div className="flex items-center justify-center gap-2 py-2">
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center">
                <Activity className="h-5 w-5 text-white" />
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 rounded-full bg-purple-500 flex items-center justify-center">
                <Gauge className="h-5 w-5 text-white" />
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <div className="flex flex-col items-center">
              <div className="w-10 h-10 rounded-full bg-violet-500 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-white" />
              </div>
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

        {/* Three stages with outcome-oriented copy */}
        <div className="space-y-2 text-center">
          <div className="space-y-0.5">
            <div className="flex items-center justify-center gap-1.5 text-blue-500">
              <Activity className="h-4 w-4" />
              <span className="text-sm font-medium">Trace</span>
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              See exactly what your agent did
            </p>
          </div>

          <div className="space-y-0.5">
            <div className="flex items-center justify-center gap-1.5 text-purple-500">
              <Gauge className="h-4 w-4" />
              <span className="text-sm font-medium">Evaluate</span>
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              Benchmark and measure quality before production
            </p>
          </div>

          <div className="space-y-0.5">
            <div className="flex items-center justify-center gap-1.5 text-violet-500">
              <TrendingUp className="h-4 w-4" />
              <span className="text-sm font-medium">Improve</span>
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              Make informed decisions with recorded history
            </p>
          </div>
        </div>

        {/* Marketing anchor line */}


        {/* CTAs with pulsating animations */}
        <style>{`
          @keyframes pulse-glow {
            0%, 100% {
              box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.7);
            }
            50% {
              box-shadow: 0 0 0 8px rgba(139, 92, 246, 0);
            }
          }
          
          @keyframes pulse-border {
            0%, 100% {
              border-color: rgba(139, 92, 246, 0.5);
              box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.4);
            }
            50% {
              border-color: rgba(139, 92, 246, 1);
              box-shadow: 0 0 0 4px rgba(139, 92, 246, 0);
            }
          }
          
          .pulse-glow-btn {
            animation: pulse-glow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            background: linear-gradient(135deg, #8B5CF6 0%, #A855F7 100%);
          }
          
          .pulse-glow-btn:hover {
            background: linear-gradient(135deg, #7C3AED 0%, #9333EA 100%);
          }
          
          .pulse-border-btn {
            animation: pulse-border 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            border: 2px solid rgba(139, 92, 246, 0.5);
          }
        `}</style>
        
        <div className="flex flex-col gap-2">
          <Button asChild size="sm" className="pulse-glow-btn border-0 text-white">
            <Link to="/benchmarks">Run Benchmark</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="pulse-border-btn gap-1">
            <Link to="/agent-traces">
              View Traces
              <ArrowRight className="h-3 w-3" />
            </Link>
          </Button>
        </div>

        {/* Don't show again button - subtle and small */}
        <div className="text-center pt-1">
          <button
            onClick={handleDontShowAgain}
            className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors underline decoration-dotted underline-offset-2"
          >
            Don't show again
          </button>
        </div>
      </CardContent>
    </Card>
  );
};
