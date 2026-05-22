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
  FlaskConical,
  Users,
  Blocks,
  KeyRound,
  ShieldCheck,
  ClipboardList,
  Bot,
  Database,
  Network,
  GitBranch,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
   + 3px left bar at left:-10, top:10, bottom:10. */
const SidebarItem = ({ icon: Icon, label, href, active = false }: SidebarItemProps) => (
  <SidebarMenuItem className="relative list-none mb-[3px]">
    <Link
      href={href}
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
    </Link>
  </SidebarMenuItem>
);

const isRouteActive = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

function AppSidebar({ role, className }: { role: UserRole; className?: string }) {
  const pathname = usePathname();

  const primaryItems = [
    { icon: LayoutDashboard, label: "Command Center", href: "/dashboard" },
    { icon: MessageSquare,   label: "Chat",            href: "/chat" },
    { icon: Network,         label: "Knowledge Graph", href: "/graph" },
    { icon: GitBranch,       label: "Decisions",       href: "/decisions" },
    { icon: BarChart3,       label: "Insights",        href: "/insights" },
    { icon: Newspaper,       label: "Briefing",        href: "/briefing" },
  ];

  const adminItems = [
    { icon: Users,        label: "Users",        href: "/admin/users" },
    { icon: Blocks,       label: "Integrations", href: "/admin/integrations" },
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
        {/* Core hub */}
        <SidebarGroup className="p-0">
          <SidebarGroupLabel
            className={cn(
              "pl-[14px] mb-3 mt-0",
              "text-[9px] font-extrabold uppercase tracking-[0.4em]",
              "text-muted-foreground/70",
              "group-data-[collapsible=icon]:hidden"
            )}
          >
            Core Hub
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

        {/* Experimental */}
        <SidebarGroup className="p-0 mt-7">
          <SidebarGroupLabel
            className={cn(
              "pl-[14px] mb-3",
              "text-[9px] font-extrabold uppercase tracking-[0.4em]",
              "text-muted-foreground/70",
              "group-data-[collapsible=icon]:hidden"
            )}
          >
            Experimental
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarItem
              icon={FlaskConical}
              label="Agent Laboratory"
              href="/builder"
              active={isRouteActive(pathname, "/builder")}
            />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* ── Footer: Deploy button ───────────────────────────── */}
      <SidebarFooter className="p-[10px] pt-6 border-t border-[var(--border-soft)]">
        <Link
          href="/builder"
          className={cn(
            "flex items-center justify-center gap-[10px] w-full",
            // 52px height, 16px radius — exact design kit spec
            "h-[52px] rounded-[16px]",
            "bg-primary text-white",
            "text-[10px] font-extrabold uppercase tracking-[0.3em]",
            "hover:bg-[var(--primary-hover)]",
            "active:translate-y-[1px]",
            "transition-all duration-150",
            // Warm deep shadow from design kit
            "shadow-[0_14px_30px_-10px_rgba(160,74,27,0.55)]",
            "group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:aspect-square"
          )}
        >
          <Zap size={14} className="shrink-0" />
          <span className="group-data-[collapsible=icon]:hidden">Deploy agent</span>
        </Link>
      </SidebarFooter>
    </Sidebar>
  );
}

export { AppSidebar as Sidebar };
