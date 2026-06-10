# Graph Report - athene-app  (2026-06-10)

## Corpus Check
- 501 files · ~315,626 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1452 nodes · 2315 edges · 38 communities detected
- Extraction: 62% EXTRACTED · 38% INFERRED · 0% AMBIGUOUS · INFERRED: 884 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 68|Community 68]]

## God Nodes (most connected - your core abstractions)
1. `error()` - 122 edges
2. `POST()` - 97 edges
3. `warn()` - 79 edges
4. `GET()` - 65 edges
5. `Select()` - 59 edges
6. `DELETE()` - 41 edges
7. `log()` - 31 edges
8. `info()` - 29 edges
9. `withRLS()` - 28 edges
10. `PATCH()` - 26 edges

## Surprising Connections (you probably didn't know these)
- `GET()` --calls--> `getProviderBrowser()`  [INFERRED]
  app/api/files/download/route.ts → lib/integrations/browsing.ts
- `resolveInternalAdminContext()` --calls--> `Select()`  [INFERRED]
  app/api/admin/keys/route.ts → components/ui/select.tsx
- `fetchAll()` --calls--> `error()`  [INFERRED]
  app/(dashboard)/admin/audit/page.tsx → scripts/setup-nango-providers.ts
- `Select()` --calls--> `verifyThreadOwner()`  [INFERRED]
  components/ui/select.tsx → lib/graph/interrupts.ts
- `handleAction()` --calls--> `error()`  [INFERRED]
  components/chat/hitl-modal.tsx → scripts/setup-nango-providers.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (77): bootstrapOnboarding(), syncUserAndOrg(), writeAuditLog(), writeGrantAccessAudit(), handleToggle(), addNode(), handleDeconstruct(), handleDeployFleet() (+69 more)

### Community 1 - "Community 1"
Cohesion: 0.03
Nodes (45): requireAdmin(), invalidateRBACCache(), makeCacheKey(), classifyFileLayer(), mapRole(), cached(), rateLimit(), saveConnectionMapping() (+37 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (57): baseFetch(), baseFetchRaw(), getProviderMetadata(), getProviderToken(), sleep(), browseBigQuery(), browseConfluence(), browseDbt() (+49 more)

### Community 3 - "Community 3"
Cohesion: 0.04
Nodes (51): fetchZendeskArticles(), stripHtml(), cachedAuth(), getSessionCacheKey(), fetchChannelMessages(), fetchSlackMessages(), getWorkspaceDomain(), listChannels() (+43 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (45): browseGitHub(), buildReport(), buildSection(), generateSummary(), runConcurrently(), runScheduledReport(), deleteConnection(), getConnection() (+37 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (52): buildGraphForDocuments(), markExtracted(), processDocument(), diffAgentNode(), fetchChunksInWindow(), parseTimeBoundary(), assertDims(), callProviderWithRetry() (+44 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (42): agentStream(), dashboardLoad(), getParams(), handleSummary(), randomThreadId(), check(), heal(), getToolByName() (+34 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (41): googleFetch(), googleFetchRaw(), runEntityResolutionBackfill(), runEntityResolutionBackfillAllOrgs(), createCalendarEvent(), deleteCalendarEvent(), fetchCalendarChunks(), fetchCalendarEvents() (+33 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (31): extractTextFromADF(), jiraAdfToText(), assertSafeMetadata(), browseLinear(), calendarEventToChunk(), fetchMetabaseContent(), getAtlassianResources(), linearFetch() (+23 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (33): buildAggregationChunk(), buildSampleChunk(), buildStatsChunk(), classifyColumn(), detectPrimaryDimension(), extractSchemaEntities(), resolveSyncConfig(), getRedshiftCredentials() (+25 more)

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (25): fetchSalesforceAccounts(), fetchSalesforceCases(), applySinceTo(), hubspotFetch(), salesforceFetch(), fetchHubSpotCompanies(), fetchHubSpotContacts(), fetchSalesforceContacts() (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.08
Nodes (27): browsePowerBI(), browseNotion(), listWorkspaces(), notionFetch(), buildSchemaHeader(), fetchAllDatabases(), fetchDatabaseContent(), getDatabaseTitle() (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.1
Nodes (20): createEvent(), fetchEvents(), findFreeSlots(), parseDocument(), parseDocumentEnhanced(), parseDocumentStructured(), graphDownload(), graphFetch() (+12 more)

### Community 13 - "Community 13"
Cohesion: 0.09
Nodes (12): makeConnectionQuery(), mockChain(), makeAuditTable(), mockAnthropicResponse(), fetchWithTimeout(), makeFromChain(), fn(), handleAdd() (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.19
Nodes (13): register(), getTracer(), getTracerInstance(), initTelemetry(), startSpan(), withAgentRunSpan(), withLLMSpan(), withSpan() (+5 more)

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (15): actionExecutorNode(), resolveConnection(), toGoogleEmailDraft(), toGoogleEventDraft(), toMicrosoftEmailDraft(), toMicrosoftEventDraft(), withTimeout(), getMeter() (+7 more)

### Community 16 - "Community 16"
Cohesion: 0.19
Nodes (9): generateMessageId(), LocalDispatcher, sleep(), getBriefingEndpoint(), getLocalParts(), getNextLocal7AmUtc(), scheduleMorningBriefings(), zonedTimeToUtc() (+1 more)

### Community 17 - "Community 17"
Cohesion: 0.14
Nodes (5): goto(), ensureSsl(), getCheckpointer(), setup(), signIn()

### Community 18 - "Community 18"
Cohesion: 0.23
Nodes (13): extractFromChunk(), llmExtract(), loadPrompt(), normalizeExtraction(), normConfidence(), normEntityType(), normLabel(), normProvenance() (+5 more)

### Community 19 - "Community 19"
Cohesion: 0.29
Nodes (6): generateMorningBriefing(), parseBriefingSections(), truncateSummary(), extractText(), parseGraphRelationships(), reportAgent()

### Community 20 - "Community 20"
Cohesion: 0.38
Nodes (9): doneEvent(), encodeSSEEvent(), errorEvent(), formatSSEEvent(), interruptEvent(), stateEvent(), tokenEvent(), toolEndEvent() (+1 more)

### Community 21 - "Community 21"
Cohesion: 0.25
Nodes (2): transitionFor(), TransitionProvider()

### Community 22 - "Community 22"
Cohesion: 0.29
Nodes (2): eqChain(), leaf()

### Community 24 - "Community 24"
Cohesion: 0.33
Nodes (2): SidebarMenuButton(), useSidebar()

### Community 25 - "Community 25"
Cohesion: 0.33
Nodes (3): entityColorFallback(), fetchEdgesInBatches(), resolveNodeColor()

### Community 26 - "Community 26"
Cohesion: 0.43
Nodes (4): buildGraphContext(), detectDominantDept(), extractCitations(), synthesisAgentNode()

### Community 29 - "Community 29"
Cohesion: 0.53
Nodes (4): handleApprove(), handleEditSave(), handleReject(), readApprovalStream()

### Community 30 - "Community 30"
Cohesion: 0.4
Nodes (3): handleAction(), isEmailTool(), isRecipientMissing()

### Community 31 - "Community 31"
Cohesion: 0.5
Nodes (3): fetchAll(), formatAction(), getActionIcon()

### Community 33 - "Community 33"
Cohesion: 0.4
Nodes (1): makeState()

### Community 41 - "Community 41"
Cohesion: 0.5
Nodes (2): NotFound(), BuilderRoute()

### Community 42 - "Community 42"
Cohesion: 0.67
Nodes (2): Reveal(), useReveal()

### Community 44 - "Community 44"
Cohesion: 0.67
Nodes (2): handleKeyDown(), sendMessage()

### Community 47 - "Community 47"
Cohesion: 0.5
Nodes (2): ResourceIcon(), cn()

### Community 50 - "Community 50"
Cohesion: 0.67
Nodes (2): makeIssue(), makePage()

### Community 56 - "Community 56"
Cohesion: 0.67
Nodes (1): ThemeProvider()

### Community 60 - "Community 60"
Cohesion: 1.0
Nodes (2): embed(), getClient()

### Community 68 - "Community 68"
Cohesion: 1.0
Nodes (2): mockByokJina(), mockJinaResponse()

## Knowledge Gaps
- **Thin community `Community 21`** (8 nodes): `transition-provider.tsx`, `kit.tsx`, `radialFor()`, `stampFor()`, `TCard()`, `transitionFor()`, `useNavigate()`, `TransitionProvider()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (8 nodes): `deleteFn()`, `eqChain()`, `leaf()`, `makeChunk()`, `selectFn()`, `sha256()`, `upsertFn()`, `indexing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (7 nodes): `sidebar.tsx`, `cn()`, `handleKeyDown()`, `SidebarMenu()`, `SidebarMenuButton()`, `SidebarMenuItem()`, `useSidebar()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 33`** (5 nodes): `synthesis-agent.test.ts`, `synthesis-agent.test.ts`, `makeChunk()`, `makeGraphResult()`, `makeState()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (4 nodes): `page.tsx`, `not-found.tsx`, `NotFound()`, `BuilderRoute()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 42`** (4 nodes): `landing-page.tsx`, `onScroll()`, `Reveal()`, `useReveal()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (4 nodes): `composer.tsx`, `handleInput()`, `handleKeyDown()`, `sendMessage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (4 nodes): `resource-browser.tsx`, `utils.ts`, `ResourceIcon()`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (4 nodes): `makeIssue()`, `makePage()`, `issues-fetcher.test.ts`, `issues-fetcher.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 56`** (3 nodes): `theme-provider.tsx`, `theme-provider.tsx`, `ThemeProvider()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (3 nodes): `embed()`, `getClient()`, `embedder.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (3 nodes): `mockByokJina()`, `mockJinaResponse()`, `embedding-factory.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `error()` connect `Community 0` to `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 9`, `Community 10`, `Community 11`, `Community 12`, `Community 15`, `Community 16`, `Community 17`, `Community 18`, `Community 19`, `Community 25`, `Community 30`, `Community 31`?**
  _High betweenness centrality (0.182) - this node is a cross-community bridge._
- **Why does `warn()` connect `Community 7` to `Community 0`, `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 9`, `Community 10`, `Community 12`, `Community 13`, `Community 16`, `Community 17`, `Community 18`, `Community 19`?**
  _High betweenness centrality (0.140) - this node is a cross-community bridge._
- **Why does `POST()` connect `Community 1` to `Community 0`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 10`, `Community 11`, `Community 13`, `Community 16`, `Community 18`?**
  _High betweenness centrality (0.066) - this node is a cross-community bridge._
- **Are the 120 inferred relationships involving `error()` (e.g. with `syncUserAndOrg()` and `GET()`) actually correct?**
  _`error()` has 120 INFERRED edges - model-reasoned connections that need verification._
- **Are the 45 inferred relationships involving `POST()` (e.g. with `rateLimit()` and `Select()`) actually correct?**
  _`POST()` has 45 INFERRED edges - model-reasoned connections that need verification._
- **Are the 76 inferred relationships involving `warn()` (e.g. with `resolveContext()` and `runAgentQuery()`) actually correct?**
  _`warn()` has 76 INFERRED edges - model-reasoned connections that need verification._
- **Are the 17 inferred relationships involving `GET()` (e.g. with `Select()` and `.set()`) actually correct?**
  _`GET()` has 17 INFERRED edges - model-reasoned connections that need verification._