// ============================================================
// lib/langgraph/nodes/synthesis-agent.ts — Synthesis node (ATH-63)
//
// Full implementation lives here. The wrapper at
// lib/agents/synthesis-agent.ts re-exports from this file.
// ============================================================

import { SystemMessage } from "@langchain/core/messages";
import type { MessageContentComplex } from "@langchain/core/messages";
import type { AtheneState, AtheneStateUpdate, CitedSource, RetrievedChunk } from "../state";
import { resolveModelClient } from "../llm-factory";
import { VERTICAL_MODULES } from "@/lib/knowledge-graph/modules/registry";

const SYNTHESIS_PROMPT = `You are an AI assistant synthesizing retrieved information into a clear, cited answer.

MODE: {{MODE}}

{{DEPT_GUIDANCE}}

CONTEXT (retrieved chunks):
{{CONTEXT}}

{{GRAPH_CONTEXT}}

INSTRUCTIONS:
- Answer the user's question using ONLY the provided context.
- Cite sources inline using [document_id] format for document chunks.
- For graph-sourced relationships, cite with [EXTRACTED] to distinguish from document sources.
- If the context is insufficient, say so clearly.
- In BI mode: focus on patterns, trends, and data gaps with structured bullets.
- In standard mode: provide a direct, readable answer.
{{BOUNDARY_NOTE}}`;

// ---- Helpers ------------------------------------------------

interface GraphResult {
  type: "graph";
  raw: string;
  relationships: string[];
  boundaryReached: boolean;
}

/**
 * Returns the department_id that appears most frequently in retrieved chunks.
 * Used to inject domain-specific synthesis guidance from the vertical module registry.
 */
function detectDominantDept(chunks: RetrievedChunk[]): string | null {
  const counts: Record<string, number> = {};
  for (const c of chunks) {
    if (c.department_id) counts[c.department_id] = (counts[c.department_id] ?? 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

function isGraphResult(item: unknown): item is GraphResult {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Record<string, unknown>).type === "graph"
  );
}

function isVectorChunk(item: unknown): item is RetrievedChunk & { type?: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Record<string, unknown>).type !== "graph"
  );
}

/**
 * Builds the graph context section for the synthesis prompt.
 * Returns empty string if no graph results are present.
 */
function buildGraphContext(graphResults: GraphResult[]): string {
  if (graphResults.length === 0) return "";

  const sections: string[] = ["KNOWLEDGE GRAPH RELATIONSHIPS:"];

  for (const gr of graphResults) {
    if (gr.relationships.length > 0) {
      for (const rel of gr.relationships) {
        sections.push(`  ${rel} [EXTRACTED]`);
      }
    }
    // Include the full raw output for additional entity context
    if (gr.raw && !gr.raw.startsWith("No ")) {
      const entityLine = gr.raw.split("\n").find((l) => l.startsWith("Entities found:"));
      if (entityLine) {
        sections.push(`  ${entityLine}`);
      }
    }
  }

  return sections.join("\n");
}

// ---- Main ---------------------------------------------------

/**
 * Synthesis agent node — generates a cited final answer from retrieved context.
 *
 * Separates retrieved_chunks into vector chunks and graph results, then
 * constructs a system prompt with context, graph relationships, and optional
 * domain guidance from the vertical module registry. Invokes the LLM once
 * and extracts document citations from the response text.
 *
 * State contract:
 *   IN:  state.retrieved_chunks, state.messages, state.task_type,
 *        state.is_cross_dept_query, state.orgId
 *   OUT: state.final_answer (string), state.cited_sources (CitedSource[]),
 *        state.retrieved_chunks (cleared)
 *
 * @param state - Current LangGraph thread state
 * @returns State update with final_answer and cited_sources
 */
export async function synthesisAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  const { retrieved_chunks, messages, task_type, is_cross_dept_query, orgId } = state;

  if (!retrieved_chunks || retrieved_chunks.length === 0) {
    return {
      final_answer: "I don't have enough information in your connected sources to answer that.",
      cited_sources: [],
      retrieved_chunks: [],
    };
  }

  // ── Separate vector chunks from graph results ─────────────
  const vectorChunks: RetrievedChunk[] = retrieved_chunks.filter(isVectorChunk);
  const graphResults: GraphResult[] = retrieved_chunks.filter(isGraphResult);

  // Check if any graph result has boundary_reached
  const boundaryReached = graphResults.some((gr) => gr.boundaryReached);

  const isBIMode = task_type === "analytical" || is_cross_dept_query === true;
  const mode = isBIMode ? "BI (BUSINESS INTELLIGENCE) MODE" : "STANDARD MODE";

  // Detect dominant department to inject domain-specific synthesis guidance
  const dominantDeptId = detectDominantDept(vectorChunks);
  const verticalModule = dominantDeptId
    ? VERTICAL_MODULES.find((m) => m.id === dominantDeptId || m.activating_sources.some(() => false))
    : null;
  // Match by department_id stored on chunks against modules by any activating_source presence
  // Fallback: match module by dept UUID via a direct lookup on chunks source_type
  const chunkSourceTypes = [...new Set(vectorChunks.map((c) => c.source_type).filter(Boolean))];
  const matchedModule = VERTICAL_MODULES.find((m) =>
    m.activating_sources.some((s) => chunkSourceTypes.includes(s))
  );
  const deptGuidance = (matchedModule ?? verticalModule)?.synthesis_prompt_addendum
    ? `DOMAIN GUIDANCE:\n${(matchedModule ?? verticalModule)!.synthesis_prompt_addendum}`
    : "";

  // Build vector context — use chunk_text (full stored text) for LLM context;
  // fall back to content_preview for documents indexed before §4 P0-A migration.
  // Chunks where both are empty are skipped — they'd inject a blank section and
  // mislead the LLM about how much evidence is available.
  const textChunks = vectorChunks.filter((c) => {
    const text = c.chunk_text?.trim() || c.content_preview?.trim();
    return !!text;
  });

  let context: string;
  if (textChunks.length === 0) {
    context = vectorChunks.length > 0
      ? "Retrieved chunks exist but contain no readable text. The affected documents may need to be re-indexed."
      : "No document chunks retrieved.";
  } else {
    context = textChunks
      .map((c: RetrievedChunk) => {
        const bodyText = c.chunk_text?.trim() || c.content_preview?.trim() || "";
        const titleLabel = c.title ? ` | ${c.title}` : "";
        const header = `[document_id: ${c.document_id}${titleLabel} | ${c.source_type}]`;
        return `${header}\n${bodyText}`;
      })
      .join("\n\n---\n\n");
  }

  // Build graph context
  const graphContext = buildGraphContext(graphResults);

  // Build boundary note
  const boundaryNote = boundaryReached
    ? "IMPORTANT: The knowledge graph traversal reached a boundary. Append this note to your answer: \"Note: there may be related information in areas you don't have access to.\""
    : "";

  const systemPrompt = SYNTHESIS_PROMPT
    .replace("{{MODE}}", mode)
    .replace("{{DEPT_GUIDANCE}}", deptGuidance)
    .replace("{{CONTEXT}}", context)
    .replace("{{GRAPH_CONTEXT}}", graphContext)
    .replace("{{BOUNDARY_NOTE}}", boundaryNote);

  const chatModel = await resolveModelClient("complex", orgId, 0);
  const response = await chatModel.invoke([
    new SystemMessage(systemPrompt),
    ...messages,
  ]);

  const finalAnswer =
    typeof response.content === "string"
      ? response.content
      : (response.content as MessageContentComplex[])
          .map((c: MessageContentComplex) =>
            typeof c === "string" ? c : (c as { type: string; text?: string }).text ?? ""
          )
          .join("");

  const cited_sources = extractCitations(finalAnswer, vectorChunks);

  return {
    final_answer: finalAnswer,
    cited_sources,
    retrieved_chunks: [],
  };
}

function extractCitations(text: string, chunks: RetrievedChunk[]): CitedSource[] {
  const docIdRegex = /\[([a-zA-Z0-9_-]+)\]/g;
  const uniqueDocIds = Array.from(
    new Set([...text.matchAll(docIdRegex)].map((m) => m[1]))
  );

  // Filter out special tags like "EXTRACTED" and "document_id"
  const realDocIds = uniqueDocIds.filter(
    (id) => id !== "EXTRACTED" && id !== "document_id"
  );

  return realDocIds.flatMap((docId): CitedSource[] => {
    const chunk = chunks.find((c: RetrievedChunk) => c.document_id === docId);
    if (!chunk) return [];
    return [{
      document_id: chunk.document_id,
      title: chunk.title ?? null,
      external_url: chunk.external_url,
      chunk_index: chunk.chunk_index,
      source_type: chunk.source_type,
    }];
  });
}
