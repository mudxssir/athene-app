import { supabaseAdmin } from "@/lib/supabase/server";
import { resolveModelClient } from "@/lib/langgraph/llm-factory";
import { evaluateWatchlist } from "@/lib/watchlists/evaluator";
import { loadUserContext } from "@/lib/watchlists/context";
import type { WatchlistRunContext } from "@/lib/watchlists/types";
import type {
  ReportTemplate,
  ReportSection,
  GeneratedReport,
  GeneratedSection,
  ReportSchedule,
} from "./types";

const SECTION_CONCURRENCY = 3;

async function buildSection(
  section: ReportSection,
  templateId: string,
  ctx: WatchlistRunContext,
): Promise<GeneratedSection> {
  try {
    // Reuse the watchlist evaluator — it's the same "run a query, get an answer" pattern.
    // Use a synthetic watchlist ID scoped to section to avoid checkpoint collisions.
    const evalId = `report-${templateId}-${section.id}`;
    const result = await evaluateWatchlist(evalId, section.query, ctx);

    const isEmpty =
      result.answer.toLowerCase().includes("no data") ||
      result.answer.toLowerCase().includes("not enough") ||
      result.answer.trim().length < 30;

    if (isEmpty && section.skip_if_empty) {
      return { id: section.id, title: section.title, content: "", cited_sources: [], status: "no_data" };
    }

    return {
      id:            section.id,
      title:         section.title,
      content:       result.answer,
      cited_sources: result.cited_sources,
      status:        "ok",
    };
  } catch (err) {
    console.error(`[reports:builder] Section "${section.title}" failed`, err);
    return {
      id:            section.id,
      title:         section.title,
      content:       "Section unavailable — an error occurred during synthesis.",
      cited_sources: [],
      status:        "error",
    };
  }
}

async function runConcurrently<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<GeneratedSection>,
): Promise<GeneratedSection[]> {
  const results: GeneratedSection[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function generateSummary(
  sections: GeneratedSection[],
  templateName: string,
  orgId: string,
): Promise<string> {
  const llm = await resolveModelClient("fast", orgId);

  const sectionSummaries = sections
    .filter((s) => s.status === "ok" && s.content)
    .map((s) => `${s.title}: ${s.content.slice(0, 300)}`)
    .join("\n\n");

  const result = await llm.invoke(
    `Write a 2-3 sentence executive summary for a "${templateName}" report. Be specific and factual. Use only this content:\n\n${sectionSummaries}`,
  );

  return typeof result.content === "string"
    ? result.content
    : (result.content as any[]).map((c: any) => c.text ?? "").join("");
}

export async function buildReport(
  template: ReportTemplate,
  ctx: WatchlistRunContext,
  scheduleId?: string,
): Promise<GeneratedReport> {
  const orderedSections = [...template.sections].sort((a, b) => a.order - b.order);

  const builtSections = await runConcurrently(
    orderedSections,
    SECTION_CONCURRENCY,
    (s) => buildSection(s, template.id, ctx),
  );

  const summary = await generateSummary(builtSections, template.name, ctx.orgId);

  const report: Omit<GeneratedReport, "id"> = {
    org_id:                ctx.orgId,
    schedule_id:           scheduleId ?? null,
    template_id:           template.id,
    title:                 `${template.name} — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`,
    sections:              builtSections,
    summary,
    generated_at:          new Date().toISOString(),
    generated_by_user_id:  ctx.userId,
  };

  const { data, error } = await supabaseAdmin
    .from("generated_reports")
    .insert(report)
    .select()
    .single();

  if (error) throw new Error(`Failed to save report: ${error.message}`);
  return data as GeneratedReport;
}

/** Load a template + its schedule context, then run buildReport */
export async function runScheduledReport(schedule: ReportSchedule): Promise<GeneratedReport> {
  const { data: template, error } = await supabaseAdmin
    .from("report_templates")
    .select("*")
    .eq("id", schedule.template_id)
    .single();

  if (error || !template) throw new Error(`Template not found: ${schedule.template_id}`);

  const ctx = await loadUserContext(schedule.org_id, schedule.run_as_user_id);
  if (!ctx) throw new Error(`User context not found for schedule ${schedule.id}`);

  return buildReport(template as ReportTemplate, ctx, schedule.id);
}
