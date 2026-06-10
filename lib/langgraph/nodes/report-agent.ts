// FROZEN (REFOCUS §3.1/§3.2): not wired into graph routing — the assistant is
// read-only in Phase 1. Kept intact for reversibility; unfreeze via WRITE_ACTIONS_ENABLED.
import type { AtheneStateType, AtheneStateUpdate } from "../state";
import { vectorSearch } from "@/lib/tools/vector-search";
import { graphQueryTool } from "../tools/graph-query";
import { SystemMessage, HumanMessage, type MessageContent } from "@langchain/core/messages";
import { resolveModelClient } from "../llm-factory";
import { logger } from "@/lib/logger";

/**
 * Parses the raw string output from the graphQueryTool into structured
 * relationship tuples. This is intentionally lenient to handle varied
 * whitespace, optional provenance brackets, and label characters that
 * include spaces, hyphens, dots, colons, slashes, and underscores.
 *
 * Expected input lines (from graph-query.ts formatResult):
 *   "  AWS → DEPENDS_ON → Payment Service [extracted, 0.85]"
 *   "  HR Portal → RELATES_TO → Employee DB"
 *
 * Returns an array of { source, relation, target } objects.
 */
export function parseGraphRelationships(
  graphResult: string
): Array<{ source: string; relation: string; target: string }> {
  if (!graphResult || graphResult.includes("No knowledge graph data")) {
    return [];
  }

  // Robust pattern:
  //   ^\s*          — optional leading whitespace
  //   (.+?)        — source entity (non-greedy, any chars)
  //   \s*→\s*      — arrow with flexible whitespace
  //   (.+?)        — relation (non-greedy)
  //   \s*→\s*      — second arrow with flexible whitespace
  //   (.+?)        — target entity (non-greedy)
  //   (?:\s*\[.*?\])? — optional provenance brackets (non-greedy)
  //   \s*$         — optional trailing whitespace
  const GRAPH_REL_PATTERN = /^\s*(.+?)\s*→\s*(.+?)\s*→\s*(.+?)(?:\s*\[.*?\])?\s*$/gm;

  const results: Array<{ source: string; relation: string; target: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = GRAPH_REL_PATTERN.exec(graphResult)) !== null) {
    const source = match[1].trim();
    const relation = match[2].trim();
    const target = match[3].trim();

    // Skip degenerate matches where any group is empty
    if (source && relation && target) {
      results.push({ source, relation, target });
    }
  }

  return results;
}

// Inlined prompt template
const PLAN_PROMPT_TEMPLATE = `# Report Planning Prompt

You are an expert analyst tasked with planning a comprehensive report.
Given the user's query, your job is to outline a structured report by breaking it down into logical sections.

Return a JSON array containing 3 to 6 section titles.
Each section title should be a concise string representing a distinct topic to be covered in the report.

Query: __USER_QUERY__

Example Output:
["Executive Summary", "Key Metrics", "Recent Developments", "Challenges & Risks", "Conclusion"]`;


/**
 * Extract plain text from a LangChain message content value.
 */
function extractText(
  content: MessageContent,
  fallback = "Generate a report"
): string {
  if (typeof content === "string") return content || fallback;
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text"
    )
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text || fallback;
}

/**
 * Report Agent Node
 * 
 * Flow:
 * 1. Plan sections (LLM)
 * 2. For each section:
 *    a. Vector search for context
 *    b. Graph search for "Connected Concepts" (ATH-CONTEXT fix)
 *    c. Synthesis with citations
 * 3. Combine into final report
 */
export async function reportAgent(
  state: AtheneStateType,
  _config: unknown
): Promise<AtheneStateUpdate> {
  const {
    orgId,
    userId,
    role,
    messages,
  } = state;

  // Extract the latest query
  const lastMessage =
    messages && messages.length > 0 ? messages[messages.length - 1] : null;
  const query: string = lastMessage
    ? extractText(
        lastMessage.content as MessageContent
      )
    : "Generate a report";

  const plannerModel = await resolveModelClient("simple", orgId, 0);
  const synthesisModel = await resolveModelClient("simple", orgId, 0.2);

  // 1. Plan sections using LLM
  const planPrompt = PLAN_PROMPT_TEMPLATE.replace(
    "__USER_QUERY__",
    query.replace(/__USER_QUERY__/g, "")
  );


  const planResponse = await plannerModel.invoke([
    new SystemMessage(planPrompt),
  ]);

  let sections: string[] = [];
  try {
    let rawContent = extractText(
      planResponse.content as MessageContent
    );
    if (rawContent.startsWith("```json")) {
      rawContent = rawContent
        .replace(/^```json\n?/, "")
        .replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(rawContent);
    sections = Array.isArray(parsed)
      ? parsed.filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0
        )
      : [];

    if (sections.length === 0) {
      sections = ["Introduction", "Key Findings", "Conclusion"];
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "[report-agent] Failed to parse report plan");
    sections = ["Introduction", "Key Findings", "Conclusion"];
  }


  sections = sections.slice(0, 6);

  // 2. Process sections in chunks (concurrency control)
  const CONCURRENCY_LIMIT = 3;
  const compiledSections: string[] = [];

  interface GraphTool {
    func: (
      args: { question: string; maxHops: number },
      b: unknown,
      cfg: { configurable: { orgId: string; role: string } }
    ) => Promise<string>;
  }
  const typedTool = graphQueryTool as GraphTool;

  
  for (let i = 0; i < sections.length; i += CONCURRENCY_LIMIT) {
    const batch = sections.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (section) => {
        // a. Run Vector Search and Graph Search concurrently
        const [results, graphResult] = await Promise.all([
          vectorSearch({
            orgId,
            userId,
            user_role: role as "member" | "super_user" | "admin",
            query: `${query} - ${section}`,
            topK: 5,
          }),
          typedTool.func(
            { question: section, maxHops: 2 },
            undefined,
            { configurable: { orgId, role } }
          ).catch(err => {
            logger.warn({ section, err: err instanceof Error ? err.message : String(err) }, "[report-agent] Graph query failed for section");
            return null;
          })
        ]);

        const sourceDocs = results.map((r: any, idx: number) => ({
          index: idx + 1,
          chunk_id: r.chunk_id ?? r.id ?? `chunk_${idx}`,
          document_id: r.document_id ?? "unknown",
          content:
            r.content_preview ??
            r.metadata?.text_preview ??
            r.metadata?.content ??
            r.metadata?.text ??
            (typeof r.metadata === "object"
              ? JSON.stringify(r.metadata)
              : String(r.metadata ?? "")),
        }));


      const sourceBlock = sourceDocs
        .map(
          (s: { index: number; chunk_id: string; document_id: string; content: string }) =>
            `[Source ${s.index}] chunk_id=${s.chunk_id}, document_id=${s.document_id}\n${s.content}`
        )
        .join("\n\n");

      // b. Process Graph Results for Connected Concepts
      let connectedConcepts = "";
      if (graphResult) {
        const rels = parseGraphRelationships(graphResult);
        if (rels.length > 0) {
          const relLines = rels
            .slice(0, 5)
            .map((r) => `${r.source} → ${r.relation} → ${r.target}`);
          connectedConcepts = `\n\n**Connected concepts:** ${relLines.join(" | ")}`;
        }
      }


      // c. Synthesize
      const synthesizePrompt = `You are a helpful analyst writing a section for a report.
Section Title: ${section}

Below are the source documents retrieved for this section. Each source has a chunk_id.

${sourceBlock}

INSTRUCTIONS:
- Write the section content in markdown format.
- Do NOT include the section title as a heading, just write the body content.
- You MUST cite sources inline using the format [source: <chunk_id>] for every claim derived from a source document.
- Every section must contain at least one citation.`;

      const synthesizeResponse = await synthesisModel.invoke([
        new SystemMessage(synthesizePrompt),
        new HumanMessage("Write the section now."),
      ]);

        const sectionContent = extractText(
          synthesizeResponse.content as MessageContent
        );
        return `## ${section}\n\n${sectionContent}${connectedConcepts}`;
      })
    );
    compiledSections.push(...batchResults);
  }

  const finalReport = compiledSections.join("\n\n");

  return {
    final_answer: finalReport,
  };
}
