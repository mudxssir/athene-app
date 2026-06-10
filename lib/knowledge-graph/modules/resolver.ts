// ============================================================
// lib/knowledge-graph/modules/resolver.ts
//
// Determines which vertical modules are active for an org
// by checking its connected integration sources, then builds
// the dynamic extraction prompt for the KG extractor.
//
// Results are Redis-cached for 10 minutes per org to avoid
// hitting the DB on every chunk extraction call.
// ============================================================

// SERVICE-ROLE JUSTIFICATION: reads org connection source types (no user
// content) to assemble the extraction prompt during background indexing —
// no user RLS context exists at extraction time.
import { supabaseAdmin } from "@/lib/supabase/server";
import { redis } from "@/lib/redis/client";
import { VERTICAL_MODULES, type VerticalModule } from "./registry";
import { EXTRACTION_PROMPT } from "../extractor-prompt";

const CACHE_TTL_SECONDS = 600; // 10 minutes

/**
 * Returns the vertical modules that are active for the given org,
 * based on which source types have active connections.
 */
export async function getActiveModules(orgId: string): Promise<VerticalModule[]> {
  const { data: connections } = await supabaseAdmin
    .from("connections")
    .select("source_type, provider")
    .eq("org_id", orgId)
    .eq("status", "active");

  // Normalize to lowercase and include both source_type and provider to handle
  // inconsistent casing from different integration flows
  const activeSources = new Set(
    (connections ?? []).flatMap((c) =>
      [c.source_type, c.provider].filter(Boolean).map((v: string) => v.toLowerCase())
    )
  );

  return VERTICAL_MODULES.filter((m) =>
    m.activating_sources.some((s) => activeSources.has(s.toLowerCase()))
  );
}

/**
 * Builds a full extraction prompt by appending active module addenda
 * to the base EXTRACTION_PROMPT.
 */
export function buildExtractorPrompt(modules: VerticalModule[]): string {
  if (modules.length === 0) return EXTRACTION_PROMPT;
  const addenda = modules.map((m) => m.extraction_prompt_addendum).join("\n");
  return `${EXTRACTION_PROMPT}\n${addenda}`;
}

/**
 * Returns the cached (or freshly built) extraction prompt for the org.
 * Falls back to the base prompt if Redis is unavailable.
 */
export async function resolveExtractionPrompt(orgId: string): Promise<string> {
  const cacheKey = `extraction_prompt:${orgId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached && typeof cached === "string") return cached;
  } catch {
    // Redis unavailable — continue without cache
  }

  const modules = await getActiveModules(orgId);
  const prompt = buildExtractorPrompt(modules);

  try {
    await redis.set(cacheKey, prompt, { ex: CACHE_TTL_SECONDS });
  } catch {
    // Fire-and-forget; cache miss is acceptable
  }

  return prompt;
}

/** Invalidate the cached prompt for an org (call when connections change). */
export async function invalidatePromptCache(orgId: string): Promise<void> {
  try {
    await redis.del(`extraction_prompt:${orgId}`);
  } catch {
    // Ignore Redis errors on invalidation
  }
}
