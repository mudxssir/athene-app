// FROZEN (REFOCUS §3.2): automation builder UI is frozen while the product
// is read-only. The full client UI lives in ./builder-client.tsx; scheduled
// automations infra (lib/automations, QStash, user_automations) stays active
// for briefings and watchlists. Unfreeze via WRITE_ACTIONS_ENABLED.
import { notFound } from "next/navigation";
import { WRITE_ACTIONS_ENABLED } from "@/lib/config/feature-flags";
import BuilderPage from "./builder-client";

export default function BuilderRoute() {
  if (!WRITE_ACTIONS_ENABLED) notFound();
  return <BuilderPage />;
}
