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
  Menu,
  X,
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Route changes close the off-canvas navigation after a mobile selection.
  useEffect(() => setMobileNavOpen(false), [location.pathname]);

  // Chrome-vertical-tabs-style hover-open: when the sidebar is pinned
  // collapsed to the icon rail, hovering (or keyboard-focusing) it temporarily
  // expands the FULL sidebar as an OVERLAY — the layout area keeps reserving
  // the rail width so content never reflows — and leaving/blurring it
  // collapses it again. `isCollapsed` stays the persisted PIN preference (only
  // the collapse/expand button and setIsCollapsed touch it); every visual
  // conditional below reads `collapsed`, which folds in the momentary hover
  // state. Mouse uses short intent delays (150ms open / 250ms close) to avoid
  // flicker when crossing the rail; keyboard focus opens immediately (no
  // delay) and closes on blur so Tab users get the same reveal without
  // relying on a mouse gesture.
  const [isHoverExpanded, setIsHoverExpanded] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverZoneRef = useRef<HTMLDivElement>(null);
  // Tracks whether the pointer is currently over the hover zone, independent
  // of focus — lets the blur handler know the mouse still "owns" the open
  // state (so it doesn't collapse under a stationary cursor).
  const isMouseOverRef = useRef(false);
  // Tracks whether OUR OWN onFocus handler opened the overlay for a genuine
  // keyboard-focus reason (set only when `isCollapsed` was already true at
  // focus time, i.e. it actually drove an open). Deliberately NOT derived
  // from raw `document.activeElement` containment: the collapse/expand
  // toggle button is the same DOM node across renders (React reuses it —
  // same element type/position in the ternary), so it keeps native DOM focus
  // after a mouse *click* on it even though no keyboard interaction happened
  // — containment alone would wrongly treat that residual click-focus as
  // "keyboard is holding this open" and block the mouse-leave collapse.
  const isKeyboardOpenRef = useRef(false);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  useEffect(() => { setIsHoverExpanded(false); }, [isCollapsed]);
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
        {mobileNavOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        {/* Hover zone reserves the LAYOUT width (rail when pinned collapsed) so
            the flyout overlays content instead of reflowing it on desktop. On
            phones it becomes a fixed, off-canvas drawer instead (zero layout
            footprint — content is never pushed — sliding in/out via
            translate), matching the mobile off-canvas navigation contract.
            Mouse and keyboard-focus both drive the same isHoverExpanded
            state (see onFocus/onBlur below) — `hoverZoneRef` is what lets
            onBlur tell a Tab-within-the-rail from a Tab actually leaving it. */}
        <div
          ref={hoverZoneRef}
          className={`fixed inset-y-0 left-0 z-50 h-screen flex-shrink-0 transition-transform duration-300 lg:relative lg:inset-auto lg:z-auto lg:transform-none lg:transition-[width] lg:duration-200 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}
          style={{ width: isCollapsed ? '64px' : '180px' }}
          data-testid="sidebar-hover-zone"
          onMouseEnter={() => {
            isMouseOverRef.current = true;
            if (!isCollapsed) return;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            hoverTimer.current = setTimeout(() => setIsHoverExpanded(true), 150);
          }}
          onMouseLeave={() => {
            isMouseOverRef.current = false;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            if (!isCollapsed) return;
            hoverTimer.current = setTimeout(() => {
              // A keyboard user may still hold it open via focus (mouse left
              // but Tab hasn't) — don't collapse the overlay out from under
              // them. `isKeyboardOpenRef` (set only by our own onFocus below,
              // gated on isCollapsed) intentionally does NOT fire for the
              // collapse/expand toggle button retaining native DOM focus
              // after a mouse click on it — that button is the same DOM node
              // across renders (React reuses it: same element type/position
              // in the ternary), so raw focus-containment alone would
              // wrongly treat residual click-focus as "keyboard is holding
              // this open".
              if (isKeyboardOpenRef.current) return;
              setIsHoverExpanded(false);
            }, 250);
          }}
          onFocus={() => {
            if (!isCollapsed) return;
            isKeyboardOpenRef.current = true;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            setIsHoverExpanded(true);
          }}
          onBlur={(e) => {
            if (!isCollapsed) return;
            const next = e.relatedTarget as Node | null;
            if (next && hoverZoneRef.current?.contains(next)) return;
            isKeyboardOpenRef.current = false;
            // The mouse may still be hovering the zone (e.g. focus moved out
            // via a non-Tab path while the cursor never moved) — mouse
            // ownership of the open state continues until it actually leaves.
            if (isMouseOverRef.current) return;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            setIsHoverExpanded(false);
          }}
          onKeyDown={(e) => {
            // Escape is a second, independent way out of the keyboard-opened
            // overlay (on top of Shift+Tab-ing past the zone's first
            // focusable element, handled by onBlur's relatedTarget check
            // above) — a familiar a11y convention for dismissing a
            // transient overlay without hunting for the exact edge of its
            // tab range. Focus deliberately stays where it is (the DOM
            // nodes don't unmount, only the CSS width/labels change), so
            // there's nowhere stray to reset it to.
            if (e.key !== 'Escape' || !isCollapsed || !isHoverExpanded) return;
            isKeyboardOpenRef.current = false;
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
            setIsHoverExpanded(false);
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
          background: 'hsl(var(--background))',
          borderRight: '1px solid hsl(var(--border))',
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
                          {/* Same testid as the collapsed rail's icon button: hovering
                              the rail to click Evaluations swaps in this expanded
                              row (hover-open) mid-click — a stable testid lets the
                              click retarget to the same destination. */}
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

      <SidebarInset className="overflow-y-auto dashboard-gradient-bg mobile-responsive-content">
        <div className="sticky top-0 z-30 flex h-12 shrink-0 items-center justify-between border-b bg-background/95 px-3 backdrop-blur lg:hidden">
          <button
            type="button"
            className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md hover:bg-accent"
            aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(open => !open)}
          >
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="text-sm font-semibold">AgentHealth</span>
          <span className="w-10" aria-hidden="true" />
        </div>
        <AssistantProvider>
          {children}
          <AssistantModal />
        </AssistantProvider>
      </SidebarInset>
      </SidebarProvider>
    </SidebarCollapseContext.Provider>
  );
};
