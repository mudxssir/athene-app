import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/athene-sidebar";
import { Header } from "@/components/header";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PageTransition } from "@/components/page-transition";
import { TransitionProvider } from "@/components/transition-provider";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId, orgId, orgRole } = await auth();

  // Protect dashboard routes
  if (!userId) {
    redirect("/sign-in");
  }

  if (!orgId) {
    redirect("/org-selection");
  }

  // Fetch access natively on the server, avoiding client-side useEffect leaks
  const userAccess = await resolveUserAccess(userId, orgId, orgRole);

  return (
    // TransitionProvider must wrap the ENTIRE shell (sidebar + main) so that
    // NavigateCtx is available to SidebarItem components, which call
    // useNavigate() to play exit animations before router.push fires.
    // Placing it only around <main> leaves the sidebar outside the context
    // and causes useNavigate() to return the default no-op, blocking all nav.
    <TransitionProvider>
      <SidebarProvider>
        <TooltipProvider>
          <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-['Space_Grotesk'] relative transition-colors duration-500">
            {/* Sidebar */}
            <Sidebar role={userAccess.role} />

            {/* Main Content Wrapper */}
            <div className="flex-1 flex flex-col h-full relative overflow-hidden">
              {/* Header */}
              <Header role={userAccess.role} />

              {/* Scrollable Page Content */}
              <main className="flex-1 overflow-hidden">
                <PageTransition>{children}</PageTransition>
              </main>
            </div>
          </div>
        </TooltipProvider>
      </SidebarProvider>
    </TransitionProvider>
  );
}
