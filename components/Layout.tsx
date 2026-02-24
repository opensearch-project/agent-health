/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, createContext, useContext } from "react";
import {
  LayoutDashboard,
  Settings,
  ChevronDown,
  Gauge,
  Activity,
  Search,
} from "lucide-react";
import OpenSearchLogoDark from "@/assets/opensearch-logo.svg";
import OpenSearchLogoLight from "@/assets/opensearch-logo-light.svg";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useServerStatus } from "@/hooks/useServerStatus";
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

const testingSubItems = [
  { to: "/benchmarks", label: "Benchmarks", tooltip: "Define success criteria and scoring", testId: "nav-benchmarks" },
  { to: "/test-cases", label: "Test Cases", tooltip: "Create and manage test inputs", testId: "nav-test-cases" },
];

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, version, loading } = useServerStatus();

  // Determine if testing section should be open based on current path
  const isTestingPath = location.pathname.startsWith("/test-cases") ||
                      location.pathname.startsWith("/benchmarks");
  // Keep testing dropdown always open
  const [testingOpen, setTestingOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCollapsed, setIsCollapsed] = useState(false);
  
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
        <Sidebar 
        collapsible="none" 
        className="h-screen flex-shrink-0 transition-all duration-300"
        style={{
          width: isCollapsed ? '64px' : '270px',
          background: isDarkMode ? '#1D1E24' : '#FFFFFF',
          borderRight: isDarkMode ? '1px solid #343741' : '1px solid #D3DAE6',
          boxShadow: '0px 0px 12px rgba(0, 0, 0, 0.05), 0px 0px 4px rgba(0, 0, 0, 0.05), 0px 0px 2px rgba(0, 0, 0, 0.05)',
          borderRadius: '0px 24px 24px 0px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: '37px',
          overflow: 'hidden'
        }}
        data-testid="sidebar"
      >
        <SidebarHeader className="p-4 border-b">
          <div className="flex items-center justify-between mb-4">
            {!isCollapsed && (
              <div className="flex items-center space-x-3">
                <img src={OpenSearchLogo} alt="OpenSearch" className="w-8 h-8" />
                <div>
                  <h1 className="text-sm font-semibold">
                    OpenSearch AgentHealth
                  </h1>
                  <p className="text-xs text-muted-foreground">
                    Agentic Observability
                  </p>
                </div>
              </div>
            )}
            {isCollapsed && (
              <div className="flex items-center justify-center w-full">
                <img src={OpenSearchLogo} alt="OpenSearch" className="w-8 h-8" />
              </div>
            )}
            {!isCollapsed && (
              <button
                onClick={() => setIsCollapsed(true)}
                className="p-1 hover:bg-accent rounded transition-colors"
                aria-label="Collapse sidebar"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path fillRule="evenodd" clipRule="evenodd" d="M1.01409 7.38164C1.00488 7.41958 1 7.45922 1 7.5C1 7.51141 1.00038 7.52273 1.00113 7.53395C0.987424 7.93484 1.13358 8.34018 1.43959 8.64619L3.56091 10.7675C3.75618 10.9628 4.07276 10.9628 4.26802 10.7675C4.46328 10.5723 4.46328 10.2557 4.26802 10.0604L2.20761 8H14.5C14.7761 8 15 7.77614 15 7.5C15 7.22386 14.7761 7 14.5 7H2.37868L4.26802 5.11066C4.46328 4.9154 4.46328 4.59882 4.26802 4.40355C4.07276 4.20829 3.75618 4.20829 3.56091 4.40355L1.43959 6.52487C1.19868 6.76578 1.05685 7.06825 1.01409 7.38164ZM14.5 3H7.5C7.22386 3 7 3.22386 7 3.5C7 3.77614 7.22386 4 7.5 4H14.5C14.7761 4 15 3.77614 15 3.5C15 3.22386 14.7761 3 14.5 3ZM14.5 11H7.5C7.22386 11 7 11.2239 7 11.5C7 11.7761 7.22386 12 7.5 12H14.5C14.7761 12 15 11.7761 15 11.5C15 11.2239 14.7761 11 14.5 11Z" fill="currentColor"/>
                </svg>
              </button>
            )}
          </div>
          
          {/* Search bar - only show when expanded */}
          {!isCollapsed && (
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search the menu"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-9 text-sm"
              />
            </div>
          )}
          
          {/* Expand button when collapsed */}
          {isCollapsed && (
            <button
              onClick={() => setIsCollapsed(false)}
              className="w-full p-2 hover:bg-accent rounded transition-colors flex items-center justify-center"
              aria-label="Expand sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </SidebarHeader>

        <SidebarContent className="px-3 py-2">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="space-y-1">
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === item.to}
                      tooltip={isCollapsed ? item.label : undefined}
                      data-testid={item.testId}
                      className="h-9"
                    >
                      <Link to={item.to} className={isCollapsed ? 'justify-center' : ''}>
                        <item.icon className="h-4 w-4" />
                        {!isCollapsed && <span className="text-sm">{item.label}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}

                {/* Testing collapsible section - only show when expanded */}
                {!isCollapsed && (
                  <Collapsible
                    open={testingOpen}
                    onOpenChange={setTestingOpen}
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton
                          tooltip="Testing"
                          isActive={isTestingPath}
                          className="h-9 w-full"
                        >
                          <Gauge className="h-4 w-4" />
                          <span className="text-sm">Testing</span>
                          <ChevronDown 
                            className={`ml-auto h-4 w-4 transition-transform duration-200 ${
                              testingOpen ? 'rotate-180' : ''
                            }`} 
                          />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub className="ml-4 mt-1 space-y-1">
                          {testingSubItems.map((item) => (
                            <SidebarMenuSubItem key={item.to}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={location.pathname === item.to || location.pathname.startsWith(item.to + "/")}
                                data-testid={item.testId}
                                className="h-8"
                              >
                                <Link to={item.to} className="text-sm">{item.label}</Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                )}
                
                {/* Testing icon only when collapsed */}
                {isCollapsed && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={isTestingPath}
                      tooltip="Testing"
                      data-testid="nav-testing"
                      className="h-9"
                    >
                      <Link to="/benchmarks" className="justify-center">
                        <Gauge className="h-4 w-4" />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}

                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname === "/settings"}
                    tooltip={isCollapsed ? "Settings" : "Configure connections and preferences"}
                    data-testid="nav-settings"
                    className="h-9"
                  >
                    <Link to="/settings" className={isCollapsed ? 'justify-center' : ''}>
                      <Settings className="h-4 w-4" />
                      {!isCollapsed && <span className="text-sm">Settings</span>}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-3 border-t sticky bottom-0 bg-background">
          {!isCollapsed ? (
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
                  <span className="text-sm">
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

      <SidebarInset className="overflow-y-auto">{children}</SidebarInset>
      </SidebarProvider>
    </SidebarCollapseContext.Provider>
  );
};
