/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import {
  LayoutDashboard,
  Settings,
  ClipboardList,
  FlaskConical,
  Activity,
  ChevronRight,
  TestTube,
} from "lucide-react";
import OpenSearchLogo from "@/assets/opensearch-logo.svg";
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
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";

interface LayoutProps {
  children: React.ReactNode;
}

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/traces", icon: Activity, label: "Agent Traces" },
];

const evalsSubItems = [
  { to: "/test-cases", label: "Test Cases" },
  { to: "/benchmarks", label: "Benchmarks" },
];

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { status, version, loading } = useServerStatus();

  // Determine if evals section should be open based on current path
  const isEvalsPath = location.pathname.startsWith("/test-cases") ||
                      location.pathname.startsWith("/benchmarks");
  // Keep evals dropdown always open
  const [evalsOpen, setEvalsOpen] = useState(true);

  const handleEvalsClick = () => {
    setEvalsOpen(true);
    navigate("/benchmarks");
  };

  return (
    <SidebarProvider className="h-screen overflow-hidden">
      <Sidebar collapsible="none" className="h-screen flex-shrink-0">
        <SidebarHeader className="p-4 border-b border-sidebar-border">
          <div className="flex items-center space-x-3">
            <img src={OpenSearchLogo} alt="OpenSearch" className="w-8 h-8" />
            <div>
              <h1 className="text-[15px] font-bold tracking-tight whitespace-nowrap">
                <span className="text-[#015aa3]">Open</span>Search AgentHealth
              </h1>
              <p className="text-[10px] text-sidebar-foreground/70">
                Agentic Observability
              </p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === item.to}
                      tooltip={item.label}
                    >
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}

                {/* Evals collapsible section */}
                <Collapsible
                  open={evalsOpen}
                  onOpenChange={setEvalsOpen}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip="Evals"
                      isActive={isEvalsPath}
                      onClick={handleEvalsClick}
                    >
                      <TestTube />
                      <span>Evals</span>
                      <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {evalsSubItems.map((item) => (
                          <SidebarMenuSubItem key={item.to}>
                            <SidebarMenuSubButton
                              asChild
                              isActive={location.pathname === item.to || location.pathname.startsWith(item.to + "/")}
                            >
                              <Link to={item.to}>{item.label}</Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname === "/settings"}
                    tooltip="Settings"
                  >
                    <Link to="/settings">
                      <Settings />
                      <span>Settings</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-3 border-t border-sidebar-border sticky bottom-0 bg-sidebar">
          <Card className="bg-sidebar-accent/50 border-sidebar-border">
            <CardContent className="p-3">
              <h4 className="text-xs font-semibold text-sidebar-foreground/70 uppercase mb-2">
                Status
              </h4>
              <div className="flex items-center space-x-2 text-sm">
                <span
                  className={`w-2 h-2 rounded-full ${
                    status === 'online'
                      ? 'bg-green-400 animate-pulse'
                      : 'bg-red-500'
                  }`}
                ></span>
                <span className={status === 'online' ? 'text-green-400' : 'text-red-500'}>
                  {status === 'online' ? 'Server Online' : 'Server Offline'}
                </span>
              </div>
              <div className="mt-2 text-xs text-sidebar-foreground/50 font-mono">
                {loading ? '...' : version ? `v${version}` : '—'}
              </div>
            </CardContent>
          </Card>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="overflow-y-auto">{children}</SidebarInset>
    </SidebarProvider>
  );
};
