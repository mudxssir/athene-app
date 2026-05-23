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
    <SidebarProvider>
      <TooltipProvider>
        <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-['Space_Grotesk'] relative transition-colors duration-500">
          {/* Sidebar */}
          <Sidebar role={userAccess.role} />

          {/* Main Content Wrapper */}
          <div className="flex-1 flex flex-col h-full relative overflow-hidden">
            {/* Header */}
            <Header role={userAccess.role} />

            {/* Scrollable Page Content — TransitionProvider drives TCard animations */}
            <main className="flex-1 overflow-hidden">
              <TransitionProvider>
                <PageTransition>{children}</PageTransition>
              </TransitionProvider>
            </main>
          </div>
        </div>
      </TooltipProvider>
    </SidebarProvider>
  );
}
