/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Zap, CheckCircle2, Activity, Gauge, TrendingUp, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { loadSampleData } from '@/config/sampleData';

/**
 * First Run Experience component
 * 
 * Displayed when users have no configured storage cluster.
 * Provides guided onboarding with improved IA:
 * - Hero section with clear value proposition
 * - Left card: Workflow (Trace → Evaluate → Improve)
 * - Right card: Features preview
 */
export const FirstRunExperience: React.FC = () => {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);

  const handleViewSampleData = async () => {
    setIsLoading(true);
    try {
      await loadSampleData();
      
      // Navigate to dashboard (which will now show data)
      // The page will reload and show the standard dashboard with sample data
      navigate('/');
      
      // Force a page reload to ensure data state is re-evaluated
      window.location.reload();
    } catch (error) {
      console.error('[FirstRunExperience] Failed to load sample data:', error);
      
      // Show error message using alert (simple fallback)
      alert('Failed to load sample data. Please try again or contact support if the issue persists.');
      
      setIsLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-16" data-testid="first-run-experience">
      {/* Hero Section */}
      <div className="text-center space-y-6">
        <div className="flex justify-center">
          <img 
            src="/opensearch-logo-dark.svg" 
            alt="OpenSearch Logo" 
            className="w-16 h-16 dark:block hidden"
          />
          <img 
            src="/opensearch-logo-light.svg" 
            alt="OpenSearch Logo" 
            className="w-16 h-16 dark:hidden block"
          />
        </div>
        
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight">
            Welcome to Agent Health
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Make your AI agents measurable, reliable, and production-ready.
          </p>
        </div>

        <div className="pt-2 space-y-3">
          <div className="flex items-center justify-center gap-3">
            <Button 
              size="lg" 
              asChild
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white"
            >
              <Link to="/settings/clusters">
                Configure Your Cluster
              </Link>
            </Button>
            
            <Button 
              size="lg" 
              variant="outline"
              onClick={handleViewSampleData}
              disabled={isLoading}
            >
              <Zap className="mr-2 h-5 w-5" />
              {isLoading ? 'Loading...' : 'Explore with Sample Data'}
            </Button>
          </div>
          
          <p className="text-sm text-muted-foreground">
            Explore a fully configured environment with real traces and benchmarks.
          </p>
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
              <div className="flex items-start gap-3">
                <Activity className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Trace</h3>
                  <p className="text-sm text-muted-foreground">
                    See exactly what your agent did.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Gauge className="h-5 w-5 text-purple-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Evaluate</h3>
                  <p className="text-sm text-muted-foreground">
                    Benchmark and measure quality before production.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <TrendingUp className="h-5 w-5 text-violet-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Improve</h3>
                  <p className="text-sm text-muted-foreground">
                    Make informed decisions with recorded history.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right Card: Features */}
        <Card>
          <CardContent className="pt-6 space-y-6">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Key Features</h2>
              <p className="text-sm text-muted-foreground">
                Explore a fully-configured environment with real benchmarks and traces
              </p>
            </div>

            {/* Features List */}
            <div className="space-y-5">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Performance Trends</h3>
                  <p className="text-sm text-muted-foreground">
                    Pass rate, latency, and cost over time.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Benchmark Results</h3>
                  <p className="text-sm text-muted-foreground">
                    Side-by-side evaluation across agents.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Trace Diagnostics</h3>
                  <p className="text-sm text-muted-foreground">
                    Step-by-step execution visibility.
                  </p>
                </div>
              </div>
            </div>

            {/* Footer Link */}
            <div className="pt-6 border-t">
              <p className="text-sm text-muted-foreground text-center">
                Ready to connect your own data?{' '}
                <Link 
                  to="/settings/clusters" 
                  className="text-primary hover:underline font-medium"
                >
                  Configure your cluster
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
