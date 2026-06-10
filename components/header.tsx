"use client";

import { useEffect, useState, memo } from "react";
import { OrganizationSwitcher, UserButton, SignOutButton } from "@clerk/nextjs";
import { ShieldCheck, Radio, Bell, Cpu, Menu, Search, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { UserRole } from "@/lib/auth/rbac";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { AlertInbox } from "@/components/watchlists/alert-inbox";
// stampFor is derived from ROUTE_CONFIG in kit.tsx — single source of truth
import { stampFor } from "@/components/ui/kit";

interface HeaderProps {
  role: UserRole;
}

const Header = memo(function HeaderContent({ role }: HeaderProps) {
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
  }, []);

  // Render an empty shell (same h-16 height) during SSR / before hydration
  // so the layout doesn't shift when the full header mounts client-side.
  if (!mounted) {
    return (
      <header className="h-16 border-b border-border bg-background/60 shrink-0 z-40 sticky top-0" />
    );
  }

  const stamp = stampFor(pathname);

  return (
    <header className="h-16 border-b border-border flex items-center justify-between px-6 bg-background/60 shrink-0 z-40 sticky top-0 backdrop-blur-xl transition-colors duration-300">
      <div className="flex items-center gap-5">
        <SidebarTrigger className="h-[34px] w-[34px] text-muted-foreground hover:text-foreground hover:bg-muted transition-all rounded-[12px] border border-transparent hover:border-border shrink-0" />
        <div className="hidden sm:flex flex-col gap-[2px]">
          <h2
            className="text-foreground leading-none"
            style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.02em", textTransform: "uppercase", fontFamily: "var(--font-sans)" }}
          >
            Athene<span className="text-primary">AI</span>
          </h2>
          {stamp && (
            <span
              className="text-muted-foreground/60 leading-none"
              style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.3em", textTransform: "uppercase", fontFamily: "var(--font-sans)" }}
            >
              {stamp}
            </span>
          )}
        </div>
        <nav className="hidden md:flex items-center gap-8">
          <Link
            href="/graph"
            className={cn(
              "text-[10px] font-extrabold uppercase tracking-[0.28em] transition-colors",
              pathname.includes("graph") ? "text-primary" : "text-muted-foreground hover:text-primary"
            )}
          >
            Network
          </Link>
          <Link
            href="/builder"
            className={cn(
              "text-[10px] font-extrabold uppercase tracking-[0.28em] transition-colors",
              pathname.includes("builder") ? "text-primary" : "text-muted-foreground hover:text-primary"
            )}
          >
            Agent Lab
          </Link>
          <Link
            href="/files"
            className={cn(
              "text-[10px] font-extrabold uppercase tracking-[0.28em] transition-colors",
              pathname.includes("files") ? "text-primary" : "text-muted-foreground hover:text-primary"
            )}
          >
            Assets
          </Link>
        </nav>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden lg:flex items-center mr-3">
          <OrganizationSwitcher
            hidePersonal={true}
            afterSelectOrganizationUrl="/briefing"
            afterLeaveOrganizationUrl="/briefing"
            appearance={{
              elements: {
                organizationSwitcherTrigger:
                  "text-muted-foreground hover:text-foreground transition-colors text-[9px] font-extrabold uppercase tracking-[0.28em] bg-muted px-3 h-[28px] rounded-[99px] border border-border hover:bg-muted/80",
                organizationPreviewMainIdentifier: "text-foreground text-[11px] font-bold",
                organizationPreviewSecondaryIdentifier: "text-muted-foreground",
              },
            }}
          />
        </div>

        <div className="flex items-center gap-2">
          <AlertInbox />
          <ThemeToggle />
          {role === "admin" && (
            <>
              <Link
                href="/admin/grants"
                title="Security Hub"
                className="flex items-center justify-center h-[34px] w-[34px] rounded-[12px] text-muted-foreground hover:text-secondary hover:bg-muted transition-all"
              >
                <ShieldCheck size={16} />
              </Link>
              <Link
                href="/admin/integrations"
                title="Network Cluster"
                className="flex items-center justify-center h-[34px] w-[34px] rounded-[12px] text-muted-foreground hover:text-primary hover:bg-muted transition-all"
              >
                <Radio size={16} />
              </Link>
              <div className="relative flex items-center justify-center h-[34px] w-[34px] rounded-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-all cursor-pointer">
                <Link href="/admin/audit" title="Audit Log">
                  <Bell size={16} />
                </Link>
                <span className="absolute top-[7px] right-[7px] w-[5px] h-[5px] bg-secondary rounded-full pointer-events-none" />
              </div>
            </>
          )}
          <Link
            href="/dashboard"
            title="Neural Pulse"
            className="flex items-center justify-center h-[34px] w-[34px] rounded-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          >
            <Cpu size={16} />
          </Link>
          <div className="w-[34px] h-[34px] rounded-full border border-border overflow-hidden hover:border-primary/50 transition-colors flex items-center justify-center ml-1">
            <UserButton
              appearance={{
                elements: {
                  userButtonAvatarBox: "w-[34px] h-[34px] dark:grayscale-[0.3]",
                  userButtonTrigger: "focus:shadow-none",
                },
              }}
            />
          </div>
          <div className="sr-only">
            <SignOutButton>
              <button data-testid="logout-button" aria-label="Logout">Log out</button>
            </SignOutButton>
          </div>
        </div>
      </div>
    </header>

  );
});

export { Header };
