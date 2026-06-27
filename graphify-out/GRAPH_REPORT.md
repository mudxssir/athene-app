# Graph Report - athene-app  (2026-06-15)

## Corpus Check
- 605 files · ~444,198 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1933 nodes · 3297 edges · 42 communities detected
- Extraction: 61% EXTRACTED · 39% INFERRED · 0% AMBIGUOUS · INFERRED: 1273 edges (avg confidence: 0.8)
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
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 74|Community 74]]

## God Nodes (most connected - your core abstractions)
1. `POST()` - 145 edges
2. `warn()` - 141 edges
3. `error()` - 127 edges
4. `Select()` - 92 edges
5. `GET()` - 76 edges
6. `DELETE()` - 48 edges
7. `NOW()` - 38 edges
8. `info()` - 36 edges
9. `log()` - 35 edges
10. `parse()` - 34 edges

## Surprising Connections (you probably didn't know these)
- `GET()` --calls--> `getProviderBrowser()`  [INFERRED]
  app/api/files/download/route.ts → lib/integrations/browsing.ts
- `resolveInternalAdminContext()` --calls--> `Select()`  [INFERRED]
  app/api/admin/keys/route.ts → components/ui/select.tsx
- `make()` --calls--> `fn()`  [INFERRED]
  lib/knowledge-graph/__tests__/scope-summary.test.ts → app/(dashboard)/insights/page.tsx
- `handleHitl()` --calls--> `success()`  [INFERRED]
  app/(dashboard)/chat/page.tsx → scripts/setup-nango-providers.ts
- `fetchThreadState()` --calls--> `error()`  [INFERRED]
  app/(dashboard)/chat/[threadId]/page.tsx → scripts/setup-nango-providers.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (81): requireAdmin(), getBlockerMatrix(), cachedAuth(), getSessionCacheKey(), classifyFileLayer(), mapRole(), cached(), dispatchThrottled() (+73 more)

### Community 1 - "Community 1"
Cohesion: 0.02
Nodes (83): baseFetch(), baseFetchRaw(), getProviderMetadata(), getProviderToken(), sleep(), enqueueMediaStubs(), orgAllowsExternalParsing(), parseBinaryTiered() (+75 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (62): writeAuditLog(), writeGrantAccessAudit(), handleToggle(), handleDeconstruct(), handleDeployFleet(), handleStoreConfig(), calendarAgent(), getSystemPrompt() (+54 more)

### Community 3 - "Community 3"
Cohesion: 0.04
Nodes (77): buildReport(), buildSection(), generateSummary(), runConcurrently(), runScheduledReport(), captionChunkId(), enqueueCaptionDrain(), indexCaption() (+69 more)

### Community 4 - "Community 4"
Cohesion: 0.03
Nodes (57): addNode(), fetchChannelMessages(), fetchSlackMessages(), getWorkspaceDomain(), listChannels(), main(), incrWithExpire(), detectCommunities() (+49 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (65): buildGraphForDocuments(), markExtracted(), processDocument(), diffAgentNode(), fetchChunksInWindow(), parseTimeBoundary(), _pickTopId(), _resolve() (+57 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (57): handleApprove(), handleEditSave(), handleReject(), readApprovalStream(), BaseModel, classifySeverity(), diffAnswers(), jaccardSimilarity() (+49 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (59): runEntityResolutionBackfill(), runEntityResolutionBackfillAllOrgs(), isSkipSentinel(), computeSignals(), countTokens(), neutralizeMonsterRuns(), selectStrategy(), truncateAtTokenCap() (+51 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (52): extractTextFromADF(), jiraAdfToText(), googleFetch(), googleFetchRaw(), fetchZendeskArticles(), stripHtml(), assertSafeMetadata(), calendarEventToChunk() (+44 more)

### Community 9 - "Community 9"
Cohesion: 0.06
Nodes (47): buildAggregationChunk(), buildSampleChunk(), buildSchemaEntityGraph(), buildStatsChunk(), classifyColumn(), detectPrimaryDimension(), extractSchemaEntities(), maskPII() (+39 more)

### Community 10 - "Community 10"
Cohesion: 0.05
Nodes (40): fenceCode(), browsePowerBI(), browseLinear(), browseNotion(), fetchMetabaseContent(), linearFetch(), listWorkspaces(), notionFetch() (+32 more)

### Community 11 - "Community 11"
Cohesion: 0.04
Nodes (29): generateRunId(), timeAgo(), needsConfiguration(), relativeTime(), blockedFor(), deleteThread(), fetchThreadState(), handleHitl() (+21 more)

### Community 12 - "Community 12"
Cohesion: 0.08
Nodes (41): agentStream(), dashboardLoad(), getParams(), handleSummary(), randomThreadId(), check(), isOldPerSliceEmailId(), main() (+33 more)

### Community 13 - "Community 13"
Cohesion: 0.04
Nodes (14): makeConnectionQuery(), mockChain(), mockChain(), makeBuilder(), makeAuditTable(), mockAnthropicResponse(), makeFromChain(), makeBuilder() (+6 more)

### Community 14 - "Community 14"
Cohesion: 0.11
Nodes (30): bootstrapOnboarding(), syncUserAndOrg(), invalidateRBACCache(), makeCacheKey(), buildEmailChunks(), fetchWithTimeout(), handleAdd(), handleDelete() (+22 more)

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (17): fetchSalesforceAccounts(), fetchSalesforceCases(), applySinceTo(), hubspotFetch(), salesforceFetch(), fetchHubSpotCompanies(), fetchHubSpotContacts(), fetchSalesforceContacts() (+9 more)

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (21): assertDims(), callProviderWithRetry(), embed(), embedBatch(), embedBatchDetailed(), embedBatchLateChunking(), embedBatchPinned(), embedTexts() (+13 more)

### Community 17 - "Community 17"
Cohesion: 0.15
Nodes (15): register(), getTracer(), getTracerInstance(), initTelemetry(), startSpan(), withAgentRunSpan(), withLLMSpan(), withSpan() (+7 more)

### Community 18 - "Community 18"
Cohesion: 0.19
Nodes (14): getRedshiftCredentials(), listRedshiftTables(), redshiftDataExecute(), redshiftDataGetResults(), redshiftDataPoll(), redshiftQuery(), redshiftFetcher(), redshiftSearch() (+6 more)

### Community 19 - "Community 19"
Cohesion: 0.18
Nodes (12): generateMorningBriefing(), parseBriefingSections(), truncateSummary(), extractText(), parseGraphRelationships(), reportAgent(), buildScopeSummaryPrompt(), fmtChildren() (+4 more)

### Community 20 - "Community 20"
Cohesion: 0.22
Nodes (15): actionExecutorNode(), resolveConnection(), toGoogleEmailDraft(), toGoogleEventDraft(), toMicrosoftEmailDraft(), toMicrosoftEventDraft(), withTimeout(), getMeter() (+7 more)

### Community 21 - "Community 21"
Cohesion: 0.19
Nodes (9): generateMessageId(), LocalDispatcher, sleep(), getBriefingEndpoint(), getLocalParts(), getNextLocal7AmUtc(), scheduleMorningBriefings(), zonedTimeToUtc() (+1 more)

### Community 22 - "Community 22"
Cohesion: 0.14
Nodes (5): goto(), ensureSsl(), getCheckpointer(), setup(), signIn()

### Community 23 - "Community 23"
Cohesion: 0.33
Nodes (9): buildEmail(), buildProse(), buildProseLong(), buildTabular(), buildThread(), buildWorkItem(), filler(), makeFacts() (+1 more)

### Community 24 - "Community 24"
Cohesion: 0.24
Nodes (6): eqChain(), leaf(), makeChunk(), provenanceChunk(), sentinelChunk(), sha256()

### Community 25 - "Community 25"
Cohesion: 0.38
Nodes (9): doneEvent(), encodeSSEEvent(), errorEvent(), formatSSEEvent(), interruptEvent(), stateEvent(), tokenEvent(), toolEndEvent() (+1 more)

### Community 26 - "Community 26"
Cohesion: 0.25
Nodes (2): transitionFor(), TransitionProvider()

### Community 28 - "Community 28"
Cohesion: 0.29
Nodes (2): eqChain(), leaf()

### Community 29 - "Community 29"
Cohesion: 0.32
Nodes (4): chunk(), jpegSegment(), makeJpeg(), makePng()

### Community 31 - "Community 31"
Cohesion: 0.33
Nodes (2): SidebarMenuButton(), useSidebar()

### Community 32 - "Community 32"
Cohesion: 0.43
Nodes (4): buildGraphContext(), detectDominantDept(), extractCitations(), synthesisAgentNode()

### Community 33 - "Community 33"
Cohesion: 0.43
Nodes (4): buildBreadcrumb(), cleanTitle(), containerSegment(), sourceLabel()

### Community 36 - "Community 36"
Cohesion: 0.4
Nodes (2): entityColorFallback(), resolveNodeColor()

### Community 38 - "Community 38"
Cohesion: 0.4
Nodes (1): makeState()

### Community 46 - "Community 46"
Cohesion: 0.5
Nodes (2): NotFound(), BuilderRoute()

### Community 47 - "Community 47"
Cohesion: 0.67
Nodes (2): Reveal(), useReveal()

### Community 48 - "Community 48"
Cohesion: 0.67
Nodes (2): handleKeyDown(), sendMessage()

### Community 50 - "Community 50"
Cohesion: 0.5
Nodes (2): ResourceIcon(), cn()

### Community 54 - "Community 54"
Cohesion: 0.67
Nodes (2): makeIssue(), makePage()

### Community 60 - "Community 60"
Cohesion: 0.67
Nodes (1): ThemeProvider()

### Community 64 - "Community 64"
Cohesion: 1.0
Nodes (2): embed(), getClient()

### Community 74 - "Community 74"
Cohesion: 1.0
Nodes (2): fetchThreadReplies(), fetchThreadReplyMessages()

## Knowledge Gaps
- **11 isolated node(s):** `services/athene-parse/main.py — Athene document parsing + chunking sidecar.  End`, `Parse a binary document (PDF, DOCX, PPTX, XLSX, HTML, …) to markdown.     Primar`, `Best-effort extraction of Docling tables into header+rows. Any API shape     mis`, `Best-effort extraction of picture provenance refs. We do NOT return image     by`, `Return the file extension including the leading dot, lower-cased.` (+6 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 26`** (8 nodes): `transition-provider.tsx`, `kit.tsx`, `radialFor()`, `stampFor()`, `TCard()`, `transitionFor()`, `useNavigate()`, `TransitionProvider()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 28`** (8 nodes): `deleteFn()`, `emailChunk()`, `eqChain()`, `leaf()`, `selectFn()`, `updateFn()`, `upsertFn()`, `indexing-context-envelope.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 31`** (7 nodes): `sidebar.tsx`, `cn()`, `handleKeyDown()`, `SidebarMenu()`, `SidebarMenuButton()`, `SidebarMenuItem()`, `useSidebar()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 36`** (6 nodes): `knowledge-graph-canvas.tsx`, `entityColorFallback()`, `forceLayout()`, `jitter()`, `nodeRadius()`, `resolveNodeColor()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 38`** (5 nodes): `synthesis-agent.test.ts`, `synthesis-agent.test.ts`, `makeChunk()`, `makeGraphResult()`, `makeState()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 46`** (4 nodes): `page.tsx`, `not-found.tsx`, `NotFound()`, `BuilderRoute()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 47`** (4 nodes): `landing-page.tsx`, `onScroll()`, `Reveal()`, `useReveal()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (4 nodes): `composer.tsx`, `handleInput()`, `handleKeyDown()`, `sendMessage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 50`** (4 nodes): `resource-browser.tsx`, `utils.ts`, `ResourceIcon()`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 54`** (4 nodes): `makeIssue()`, `makePage()`, `issues-fetcher.test.ts`, `issues-fetcher.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 60`** (3 nodes): `theme-provider.tsx`, `theme-provider.tsx`, `ThemeProvider()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 64`** (3 nodes): `embed()`, `getClient()`, `embedder.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 74`** (3 nodes): `threads-fetcher.ts`, `fetchThreadReplies()`, `fetchThreadReplyMessages()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `warn()` connect `Community 7` to `Community 0`, `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 8`, `Community 9`, `Community 11`, `Community 12`, `Community 14`, `Community 15`, `Community 16`, `Community 17`, `Community 18`, `Community 19`, `Community 21`, `Community 22`?**
  _High betweenness centrality (0.169) - this node is a cross-community bridge._
- **Why does `error()` connect `Community 2` to `Community 0`, `Community 1`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 9`, `Community 10`, `Community 11`, `Community 12`, `Community 14`, `Community 15`, `Community 16`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 21`, `Community 22`?**
  _High betweenness centrality (0.121) - this node is a cross-community bridge._
- **Why does `POST()` connect `Community 0` to `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 9`, `Community 10`, `Community 11`, `Community 12`, `Community 14`, `Community 16`, `Community 21`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Are the 85 inferred relationships involving `POST()` (e.g. with `rateLimit()` and `Select()`) actually correct?**
  _`POST()` has 85 INFERRED edges - model-reasoned connections that need verification._
- **Are the 138 inferred relationships involving `warn()` (e.g. with `resolveContext()` and `runAgentQuery()`) actually correct?**
  _`warn()` has 138 INFERRED edges - model-reasoned connections that need verification._
- **Are the 125 inferred relationships involving `error()` (e.g. with `syncUserAndOrg()` and `GET()`) actually correct?**
  _`error()` has 125 INFERRED edges - model-reasoned connections that need verification._
- **Are the 91 inferred relationships involving `Select()` (e.g. with `check()` and `syncUserAndOrg()`) actually correct?**
  _`Select()` has 91 INFERRED edges - model-reasoned connections that need verification._