-- ============================================================
-- Migration: 20260523000002_week4_frontend_observability_audit.sql
-- Domain 7 & 8 audit — frontend security & observability verification
--
-- This migration contains NO schema changes.  It is a permanent
-- record of the audit findings and verification queries for:
--
--   7A.1 — CSP 'unsafe-eval' stripped in production
--   7A.2 — Frame protection: X-Frame-Options + frame-ancestors
--   7A.3 — HSTS: max-age=63072000; includeSubDomains; preload
--   7A.5 — SSE stream contents: no raw vectors/embeddings exposed
--   7B.3 — External links use rel="noopener noreferrer"
--   7B.4 — File download route verifies org ownership before serving
--   8A.1 — resolveUserAccess & assertAdminRole unit-tested
--   8A.3 — All 8 LangGraph nodes have test coverage
--   8A.4 — Embedding factory: BYOK, fallback, dimension assertion tested
--   8A.6 — Nango HMAC rejection tested
--   8B.1 — withAgentRunSpan added to lib/telemetry/spans.ts
--   8B.2 — All 7 metrics instruments defined in lib/telemetry/metrics.ts
--
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 7A.1 — CSP 'unsafe-eval' in production
-- Finding: PASSED
-- next.config.ts conditionally omits 'unsafe-eval' from script-src
-- when NODE_ENV === 'production'.  Dev-only, never in production.
-- Verification: code review next.config.ts lines 12-17.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 7A.2 — Frame protection
-- Finding: PASSED
-- X-Frame-Options: SAMEORIGIN + CSP frame-ancestors 'none' are both set.
-- 'none' is stricter than 'SAMEORIGIN'; the combined defence is correct.
-- Verification: code review next.config.ts lines 7, 31.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 7A.3 — HSTS
-- Finding: PASSED
-- Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
-- Verification: code review next.config.ts line 11-13.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 7A.5 — SSE stream contents
-- Finding: PASSED
-- SSE frames contain only: cited_sources (metadata), awaiting_approval
-- (bool), active_agent (string), content (message text when non-streaming).
-- No raw embeddings, vectors, chunk content, or internal UUIDs exposed.
-- Verification: code review app/api/agent/route.ts lines 283-297.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 7B.1 — XSS in chat rendering
-- Finding: PASSED
-- No dangerouslySetInnerHTML in components/. React auto-escaping applies
-- to all message content. Tokens streamed as plain strings.
-- Verification: grep -rn "dangerouslySetInnerHTML" components/ → 0 results
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 7B.3 — External URL safety
-- Finding: PASSED
-- All external link renders include rel="noopener noreferrer":
--   components/chat/message-list.tsx:248
--   components/insights/insight-card.tsx:126
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 7B.4 — File download authorization
-- Finding: PASSED
-- /api/files/download verifies the storage path belongs to the caller's
-- org via: documents.eq("org_id", context.org_id).
-- Returns 404 (not 403) to avoid confirming file existence.
-- Verification: code review app/api/files/download/route.ts.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8A.1 — Auth path test coverage
-- Finding: GAP FIXED — new test file lib/auth/__tests__/rbac.test.ts
-- Added tests for:
--   resolveUserAccess: cache-hit path, DB-hit path, null-access path
--   assertAdminRole:   admin/super_user allowed, member/missing blocked,
--                      queries by PK 'id' not 'clerk_user_id'
-- Existing coverage: mapRole, getMasterKey, deriveOrgKey,
--   getContextFromHeaders all in lib/auth/__tests__/auth-unit.test.ts.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8A.3 — LangGraph node test coverage (all 8 nodes)
-- Finding: GAP FIXED
-- Previously missing:
--   lib/langgraph/nodes/__tests__/email-agent.test.ts   (ADDED)
--   lib/langgraph/nodes/__tests__/calendar-agent.test.ts (ADDED)
-- All 8 nodes now have dedicated test files:
--   supervisor, retrieval-agent, cross-dept-retrieval,
--   action-executor, planner-agent, report-agent,
--   synthesis-agent, email-agent, calendar-agent
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8A.4 — Embedding factory tests
-- Finding: GAP FIXED — new test file lib/ai/__tests__/embedding-factory.test.ts
-- Tests: BYOK skipped when KMS_KEY missing, BYOK skipped when no key rows,
--        dimension mismatch throws, embedBatch shape, local model fallback.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8A.5 — E2E HITL flow
-- Finding: PASSED
-- tests/e2e/email-approval.spec.ts covers the full
-- message → interrupt → approve → execution cycle.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8A.6 — Security boundary tests
-- Finding: GAP FIXED
-- Added: app/api/nango/webhook/__tests__/webhook.test.ts
--   Tests: valid sig → 200, invalid sig → 401, no sig → 401,
--          missing NANGO_SECRET_KEY → 401 (fail-closed),
--          sha256= prefixed format accepted.
-- Existing: lib/qstash/__tests__/verify.test.ts (QStash sig rejection)
--           tests/security/graph/org-isolation.test.ts (cross-org)
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8B.1 — OTEL span coverage
-- Finding: GAP FIXED
-- Added withAgentRunSpan() to lib/telemetry/spans.ts.
-- All 5 required spans now present:
--   vector_search  (withVectorSearchSpan)
--   llm_call       (withLLMSpan)
--   tool_call      (withToolSpan)
--   sse_frame      (withSSEFrameSpan)
--   agent_run      (withAgentRunSpan) ← added this week
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8B.2 — Metrics instruments
-- Finding: PASSED
-- All 7 required metrics defined in lib/telemetry/metrics.ts:
--   athene_agent_run_duration_ms         (recordAgentRunDuration)
--   athene_agent_run_error_total         (incrementAgentRunError)
--   athene_hitl_approval_pending_duration_ms (recordHitlApprovalDuration)
--   athene_hitl_decision_total           (incrementHitlDecision)
--   athene_indexer_doc_count_total       (incrementIndexedDocCount)
--   athene_indexer_duration_ms           (recordIndexingDuration)
--   athene_integration_fetch_duration_ms (recordIntegrationFetchDuration)
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8B.4 — Sensitive data in logs
-- Finding: PASSED
-- Grep for logger statements containing token/secret/access_token/
-- plaintext/api_key: 0 results in lib/ (excluding test files).
-- BYOK plaintext is passed only to HTTP provider, never logged.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 8C.1 — CI integration
-- Finding: PASSED
-- .github/workflows/ci.yml: TypeScript check + vitest run --coverage
-- .github/workflows/e2e.yml: Playwright E2E (email-approval covers HITL)
-- Security tests in tests/security/graph/ are included in vitest run
-- (not excluded in vitest.config.ts), so they run on every PR.
-- ────────────────────────────────────────────────────────────

-- No DDL executed — this migration is documentation-only.
DO $$ BEGIN END $$;
