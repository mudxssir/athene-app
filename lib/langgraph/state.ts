import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

/**
 * AtheneState represents the flattened graph state.
 * Root-level orgId, userId, and role are required for RLS tool extraction.
 */
export const AtheneState = Annotation.Root({
  ...MessagesAnnotation.spec,
  orgId: Annotation<string>(),
  userId: Annotation<string>(),
  role: Annotation<string>(),
  deptId: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  next_node: Annotation<string>(),
  retrievedDocs: Annotation<any[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  user: Annotation<{
    timezone: string;
    id: string;
    email?: string;
  } | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  // Approval gate fields
  awaiting_approval: Annotation<boolean>({
    reducer: (_x, y) => y,
    default: () => false,
  }),
  pending_write_action: Annotation<PendingWriteAction | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  // Run lifecycle
  run_status: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => "running",
  }),
  // Final answer / synthesis output
  final_answer: Annotation<any | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  // Citations from synthesis agent
  cited_sources: Annotation<any[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  // Retrieved chunks (raw, before synthesis).
  // Last-write-wins: each retrieval hop replaces the prior set so synthesis
  // only sees the chunks from the most recent retrieval, not an ever-growing
  // accumulation across all hops that would overflow the context window.
  retrieved_chunks: Annotation<any[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  // Action execution results
  action_result: Annotation<any | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  action_error: Annotation<any | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  // Synthesis mode hints
  task_type: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  is_cross_dept_query: Annotation<boolean>({
    reducer: (_x, y) => y,
    default: () => false,
  }),
  hop_count: Annotation<number>({
    reducer: (_x, y) => y,
    default: () => 0,
  }),
  complexity: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  reasoning: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  // Report sections map
  content: Annotation<Record<string, string> | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  // Multi-step query plan from plannerAgent (4C)
  planning_steps: Annotation<Array<{ id: string; query: string; department: string; depends_on: string[] }> | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
});

export type AtheneStateType = typeof AtheneState.State;

/** Type alias used by node function signatures */
export type AtheneState = AtheneStateType;

/** Partial return type for node functions */
export type AtheneStateUpdate = Partial<AtheneStateType>;

/** User roles recognized throughout the system */
export type UserRole = "member" | "super_user" | "admin";

export interface RetrievedChunk {
  /** RPC-assigned row UUID (document_embeddings.id). */
  chunk_id?: string;
  /** Legacy alias kept for callers that set id instead of chunk_id. */
  id?: string;
  document_id: string;
  /**
   * Full stored chunk text (metadata->>'chunk_text' or full content_preview).
   * This is what gets sent to the LLM for synthesis context.
   * Populated by vector_search RPC after §4 P0-A migration.
   */
  chunk_text?: string;
  /**
   * 200-character display snippet for UI tooltips and citations.
   * Also used as the fallback for `chunk_text` on old-indexed documents.
   */
  content_preview: string;
  /** Document title from the documents JOIN — populated after §4 P0-A migration. */
  title?: string | null;
  chunk_index: number;
  source_type: string;
  external_url?: string | null;
  department_id?: string | null;
  similarity?: number;
}

export interface CitedSource {
  document_id: string;
  title: string | null;
  external_url?: string | null;
  chunk_index: number;
  source_type: string;
}

/** Shape of a pending write action waiting for HITL approval */
export interface PendingWriteAction {
  tool: string;
  payload: Record<string, unknown>;
  requested_at: string;
}
