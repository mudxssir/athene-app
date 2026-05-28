# Future Capabilities

Strategic capabilities parked for future sprints. Athene is an enterprise
intelligence platform — expand depth and integrations before expanding surface area.

---

## 1. Browser-Use Agents

**What it is.** Athene drives a real headless browser (Browserbase) to interact
with SaaS UIs that have no public API — Workday, Salesforce admin views, niche
vertical tools. Every destructive action requires HITL approval before execution.

**Status.** Full implementation designed and built (Sprint 1 + Sprint 2 complete)
but pulled back — not the right priority for an enterprise intelligence firm yet.
The code was removed cleanly; the architecture is fully documented below.

**Why it was shelved.** The core intelligence loop needs to be excellent first.
Browser-use without multimodal vision is blind — the LLM needs to see screenshots
to generate real CSS selectors. That requires wiring a vision-capable model
(Claude 3.5+) into the planning step before this is production-worthy.

**What was built.**
- `lib/browser/` — provider abstraction (Browserbase + local Playwright), session
  lifecycle with Redis cookie-context cache, domain allowlist + hard blocklist,
  blocking audit log, telemetry
- 6 LangGraph tools: `browser-navigate`, `browser-screenshot`, `browser-extract`
  (read-only); `browser-click`, `browser-type`, `browser-submit` (HITL-gated)
- `browser-agent` LangGraph node with rate limiting (50/hr) and action budget (25/thread)
- HITL modal browser branch with screenshot + selector chip + editable value field
- DB migration: `browser_sessions`, `browser_actions`, `browser_allowlist`
- Admin UI: `/admin/browser` — domain policy CRUD + active sessions
- API routes: `/api/browser/sessions`, `/api/browser/screenshot/[actionId]`,
  `/api/worker/browser-session-reaper`, `/api/admin/browser/allowlist`

**What to finish when picking this up.**
1. Pass screenshots as vision messages to a multimodal model in `browser-agent.ts`
2. Use `page.accessibility.snapshot()` as a text-model fallback
3. Set `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` in env
4. Register session-reaper as a QStash cron at `/api/worker/browser-session-reaper`
5. Apply DB migration `20260528000001_browser_use.sql`
6. Run smoke test `scripts/browser-smoke.ts` against `the-internet.herokuapp.com`

**Env vars needed.**
```
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
BROWSER_PROVIDER=browserbase        # or "local" for dev
BROWSER_DEFAULT_ACTION_BUDGET=25
BROWSER_SESSION_IDLE_MIN=30
```

**Packages already installed.** `@browserbasehq/sdk`, `playwright-core`

---

## 2. Voice + Meeting Capture

Live meeting ingestion (Zoom/Meet/Teams) into the knowledge graph plus voice Q&A.
Fireflies/Gong pattern. Recall.ai for in-meeting bot. ElevenLabs/Deepgram for voice.

**Estimate.** 2–3 sprints for transcript ingestion + voice; +1 for in-meeting bot.

---

## 3. Slack / Teams Bot

Ambient Athene in Slack/Teams DMs and channels. Reuses `/api/agent/stream`
server-side; HITL approvals via ephemeral Slack messages → existing approve endpoint.

**Estimate.** 1–2 sprints.

---

## 4. Compliance Hardening (SOC2 / SAML / SCIM)

SAML SSO via Clerk, SCIM provisioning, SOC2 Type 2 observation window, DSAR tooling,
eDiscovery legal-hold flags. Unblocks >$10K ACV enterprise deals.

**Estimate.** 2 sprints (SAML/SCIM/DSAR); ~3 months observation window for SOC2 Type 2.

---

## 5. Long-Running Autonomous Workflows

Scheduled multi-step agents ("every Monday: audit pipeline → draft outreach →
request approval"). Extends existing `automations` module + QStash + HITL.

**Estimate.** 1–2 sprints once Slack bot exists for async HITL delivery.

---

## 6. Vertical Industry Packs

Pre-configured prompt packs, doc taxonomies, and HITL templates for legal, sales,
finance, healthcare. Plugs into the existing `/api/intelligence` cards mechanism.

**Estimate.** ~1 sprint per vertical after the first.

---

## 7. Deep Research Mode

Long-horizon multi-step research with citations (Perplexity-style). Lifts the
`MAX_HOPS = 6` cap, adds per-step citations panel, optional Brave/Tavily web search.

**Estimate.** 1–2 sprints.

---

## Sequencing Recommendation

1. Compliance hardening — unblocks top-of-funnel revenue, runs in parallel
2. Slack/Teams bot — multiplies daily active usage
3. Voice + meeting capture — biggest enterprise differentiator
4. Long-running workflows — depends on Slack bot for async approvals
5. Browser-use agents — revisit after multimodal vision is wired
6. Deep research mode — additive, anytime
7. Vertical packs — GTM motion once core is excellent
