# Graph Report - athene-app  (2026-05-25)

## Corpus Check
- 463 files · ~307,693 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1332 nodes · 2044 edges · 37 communities detected
- Extraction: 62% EXTRACTED · 38% INFERRED · 0% AMBIGUOUS · INFERRED: 767 edges (avg confidence: 0.8)
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
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 66|Community 66]]

## God Nodes (most connected - your core abstractions)
1. `error()` - 106 edges
2. `POST()` - 83 edges
3. `warn()` - 64 edges
4. `GET()` - 56 edges
5. `Select()` - 46 edges
6. `DELETE()` - 35 edges
7. `info()` - 25 edges
8. `withRLS()` - 25 edges
9. `baseFetch()` - 24 edges
10. `PATCH()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `GET()` --calls--> `getProviderBrowser()`  [INFERRED]
  app/api/files/download/route.ts → lib/integrations/browsing.ts
- `handleRunSimulation()` --calls--> `info()`  [INFERRED]
  app/agent-lab/page.tsx → scripts/setup-nango-providers.ts
- `fetchEdgesInBatches()` --calls--> `error()`  [INFERRED]
  components/graph/knowledge-graph-canvas.tsx → scripts/setup-nango-providers.ts
- `check()` --calls--> `Select()`  [INFERRED]
  check-db.ts → components/ui/select.tsx
- `syncUserAndOrg()` --calls--> `error()`  [INFERRED]
  app/org-selection/actions.ts → scripts/setup-nango-providers.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (53): bootstrapOnboarding(), syncUserAndOrg(), requireAdmin(), invalidateRBACCache(), makeCacheKey(), classifyFileLayer(), mapRole(), cached() (+45 more)

### Community 1 - "Community 1"
Cohesion: 0.03
Nodes (76): extractTextFromADF(), jiraAdfToText(), googleFetchRaw(), fetchZendeskArticles(), stripHtml(), assertSafeMetadata(), baseFetch(), baseFetchRaw() (+68 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (57): writeAuditLog(), writeGrantAccessAudit(), handleToggle(), calendarAgent(), getSystemPrompt(), lookerInstanceUrl(), crossDeptAgent(), writeBIAuditRows() (+49 more)

### Community 3 - "Community 3"
Cohesion: 0.04
Nodes (47): cachedAuth(), getSessionCacheKey(), fetchChannelMessages(), fetchSlackMessages(), getWorkspaceDomain(), listChannels(), incrWithExpire(), detectCommunities() (+39 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (47): buildGraphForDocuments(), markExtracted(), processDocument(), extractEntitiesAndRelations(), extractFromChunk(), llmExtract(), loadPrompt(), normalizeExtraction() (+39 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (39): browsePowerBI(), browseLinear(), browseNotion(), fetchMetabaseContent(), linearFetch(), listWorkspaces(), notionFetch(), linearCyclesFetcher() (+31 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (35): googleFetch(), createCalendarEvent(), deleteCalendarEvent(), fetchCalendarChunks(), fetchCalendarEvents(), fetchTodayEvents(), fetchWeekEvents(), updateCalendarEvent() (+27 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (39): buildAggregationChunk(), buildSampleChunk(), buildStatsChunk(), classifyColumn(), detectPrimaryDimension(), extractSchemaEntities(), resolveSyncConfig(), getRedshiftCredentials() (+31 more)

### Community 8 - "Community 8"
Cohesion: 0.08
Nodes (24): fetchSalesforceAccounts(), fetchSalesforceCases(), hubspotFetch(), salesforceFetch(), fetchHubSpotCompanies(), fetchHubSpotContacts(), fetchSalesforceContacts(), fetchHubSpotDeals() (+16 more)

### Community 9 - "Community 9"
Cohesion: 0.11
Nodes (20): browseGitHub(), deleteConnection(), getConnection(), getConnectionMetadata(), getConnectionToken(), getNango(), getToken(), githubFetch() (+12 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (11): makeConnectionQuery(), mockChain(), makeAuditTable(), mockAnthropicResponse(), fetchWithTimeout(), makeFromChain(), fn(), handleAdd() (+3 more)

### Community 11 - "Community 11"
Cohesion: 0.15
Nodes (11): generateMessageId(), LocalDispatcher, getBriefingEndpoint(), getLocalParts(), getNextLocal7AmUtc(), scheduleMorningBriefings(), zonedTimeToUtc(), getServerBaseUrl() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.16
Nodes (14): register(), getTracer(), getTracerInstance(), initTelemetry(), startSpan(), withAgentRunSpan(), withLLMSpan(), withSpan() (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.31
Nodes (17): ask(), askChoice(), askSecret(), askYesNo(), banner(), error(), info(), main() (+9 more)

### Community 14 - "Community 14"
Cohesion: 0.22
Nodes (15): actionExecutorNode(), resolveConnection(), toGoogleEmailDraft(), toGoogleEventDraft(), toMicrosoftEmailDraft(), toMicrosoftEventDraft(), withTimeout(), getMeter() (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.22
Nodes (15): assertDims(), callProviderWithRetry(), embed(), embedBatch(), embedTexts(), embedWithGoogle(), embedWithJina(), embedWithLocal() (+7 more)

### Community 16 - "Community 16"
Cohesion: 0.2
Nodes (5): needsConfiguration(), getProvider(), getProviderByNangoKey(), getProviderConfig(), isBrowsable()

### Community 17 - "Community 17"
Cohesion: 0.25
Nodes (8): decodeBase64Url(), extractBodyFromPayload(), fetchEmailBody(), indexEmailChunks(), searchEmailChunks(), searchEmails(), sendEmail(), stripHtmlTags()

### Community 18 - "Community 18"
Cohesion: 0.29
Nodes (6): generateMorningBriefing(), parseBriefingSections(), truncateSummary(), extractText(), parseGraphRelationships(), reportAgent()

### Community 19 - "Community 19"
Cohesion: 0.38
Nodes (9): doneEvent(), encodeSSEEvent(), errorEvent(), formatSSEEvent(), interruptEvent(), stateEvent(), tokenEvent(), toolEndEvent() (+1 more)

### Community 20 - "Community 20"
Cohesion: 0.22
Nodes (2): goto(), signIn()

### Community 21 - "Community 21"
Cohesion: 0.36
Nodes (5): agentStream(), dashboardLoad(), getParams(), randomThreadId(), check()

### Community 22 - "Community 22"
Cohesion: 0.25
Nodes (2): transitionFor(), TransitionProvider()

### Community 23 - "Community 23"
Cohesion: 0.32
Nodes (4): getToolByName(), getToolNamesForRole(), getToolsForRole(), verify()

### Community 24 - "Community 24"
Cohesion: 0.29
Nodes (2): eqChain(), leaf()

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (2): SidebarMenuButton(), useSidebar()

### Community 27 - "Community 27"
Cohesion: 0.33
Nodes (3): entityColorFallback(), fetchEdgesInBatches(), resolveNodeColor()

### Community 29 - "Community 29"
Cohesion: 0.53
Nodes (4): handleApprove(), handleEditSave(), handleReject(), readApprovalStream()

### Community 32 - "Community 32"
Cohesion: 0.4
Nodes (1): makeState()

### Community 33 - "Community 33"
Cohesion: 0.6
Nodes (3): buildPrompt(), emailAgentNode(), parseEmailDraft()

### Community 41 - "Community 41"
Cohesion: 0.67
Nodes (2): Reveal(), useReveal()

### Community 43 - "Community 43"
Cohesion: 0.67
Nodes (2): handleKeyDown(), sendMessage()

### Community 45 - "Community 45"
Cohesion: 0.5
Nodes (2): ResourceIcon(), cn()

### Community 48 - "Community 48"
Cohesion: 0.67
Nodes (2): makeIssue(), makePage()

### Community 55 - "Community 55"
Cohesion: 0.67
Nodes (1): ThemeProvider()

### Community 58 - "Community 58"
Cohesion: 1.0
Nodes (2): embed(), getClient()

### Community 66 - "Community 66"
Cohesion: 1.0
Nodes (2): mockByokJina(), mockJinaResponse()

## Knowledge Gaps
- **Thin community `Community 20`** (9 nodes): `apiFetch()`, `goto()`, `shot()`, `athene-full.spec.ts`, `getLastAssistantMessage()`, `sendChatMessage()`, `signIn()`, `waitForChatResponse()`, `helpers.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (8 nodes): `transition-provider.tsx`, `kit.tsx`, `radialFor()`, `stampFor()`, `TCard()`, `transitionFor()`, `useNavigate()`, `TransitionProvider()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (8 nodes): `deleteFn()`, `eqChain()`, `leaf()`, `makeChunk()`, `selectFn()`, `sha256()`, `upsertFn()`, `indexing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (7 nodes): `sidebar.tsx`, `cn()`, `handleKeyDown()`, `SidebarMenu()`, `SidebarMenuButton()`, `SidebarMenuItem()`, `useSidebar()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 32`** (5 nodes): `synthesis-agent.test.ts`, `synthesis-agent.test.ts`, `makeChunk()`, `makeGraphResult()`, `makeState()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 41`** (4 nodes): `landing-page.tsx`, `onScroll()`, `Reveal()`, `useReveal()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 43`** (4 nodes): `composer.tsx`, `handleInput()`, `handleKeyDown()`, `sendMessage()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (4 nodes): `resource-browser.tsx`, `utils.ts`, `ResourceIcon()`, `cn()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 48`** (4 nodes): `makeIssue()`, `makePage()`, `issues-fetcher.test.ts`, `issues-fetcher.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 55`** (3 nodes): `theme-provider.tsx`, `theme-provider.tsx`, `ThemeProvider()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 58`** (3 nodes): `embed()`, `getClient()`, `embedder.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 66`** (3 nodes): `mockByokJina()`, `mockJinaResponse()`, `embedding-factory.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `error()` connect `Community 2` to `Community 0`, `Community 33`, `Community 1`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 9`, `Community 11`, `Community 12`, `Community 14`, `Community 15`, `Community 18`, `Community 27`?**
  _High betweenness centrality (0.151) - this node is a cross-community bridge._
- **Why does `warn()` connect `Community 6` to `Community 0`, `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 7`, `Community 8`, `Community 9`, `Community 11`, `Community 12`, `Community 15`, `Community 18`?**
  _High betweenness centrality (0.115) - this node is a cross-community bridge._
- **Why does `POST()` connect `Community 0` to `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 8`, `Community 9`, `Community 11`, `Community 15`, `Community 21`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Are the 104 inferred relationships involving `error()` (e.g. with `syncUserAndOrg()` and `GET()`) actually correct?**
  _`error()` has 104 INFERRED edges - model-reasoned connections that need verification._
- **Are the 39 inferred relationships involving `POST()` (e.g. with `rateLimit()` and `Select()`) actually correct?**
  _`POST()` has 39 INFERRED edges - model-reasoned connections that need verification._
- **Are the 61 inferred relationships involving `warn()` (e.g. with `resolveContext()` and `runAgentQuery()`) actually correct?**
  _`warn()` has 61 INFERRED edges - model-reasoned connections that need verification._
- **Are the 16 inferred relationships involving `GET()` (e.g. with `Select()` and `error()`) actually correct?**
  _`GET()` has 16 INFERRED edges - model-reasoned connections that need verification._