import { DynamicStructuredTool } from '@langchain/core/tools'

/**
 * Central registry for all LangGraph DynamicStructuredTools.
 * Tools register themselves at module load time via registerTool().
 * The graph compiles this list into the ToolNode.
 */
export const toolsRegistry: DynamicStructuredTool[] = []

export function registerTool(tool: DynamicStructuredTool): void {
  toolsRegistry.push(tool)
}

export default {
  toolsRegistry,
  registerTool,
}

// Re-export concrete tool instances so node files can import from here
export { vectorSearchTool, crossDeptVectorSearchTool } from './vector-search'
// P6-9: get_scope_summary (scopeSummaryTool) is imported directly by its consumer
// when wired into the agent flow (the pilot integration), not auto-registered here
// — auto-registration pulled it into the agent bundle for no benefit (nothing reads
// toolsRegistry yet) and risked an import cycle in the compiled graph.
