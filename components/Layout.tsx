import React from "react";
import {
  LayoutDashboard,
  Settings,
  ClipboardList,
  Server,
  FlaskConical,
  Activity,
} from "lucide-react";
import OpenSearchLogo from "@/assets/opensearch-logo.svg";
import { Link, useLocation } from "react-router-dom";
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
  SidebarProvider,
  SidebarInset,
} from "@/components/ui/sidebar";
import { Card, CardContent } from "@/components/ui/card";

interface LayoutProps {
  children: React.ReactNode;
}

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/test-cases", icon: ClipboardList, label: "Test Cases" },
  { to: "/experiments", icon: FlaskConical, label: "Experiments" },
  { to: "/traces", icon: Activity, label: "Live Traces" },
];

const settingsItems = [
  { to: "/config", icon: Server, label: "Agents & Models" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();

  return (
    <SidebarProvider>
      <Sidebar collapsible="none" className="h-screen">
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {settingsItems.map((item) => (
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-3 border-t border-sidebar-border">
          <Card className="bg-sidebar-accent/50 border-sidebar-border">
            <CardContent className="p-3">
              <h4 className="text-xs font-semibold text-sidebar-foreground/70 uppercase mb-2">
                Status
              </h4>
              <div className="flex items-center space-x-2 text-sm">
                <span className="w-2 h-2 bg-opensearch-blue rounded-full animate-pulse"></span>
                <span className="text-opensearch-blue">Server Online</span>
              </div>
              <div className="mt-2 text-xs text-sidebar-foreground/50 font-mono">
                v0.0.39-beta
              </div>
            </CardContent>
          </Card>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  );
};
