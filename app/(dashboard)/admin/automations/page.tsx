import { Suspense } from "react";
import { headers } from "next/headers";
import { getContextFromHeaders, withRLS } from "@/lib/supabase/rls-client";
import { AutomationsClient } from "@/components/automations/automations-client";

/**
 * Server component to fetch and display the list of automations.
 * Implements ATH-49 requirement for data fetching and empty state.
 */
async function AutomationList() {
  const context = getContextFromHeaders(await headers());
  if (!context) return null;

  const automations = await withRLS(context, async (supabase) => {
    const { data } = await supabase
      .from("automations")
      .select("*")
      .order("created_at", { ascending: false });
    return data || [];
  });

  return <AutomationsClient initialAutomations={automations} />;
}

export default function AutomationsPage() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <Suspense fallback={
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <div className="h-10 w-48 bg-muted animate-pulse rounded-lg" />
              <div className="h-5 w-96 bg-muted animate-pulse rounded-lg" />
            </div>
            <div className="h-12 w-36 bg-muted animate-pulse rounded-lg" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 mt-8">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-64 rounded-xl border border-border bg-accent/5 animate-pulse" />
            ))}
          </div>
        </div>
      }>
        <AutomationList />
      </Suspense>
    </div>
  );
}

