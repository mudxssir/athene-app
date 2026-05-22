import { OrganizationList } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function OrgSelectionPage() {
  const { userId, orgId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  // If already in an org, go to dashboard
  if (orgId) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[#06080c] flex flex-col items-center justify-center p-6 font-['Space_Grotesk']">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[600px] bg-secondary/10 blur-[160px] -z-10 rounded-full opacity-50" />
      
      <div className="mb-12 text-center space-y-4">
        <div className="flex items-center justify-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-2xl overflow-hidden flex items-center justify-center bg-white shadow-[0_0_30px_rgba(102,173,228,0.2)]">
            <img src="/logo.png" alt="A" className="w-9 h-9 object-contain" />
          </div>
          <span className="text-3xl font-black tracking-tighter text-white">
            Athene<span className="text-secondary">AI</span>
          </span>
        </div>
        <h1 className="text-4xl font-black tracking-tight text-white uppercase">Select Organization</h1>
        <p className="text-slate-400 font-medium">To access the neural grid, you must be part of an active sector.</p>
      </div>

      <div className="w-full max-w-2xl bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2.5rem] p-12 shadow-2xl relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-secondary/5 to-transparent opacity-50" />
        <div className="relative z-10 flex flex-col items-center">
          <OrganizationList 
            hidePersonal={true}
            afterSelectOrganizationUrl="/dashboard"
            afterCreateOrganizationUrl="/onboarding/welcome"
            appearance={{
              elements: {
                rootBox: "w-full",
                card: "bg-transparent border-none shadow-none text-white",
                headerTitle: "text-white hidden",
                headerSubtitle: "text-slate-400 hidden",
                organizationSwitcherTrigger: "bg-white/5 border-white/10 text-white",
                organizationListPreviewItem: "hover:bg-white/5 transition-colors rounded-xl",
                organizationListPreviewItem__active: "bg-secondary/20 border border-secondary/30",
                organizationPreviewMainIdentifier: "text-white font-bold",
                organizationPreviewSecondaryIdentifier: "text-slate-500",
                buttonPrimary: "bg-secondary hover:bg-[#599bc9] text-black font-bold uppercase tracking-widest text-[10px] rounded-xl h-12",
                userButtonPopoverActionButtonText: "text-white",
                organizationSwitcherPopoverCard: "bg-[#0b0e14] border border-white/10",
                organizationSwitcherPopoverActionButton: "hover:bg-white/5",
                organizationSwitcherPopoverActionButtonText: "text-white",
              }
            }}
          />
        </div>
      </div>

      <p className="mt-12 text-[10px] text-slate-600 font-black uppercase tracking-[0.3em]">
        Neural Engine v1.4 • Secure Multi-Tenant Architecture
      </p>
    </div>
  );
}
