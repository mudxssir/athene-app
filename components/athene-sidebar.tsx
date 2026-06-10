"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  BarChart3,
  BarChart2,
  Newspaper,
  GitBranch,
  Users,
  Blocks,
  KeyRound,
  ShieldCheck,
  ClipboardList,
  Bot,
  Database,
  Network,
  Bell,
  Briefcase,
} from "lucide-react";
import { UserButton, useUser } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { useNavigate } from "@/components/ui/kit";
import type { UserRole } from "@/lib/auth/rbac";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

interface SidebarItemProps {
  icon: React.ElementType;
  label: string;
  href: string;
  active?: boolean;
}

/* NavItem — bypasses SidebarMenuButton entirely so Shadcn's
   hardcoded text-sm / data-active:font-medium / sidebar-accent colors
   cannot override our design kit spec:
   11px, 800 weight, uppercase, 0.22em tracking, 11px/14px padding,
   14px border-radius. Active: rgba(160,74,27,.10) bg + primary text
   + 3px left bar at left:-10, top:10, bottom:10.
   Clicks are intercepted by useNavigate() to play exit animations
   before the route actually changes; href is kept for right-click/a11y. */
const SidebarItem = ({ icon: Icon, label, href, active = false }: SidebarItemProps) => {
  const navigate = useNavigate();
  return (
    <SidebarMenuItem className="relative list-none mb-[3px]">
      <a
        href={href}
        onClick={(e) => { e.preventDefault(); navigate(href); }}
        className={cn(
          // Layout
          "relative flex items-center gap-[14px] w-full overflow-hidden",
          "py-[11px] px-[14px] rounded-[14px]",
          // Typography — exact design kit: 11px 800 uppercase 0.22em
          "text-[11px] font-extrabold leading-none uppercase tracking-[0.22em]",
          // Motion
          "transition-all duration-200",
          // State
          active
            ? "bg-[rgba(160,74,27,0.10)] text-primary hover:bg-[rgba(160,74,27,0.14)]"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        {/* Active left bar */}
        {active && (
          <span
            aria-hidden
            className="absolute"
            style={{
              left: -10,
              top: 10,
              bottom: 10,
              width: 3,
              background: "var(--primary)",
              borderRadius: 99,
            }}
          />
        )}
        <Icon size={16} strokeWidth={1.7} className="shrink-0" />
        <span className="group-data-[collapsible=icon]:hidden truncate">{label}</span>
      </a>
    </SidebarMenuItem>
  );
};

const isRouteActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

function AppSidebar({ role, className }: { role: UserRole; className?: string }) {
  const pathname = usePathname();
  const { user } = useUser();

  const primaryItems = [
    { icon: LayoutDashboard, label: "Today",     href: "/dashboard" },
    { icon: Briefcase,       label: "My Work",   href: "/my-work" },
    { icon: MessageSquare,   label: "Ask",       href: "/chat" },
    { icon: Network,         label: "Graph",     href: "/graph" },
    { icon: Newspaper,       label: "Briefings", href: "/briefing" },
    { icon: BarChart3,       label: "Insights",   href: "/insights" },
    { icon: Bell,            label: "Watchlists", href: "/watchlists" },
    { icon: Blocks,          label: "Sources",    href: "/admin/integrations" },
  ];

  const adminItems = [
    { icon: Users,        label: "Users",        href: "/admin/users" },
    { icon: KeyRound,     label: "BYOK Keys",    href: "/admin/keys" },
    { icon: ShieldCheck,  label: "BI Grants",    href: "/admin/grants" },
    { icon: ClipboardList,label: "Audit Log",    href: "/admin/audit" },
    { icon: BarChart2,    label: "Usage",        href: "/admin/usage" },
    { icon: Database,     label: "Data Sources", href: "/files" },
    { icon: Bot,          label: "Automations",  href: "/admin/automations" },
  ];

  return (
    <Sidebar
      className={cn(
        "border-r border-[var(--border-soft)] bg-card",
        className
      )}
    >
      {/* ── Brand ──────────────────────────────────────────── */}
      <SidebarHeader className="px-[18px] pt-6 pb-0">
        <Link href="/dashboard" className="block mb-8">
          <div className="flex items-center gap-[14px] pl-[6px] group">
            {/* Brand tile: 46×46, bg-background (not primary), border, shadow */}
            <div
              className={cn(
                "w-[46px] h-[46px] rounded-[14px] shrink-0",
                "bg-background border border-border",
                "flex items-center justify-center",
                "shadow-[var(--shadow-2)]",
                "overflow-hidden",
                "transition-shadow duration-200 group-hover:shadow-[var(--shadow-3)]"
              )}
              aria-hidden
            >
              <img
                src="/athene-mark-light.svg"
                alt=""
                width={34}
                height={34}
                className="object-contain"
                onError={(e) => {
                  const t = e.currentTarget;
                  t.style.display = "none";
                  if (t.parentElement) {
                    t.parentElement.innerHTML =
                      '<span style="color:var(--primary);font-weight:800;font-size:18px;letter-spacing:-0.02em;font-family:var(--font-sans)">α</span>';
                  }
                }}
              />
            </div>
            <div className="group-data-[collapsible=icon]:hidden">
              {/* "AtheneAI" with "AI" in primary — 19px 800 -0.04em UPPERCASE */}
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 19,
                  fontWeight: 800,
                  letterSpacing: "-0.04em",
                  textTransform: "uppercase",
                  lineHeight: 1,
                }}
                className="text-foreground"
              >
                Athene<span className="text-primary">AI</span>
              </div>
              {/* Version subtitle: 9px 700 0.32em tracking */}
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.32em",
                  textTransform: "uppercase",
                  marginTop: 5,
                }}
                className="text-muted-foreground"
              >
                Neural engine · v1.4
              </div>
            </div>
          </div>
        </Link>
      </SidebarHeader>

      {/* ── Nav content ────────────────────────────────────── */}
      <SidebarContent className="px-[18px] py-0 overflow-x-hidden">
        {/* Surfaces */}
        <SidebarGroup className="p-0">
          <SidebarGroupLabel
            className={cn(
              "pl-[14px] mb-3 mt-0",
              "text-[9px] font-extrabold uppercase tracking-[0.4em]",
              "text-muted-foreground/70",
              "group-data-[collapsible=icon]:hidden"
            )}
          >
            Surfaces
          </SidebarGroupLabel>
          <SidebarMenu className="space-y-0">
            {primaryItems.map((item) => (
              <SidebarItem
                key={item.href}
                icon={item.icon}
                label={item.label}
                href={item.href}
                active={isRouteActive(pathname, item.href)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>

        {/* Admin control */}
        {role === "admin" && (
          <SidebarGroup className="p-0 mt-7">
            <SidebarGroupLabel
              className={cn(
                "pl-[14px] mb-3",
                "text-[9px] font-extrabold uppercase tracking-[0.4em]",
                "text-muted-foreground/70",
                "group-data-[collapsible=icon]:hidden"
              )}
            >
              Admin Control
            </SidebarGroupLabel>
            <SidebarMenu className="space-y-0">
              {adminItems.map((item) => (
                <SidebarItem
                  key={item.href}
                  icon={item.icon}
                  label={item.label}
                  href={item.href}
                  active={isRouteActive(pathname, item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        {/* Library */}
        <SidebarGroup className="p-0 mt-7">
          <SidebarGroupLabel
            className={cn(
              "pl-[14px] mb-3",
              "text-[9px] font-extrabold uppercase tracking-[0.4em]",
              "text-muted-foreground/70",
              "group-data-[collapsible=icon]:hidden"
            )}
          >
            Library
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarItem
              icon={GitBranch}
              label="Decisions"
              href="/decisions"
              active={isRouteActive(pathname, "/decisions")}
            />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* FROZEN (REFOCUS §3.2): "Agent Laboratory" nav item and "Deploy agent"
          footer link to /builder removed — automation builder UI is frozen. */}
      <SidebarFooter className="p-[10px] pt-6 border-t border-[var(--border-soft)]">
        {/* ── User card — always reserves height to prevent layout shift ──── */}
        <div className="group-data-[collapsible=icon]:hidden mt-3 rounded-[14px] border border-[var(--border-soft)] bg-[var(--bg-muted)] overflow-hidden">
          {user ? (
            /* Loaded state */
            <div className="flex items-center gap-3 px-3 py-3">
              <div className="w-[34px] h-[34px] rounded-full border border-border overflow-hidden flex items-center justify-center shrink-0">
                <UserButton
                  appearance={{
                    elements: {
                      userButtonAvatarBox: "w-[34px] h-[34px]",
                      userButtonTrigger: "focus:shadow-none",
                    },
                  }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div
                  style={{
                    fontSize: 11, fontWeight: 800, letterSpacing: "-0.01em",
                    textTransform: "uppercase", color: "var(--fg)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                >
                  {user.firstName ?? user.username ?? "User"}
                </div>
                <div
                  style={{
                    fontSize: 8, fontWeight: 700, letterSpacing: "0.28em",
                    textTransform: "uppercase", color: "var(--fg-subtle)", marginTop: 2,
                  }}
                >
                  {role}
                </div>
              </div>
            </div>
          ) : (
            /* Skeleton — same dimensions as loaded state, no layout shift */
            <div className="flex items-center gap-3 px-3 py-3">
              <div className="w-[34px] h-[34px] rounded-full bg-muted shimmer shrink-0" />
              <div className="flex-1 space-y-[5px]">
                <div className="h-[10px] w-3/4 rounded-full bg-muted shimmer" />
                <div className="h-[7px] w-1/2 rounded-full bg-muted shimmer" />
              </div>
            </div>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export { AppSidebar as Sidebar };
