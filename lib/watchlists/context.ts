import { supabaseAdmin } from "@/lib/supabase/server";
import type { WatchlistRunContext } from "./types";

export async function loadUserContext(
  orgId: string,
  userId: string,
): Promise<WatchlistRunContext | null> {
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, department_id, users(timezone)")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .single();

  if (!member) return null;

  return {
    orgId,
    userId,
    role:         member.role,
    deptId:       member.department_id ?? null,
    userTimezone: (member.users as any)?.timezone ?? "UTC",
  };
}
