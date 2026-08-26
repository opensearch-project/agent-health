/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, createContext, useContext } from "react";
import {
  LayoutDashboard,
  Settings,
  ChevronDown,
  Gauge,
  Activity,
  Search,
  TestTube,
  BarChart3,
  MessageSquare,
  Wand2,
} from "lucide-react";
import OpenSearchLogoDark from "@/assets/opensearch-logo.svg";
import OpenSearchLogoLight from "@/assets/opensearch-logo-light.svg";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useServerStatus } from "@/hooks/useServerStatus";
import { usePersistedState } from "@/hooks/usePersistedState";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarInset,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { AssistantProvider } from "@/components/assistant-ui/AssistantProvider";
import { AssistantModal } from "@/components/assistant-ui/AssistantModal";

interface LayoutProps {
  children: React.ReactNode;
}

// Create context for sidebar collapse control
interface SidebarCollapseContextType {
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
}

const SidebarCollapseContext = createContext<SidebarCollapseContextType | null>(null);

export const useSidebarCollapse = () => {
  const context = useContext(SidebarCollapseContext);
  if (!context) {
    throw new Error('useSidebarCollapse must be used within Layout');
  }
  return context;
};

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Overview", tooltip: "Dashboard and quick stats", testId: "nav-overview" },
  { to: "/agent-traces", icon: Activity, label: "Agent Traces", tooltip: "View and debug agent executions", testId: "nav-agent-traces" },
];

const navItemsAfterEvaluation = [
  { to: "/skills", icon: Wand2, label: "Skills", tooltip: "Evaluate and improve AgentSkills", testId: "nav-skills" },
  { to: "/coding-agents", icon: BarChart3, label: "AI Dev Tools", tooltip: "Claude Code, Kiro & Codex analytics", testId: "nav-coding-agents" },
  { to: "/assistant", icon: MessageSquare, label: "Assistant", tooltip: "AI assistant for help and analysis", testId: "nav-assistant" },
];


export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, version, loading, features } = useServerStatus();

  // Determine if testing section should be open based on current path
  const isTestingPath = location.pathname.startsWith("/test-cases") ||
                      location.pathname.startsWith("/benchmarks") ||
                      location.pathname.startsWith("/evaluators");
  // Keep testing dropdown always open
  const [testingOpen, setTestingOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCollapsed, setIsCollapsed] = usePersistedState<boolean>('sidebar:collapsed', false);

  // Chrome-vertical-tabs-style flyout: when the sidebar is collapsed to the
  // icon rail, hovering the rail temporarily expands it as an OVERLAY — the
  // content area keeps the rail width and never reflows; leaving the sidebar
  // collapses it again. `isCollapsed` stays the persisted pin preference; the
  // expand button while flying out acts as "pin open".
  const [isHoverExpanded, setIsHoverExpanded] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  useEffect(() => { setIsHoverExpanded(false); }, [isCollapsed]);
  // What the sidebar visually renders as (rail vs full) — every label/layout
  // conditional below reads this; only the pin controls read `isCollapsed`.
  const collapsed = isCollapsed && !isHoverExpanded;

  // Collapse the nav when landing on a *specific run* URL (single-run inspect /
  // detail views are dense — no need to waste space on the global nav). Matches
  // /runs/<id>[/inspect] and /evaluations/runs/<id> but NOT the bare run LISTS
  // (…/runs) or /evaluations/runs/new. Fires on direct landing too (first mount
  // with the ref still false). The collapsed/expanded state itself is persisted
  // (usePersistedState above), so it's remembered across navigations/reloads and
  // the user can re-expand — that choice sticks until the next run URL.
  const isRunDetailRoute = useMemo(
    () => /\/runs\/(?!new(?:\/|$))[^/]+/.test(location.pathname),
    [location.pathname]
  );
  const wasRunDetailRoute = useRef(false);
  useEffect(() => {
    if (isRunDetailRoute && !wasRunDetailRoute.current) {
      setIsCollapsed(true);
    }
    wasRunDetailRoute.current = isRunDetailRoute;
  }, [isRunDetailRoute, setIsCollapsed]);
  
  // Detect theme for logo switching
  const [isDarkMode, setIsDarkMode] = useState(false);
  
  useEffect(() => {
    // Check initial theme
    const checkTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setIsDarkMode(isDark);
    };
    
    checkTheme();
    
    // Watch for theme changes
    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
    
    return () => observer.disconnect();
  }, []);
  
  const OpenSearchLogo = isDarkMode ? OpenSearchLogoDark : OpenSearchLogoLight;

  return (
    <SidebarCollapseContext.Provider value={{ isCollapsed, setIsCollapsed }}>
      <SidebarProvider className="h-screen overflow-hidden">
        {/* Hover zone reserves the LAYOUT width (rail when pinned collapsed) so
            the flyout overlays content instead of reflowing it. */}
        <div
          className="relative h-screen flex-shrink-0 transition-[width] duration-200"
          style={{ width: isCollapsed ? '64px' : '180px' }}
          data-testid="sidebar-hover-zone"
          onMouseEnter={() => {
            if (!isCollapsed) return;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            hoverTimer.current = setTimeout(() => setIsHoverExpanded(true), 150);
          }}
          onMouseLeave={() => {
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            if (!isCollapsed) return;
            hoverTimer.current = setTimeout(() => setIsHoverExpanded(false), 250);
          }}
        >
        <Sidebar
        collapsible="none"
        className="transition-all duration-200"
        style={{
          width: collapsed ? '64px' : '180px',
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          zIndex: isHoverExpanded ? 50 : undefined,
          background: isDarkMode ? 'hsl(var(--background))' : '#FFFFFF',
          borderRight: isDarkMode ? '1px solid #343741' : '1px solid #D3DAE6',
          boxShadow: isHoverExpanded
            ? '0px 12px 40px rgba(0, 0, 0, 0.45), 0px 0px 12px rgba(0, 0, 0, 0.15)'
            : '0px 0px 12px rgba(0, 0, 0, 0.05), 0px 0px 4px rgba(0, 0, 0, 0.05), 0px 0px 2px rgba(0, 0, 0, 0.05)',
          borderRadius: '0px 24px 24px 0px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: '37px',
          overflow: 'hidden'
        }}
        data-testid="sidebar"
      >
        <SidebarHeader className="px-3 pt-2 pb-3 border-b">
          {/* Collapse/Expand button - own row at top */}
          <div className="flex justify-end mb-1.5">
            {!isCollapsed ? (
              <button
                onClick={() => setIsCollapsed(true)}
                className="p-1 hover:bg-accent rounded transition-colors"
                aria-label="Collapse sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path fillRule="evenodd" clipRule="evenodd" d="M1.01409 7.38164C1.00488 7.41958 1 7.45922 1 7.5C1 7.51141 1.00038 7.52273 1.00113 7.53395C0.987424 7.93484 1.13358 8.34018 1.43959 8.64619L3.56091 10.7675C3.75618 10.9628 4.07276 10.9628 4.26802 10.7675C4.46328 10.5723 4.46328 10.2557 4.26802 10.0604L2.20761 8H14.5C14.7761 8 15 7.77614 15 7.5C15 7.22386 14.7761 7 14.5 7H2.37868L4.26802 5.11066C4.46328 4.9154 4.46328 4.59882 4.26802 4.40355C4.07276 4.20829 3.75618 4.20829 3.56091 4.40355L1.43959 6.52487C1.19868 6.76578 1.05685 7.06825 1.01409 7.38164ZM14.5 3H7.5C7.22386 3 7 3.22386 7 3.5C7 3.77614 7.22386 4 7.5 4H14.5C14.7761 4 15 3.77614 15 3.5C15 3.22386 14.7761 3 14.5 3ZM14.5 11H7.5C7.22386 11 7 11.2239 7 11.5C7 11.7761 7.22386 12 7.5 12H14.5C14.7761 12 15 11.7761 15 11.5C15 11.2239 14.7761 11 14.5 11Z" fill="currentColor"/>
                </svg>
              </button>
            ) : (
              <button
                onClick={() => setIsCollapsed(false)}
                className="w-full p-1.5 hover:bg-accent rounded transition-colors flex items-center justify-center"
                aria-label="Expand sidebar"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            )}
          </div>

          {/* Logo + Title */}
          {!collapsed && (
            <div className="flex items-center gap-2.5 mb-3">
              <img src={OpenSearchLogo} alt="OpenSearch" className="w-7 h-7 flex-shrink-0" />
              <div className="min-w-0">
                <h1 className="text-sm font-semibold leading-tight">
                  OpenSearch AgentHealth
                </h1>
                <p className="text-[11px] text-muted-foreground leading-tight mt-1">
                  Agentic Observability
                </p>
              </div>
            </div>
          )}
          {collapsed && (
            <div className="flex items-center justify-center mb-1">
              <img src={OpenSearchLogo} alt="OpenSearch" className="w-7 h-7" />
            </div>
          )}

          {/* Search bar - only show when expanded */}
          {!collapsed && (
            <div className="relative">
              <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search the menu"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-7 h-7 text-xs md:text-xs"
              />
            </div>
          )}
        </SidebarHeader>

        <SidebarContent className="px-1.5 py-2">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="space-y-1">
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === item.to}
                      tooltip={collapsed ? item.label : undefined}
                      data-testid={item.testId}
                      className="h-9"
                    >
                      <Link to={item.to} className={collapsed ? 'justify-center' : ''}>
                        <item.icon className="h-3.5 w-3.5" />
                        {!collapsed && <span className="text-xs">{item.label}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}


                {/* Evaluations (evals3) collapsible section */}
                {!collapsed && (
                  <Collapsible defaultOpen={true}>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        asChild
                        tooltip="Evaluations"
                        isActive={location.pathname.startsWith("/evaluations")}
                        className="h-9 w-full"
                      >
                        <div className="flex items-center w-full">
                          {/* Same testid as the rail variant: hovering the rail
                              to click Evaluations swaps in this expanded row
                              (flyout) mid-click — a stable testid lets the click
                              retarget to the same destination. */}
                          <Link to="/evaluations/runs" className="flex items-center gap-2 flex-1 min-w-0" data-testid="nav-evals3">
                            <Gauge className="h-3.5 w-3.5" />
                            <span className="text-xs">Evaluations</span>
                          </Link>
                          <CollapsibleTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="p-0.5 rounded hover:bg-muted-foreground/20 transition-colors ml-auto"
                              aria-label="Toggle evaluations submenu"
                            >
                              <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200" />
                            </button>
                          </CollapsibleTrigger>
                        </div>
                      </SidebarMenuButton>
                      <CollapsibleContent>
                        <SidebarMenuSub className="ml-4 mt-1 space-y-1">
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={location.pathname === "/evaluations/benchmarks" || (location.pathname.startsWith("/evaluations/benchmarks/") && !/\/evaluations\/benchmarks\/[^/]+\/runs\/[^/]+/.test(location.pathname))} data-testid="nav-evals3-benchmarks" className="h-8">
                              <Link to="/evaluations/benchmarks" className="text-xs">Benchmarks</Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={location.pathname.startsWith("/evaluations/test-cases")} data-testid="nav-evals3-test-cases" className="h-8">
                              <Link to="/evaluations/test-cases" className="text-xs">Test Cases</Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={location.pathname === "/evaluations/runs" || /\/evaluations\/benchmarks\/[^/]+\/runs\/[^/]+/.test(location.pathname)} data-testid="nav-evals3-runs" className="h-8">
                              <Link to="/evaluations/runs" className="text-xs">Evaluation Runs</Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                          <SidebarMenuSubItem>
                            <SidebarMenuSubButton asChild isActive={location.pathname.startsWith("/evaluators")} data-testid="nav-evaluators" className="h-8">
                              <Link to="/evaluators" className="text-xs">Evaluators</Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                )}

                {/* Evaluations icon only when collapsed — the closed-navbar
                    Evaluations button jumps straight to Evaluation Runs (the
                    most-used evals3 surface), not the Benchmarks list. */}
                {collapsed && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location.pathname.startsWith("/evaluations")} tooltip="Evaluations" data-testid="nav-evals3" className="h-9">
                      <Link to="/evaluations/runs" className="justify-center">
                        <Gauge className="h-4 w-4" />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}

                {navItemsAfterEvaluation.filter(item => item.to !== '/coding-agents' || features.codingAgentAnalytics).map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === item.to}
                      tooltip={collapsed ? item.label : undefined}
                      data-testid={item.testId}
                      className="h-9"
                    >
                      <Link to={item.to} className={collapsed ? 'justify-center' : ''}>
                        <item.icon className="h-3.5 w-3.5" />
                        {!collapsed && <span className="text-xs">{item.label}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}

                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname === "/settings"}
                    tooltip={collapsed ? "Settings" : "Configure connections and preferences"}
                    data-testid="nav-settings"
                    className="h-9"
                  >
                    <Link to="/settings" className={collapsed ? 'justify-center' : ''}>
                      <Settings className="h-3.5 w-3.5" />
                      {!collapsed && <span className="text-xs">Settings</span>}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-3 border-t sticky bottom-0 bg-background">
          {!collapsed ? (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Status
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      status === 'online'
                        ? 'bg-green-500'
                        : 'bg-red-500'
                    }`}
                  ></span>
                  <span className="text-xs">
                    {status === 'online' ? 'Server Online' : 'Server Offline'}
                  </span>
                </div>
              </div>
              {version && (
                <div className="text-xs text-muted-foreground">
                  Version {version}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center space-y-3">
              <span
                className={`w-3 h-3 rounded-full ${
                  status === 'online'
                    ? 'bg-green-500'
                    : 'bg-red-500'
                }`}
                title={status === 'online' ? 'Server Online' : 'Server Offline'}
              ></span>
              {version && (
                <div className="text-xs text-muted-foreground writing-mode-vertical" title={`Version ${version}`}>
                  {version.slice(0, 3)}
                </div>
              )}
            </div>
          )}
        </SidebarFooter>
      </Sidebar>
      </div>

      <SidebarInset className="overflow-y-auto dashboard-gradient-bg">
        <AssistantProvider>
          {children}
          <AssistantModal />
        </AssistantProvider>
      </SidebarInset>
      </SidebarProvider>
    </SidebarCollapseContext.Provider>
  );
};
