// ============================================================
// scripts/eval/generate-fixtures.ts — deterministic per-shape eval corpora (P0-8)
//
// Synthesizes pilot-org-shaped documents + queries per data shape with
// relevance labels that are CORRECT BY CONSTRUCTION: each query is built
// from a unique fact that appears in exactly one document, while all
// documents share domain vocabulary (so retrieval is non-trivial).
//
// Fully deterministic (seeded PRNG, no LLM, no network) — two runs produce
// byte-identical fixtures, which is what makes baseline comparisons across
// pipeline versions meaningful.
//
// Usage: npx tsx scripts/eval/generate-fixtures.ts
// ============================================================

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260611)
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]

// ── Shared vocabulary (distractor surface) ──────────────────────────────────
const PROJECTS = [
  'Heliotrope', 'Basalt', 'Quillon', 'Meridian', 'Larkspur', 'Vermilion',
  'Cobble', 'Nimbus', 'Tessera', 'Falcata', 'Oxbow', 'Pradel',
]
const PEOPLE = [
  'Dana Okafor', 'Marcus Lindqvist', 'Priya Raman', 'Felix Duarte',
  'Yuki Tanabe', 'Sofia Brandt', 'Omar Haddad', 'Lena Kowalczyk',
  'Ravi Menon', 'Clara Westbrook', 'Jonas Pieterse', 'Mei-Ling Chau',
]
const SERVICES = [
  'billing-service', 'auth-gateway', 'ingest-pipeline', 'report-engine',
  'notification-hub', 'search-indexer', 'ledger-core', 'webhook-relay',
]
const REGIONS = ['EMEA', 'APAC', 'LATAM', 'NA-East', 'NA-West']
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4']

type Doc = { id: string; title: string; content: string }
type Query = { id: string; query: string; relevant_doc_ids: string[] }
type Fixture = { shape: string; provider: string; documents: Doc[]; queries: Query[] }

/** Unique fact = (project, person, service, number) tuple that exists in exactly one doc. */
interface Fact {
  project: string
  person: string
  service: string
  amountK: number
  region: string
  quarter: string
}

// F-B fix: dedupe on every pair referenced by a query template so that
// relevance labels remain correct by construction.  Three pair sets cover
// all query key combinations:
//   (project, service)  — prose-q-a/b, wi-q-b, thread-q-a/b
//   (project, region)   — email-q-a/b
//   (project, quarter)  — tab-q-a/b
// (service, region) was also in wi-q-a; that query was changed to key on
// (project, service) instead, which is covered by the first set.
function makeFacts(n: number): Fact[] {
  const facts: Fact[] = []
  const usedPS = new Set<string>()   // (project, service)
  const usedPR = new Set<string>()   // (project, region)
  const usedPQ = new Set<string>()   // (project, quarter)
  while (facts.length < n) {
    const f: Fact = {
      project: pick(PROJECTS),
      person: pick(PEOPLE),
      service: pick(SERVICES),
      amountK: 50 + Math.floor(rand() * 900),
      region: pick(REGIONS),
      quarter: pick(QUARTERS),
    }
    const ps = `${f.project}:${f.service}`
    const pr = `${f.project}:${f.region}`
    const pq = `${f.project}:${f.quarter}`
    if (usedPS.has(ps) || usedPR.has(pr) || usedPQ.has(pq)) continue
    usedPS.add(ps); usedPR.add(pr); usedPQ.add(pq)
    facts.push(f)
  }
  return facts
}

const filler = (f: Fact) =>
  pick([
    `The team reviewed open action items and agreed to follow up next week.`,
    `General discussion covered hiring plans and the upcoming offsite agenda.`,
    `Routine status: deployments are green and the on-call week was quiet.`,
    `${pick(SERVICES)} dashboards were reviewed; no anomalies were flagged.`,
    `Notes also touched on documentation cleanup across ${pick(REGIONS)} teams.`,
  ])

// ── Shape builders ──────────────────────────────────────────────────────────

function buildProse(): Fixture {
  const facts = makeFacts(30)
  const documents = facts.map((f, i) => ({
    id: `prose-${String(i + 1).padStart(3, '0')}`,
    title: `Project ${f.project} — planning notes`,
    content: [
      `# Project ${f.project} planning notes`,
      ``,
      `## Decisions`,
      `We decided that ${f.person} will lead the ${f.service} migration for Project ${f.project}.`,
      `The approved budget for this workstream is $${f.amountK}K, targeting ${f.quarter} delivery in ${f.region}.`,
      ``,
      `## Context`,
      filler(f),
      filler(f),
      `Alternatives considered included deferring to next quarter and outsourcing the work.`,
      ``,
      `## Risks`,
      `If the ${f.service} cutover slips, downstream reporting in ${f.region} is affected.`,
      filler(f),
    ].join('\n'),
  }))
  const queries: Query[] = []
  facts.forEach((f, i) => {
    const docId = documents[i].id
    queries.push(
      { id: `prose-q-${i}a`, query: `who is leading the ${f.service} migration for project ${f.project}?`, relevant_doc_ids: [docId] },
      { id: `prose-q-${i}b`, query: `what is the approved budget for ${f.project}'s ${f.service} workstream?`, relevant_doc_ids: [docId] },
    )
  })
  return { shape: 'prose', provider: 'notion', documents, queries: queries.slice(0, 55) }
}

function buildEmail(): Fixture {
  const facts = makeFacts(30)
  const documents = facts.map((f, i) => ({
    id: `email-${String(i + 1).padStart(3, '0')}`,
    title: `Re: ${f.project} ${f.quarter} sign-off`,
    content: [
      `From: ${f.person} <${f.person.split(' ')[0].toLowerCase()}@acme.test>`,
      `Subject: Re: ${f.project} ${f.quarter} sign-off`,
      `Date: 2026-0${1 + (i % 9)}-1${i % 9}`,
      ``,
      `Hi team,`,
      ``,
      `Confirming that the ${f.project} contract renewal for ${f.region} was signed off at $${f.amountK}K.`,
      `${f.person} will own the follow-up with the ${f.service} owners before ${f.quarter} close.`,
      ``,
      filler(f),
      ``,
      `Thanks,`,
      f.person.split(' ')[0],
    ].join('\n'),
  }))
  const queries: Query[] = []
  facts.forEach((f, i) => {
    const docId = documents[i].id
    queries.push(
      { id: `email-q-${i}a`, query: `what amount was the ${f.project} renewal for ${f.region} signed off at?`, relevant_doc_ids: [docId] },
      { id: `email-q-${i}b`, query: `who owns the follow-up for the ${f.project} renewal in ${f.region}?`, relevant_doc_ids: [docId] },
    )
  })
  return { shape: 'email', provider: 'google', documents, queries: queries.slice(0, 55) }
}

function buildWorkItem(): Fixture {
  const facts = makeFacts(30)
  const documents = facts.map((f, i) => ({
    id: `ticket-${String(i + 1).padStart(3, '0')}`,
    title: `[${f.project.slice(0, 4).toUpperCase()}-${100 + i}] ${f.service} latency regression in ${f.region}`,
    content: [
      `Summary: ${f.service} latency regression in ${f.region}`,
      `Status: In Progress`,
      `Assignee: ${f.person}`,
      `Priority: High`,
      ``,
      `p99 latency on ${f.service} rose to ${f.amountK}ms after the ${f.quarter} deploy for Project ${f.project}.`,
      `This blocks the ${f.project} rollout until the regression is resolved.`,
      ``,
      `Comments:`,
      `${f.person}: bisected to the connection-pool change; preparing a fix.`,
      `---`,
      `${pick(PEOPLE)}: ${filler(f)}`,
    ].join('\n'),
  }))
  const queries: Query[] = []
  facts.forEach((f, i) => {
    const docId = documents[i].id
    queries.push(
      { id: `wi-q-${i}a`, query: `who is assigned to the ${f.service} latency issue blocking ${f.project}?`, relevant_doc_ids: [docId] },
      { id: `wi-q-${i}b`, query: `what is blocking the ${f.project} ${f.service} rollout?`, relevant_doc_ids: [docId] },
    )
  })
  return { shape: 'work_item', provider: 'jira', documents, queries: queries.slice(0, 55) }
}

function buildThread(): Fixture {
  const facts = makeFacts(30)
  const documents = facts.map((f, i) => {
    const other = pick(PEOPLE)
    return {
      id: `thread-${String(i + 1).padStart(3, '0')}`,
      title: `#proj-${f.project.toLowerCase()}: deploy question`,
      content: [
        `can we ship the ${f.service} change for ${f.project} this week?`,
        ``,
        `Thread replies:`,
        ` → ${f.person} said we're waiting on the ${f.region} compliance review before shipping.`,
        ` → the review is expected to clear by ${f.quarter}, budget impact is around $${f.amountK}K.`,
        ` → ${other}: ${filler(f)}`,
      ].join('\n'),
    }
  })
  const queries: Query[] = []
  facts.forEach((f, i) => {
    const docId = documents[i].id
    queries.push(
      { id: `thread-q-${i}a`, query: `why is the ${f.service} change for ${f.project} not shipped yet?`, relevant_doc_ids: [docId] },
      { id: `thread-q-${i}b`, query: `what is ${f.project} waiting on before shipping ${f.service}?`, relevant_doc_ids: [docId] },
    )
  })
  return { shape: 'thread', provider: 'slack', documents, queries: queries.slice(0, 55) }
}

function buildTabular(): Fixture {
  const facts = makeFacts(30)
  const documents = facts.map((f, i) => {
    const table = `ANALYTICS.SALES.${f.project.toUpperCase()}_${f.quarter}_REVENUE`
    return {
      id: `table-${String(i + 1).padStart(3, '0')}`,
      title: `SNOWFLAKE: ${table} — Schema & Statistics`,
      content: [
        `Table: ${table} (${f.amountK * 10} rows)`,
        `Columns:`,
        `  region               varchar — 5 distinct values: ${f.region} (${f.amountK}), ${pick(REGIONS)} (${Math.floor(f.amountK / 2)})`,
        `  revenue_usd          number — range: 1000–${f.amountK * 1000}, avg: ${f.amountK * 37}, total: ${f.amountK * 9000}`,
        `  account_owner        varchar — top values: ${f.person} (${Math.floor(f.amountK / 3)})`,
        `  close_date           date — range: 2026-01-02 to 2026-0${1 + (i % 9)}-28`,
        ``,
        `${table} — Pre-computed Aggregations`,
        `sum(revenue_usd) by region: ${f.region}: ${f.amountK * 5000}, ${pick(REGIONS)}: ${Math.floor(f.amountK * 1700)}`,
      ].join('\n'),
    }
  })
  const queries: Query[] = []
  facts.forEach((f, i) => {
    const docId = documents[i].id
    queries.push(
      { id: `tab-q-${i}a`, query: `total revenue by region for ${f.project} ${f.quarter}`, relevant_doc_ids: [docId] },
      { id: `tab-q-${i}b`, query: `which table tracks ${f.project} ${f.quarter} revenue and who is the top account owner?`, relevant_doc_ids: [docId] },
    )
  })
  return { shape: 'tabular', provider: 'snowflake', documents, queries: queries.slice(0, 55) }
}

// ── Long-document paragraphs (F-A: multi-chunk retrieval tier) ──────────────

const LONG_PARAS = [
  `The project governance framework requires weekly status updates from each workstream lead. These are compiled into a master dashboard reviewed by the executive sponsor every Monday. Key metrics tracked include velocity, budget burn rate, and risk exposure across all active streams.`,
  `Resource allocation decisions have been documented and reviewed against headcount constraints across all participating departments. Contractors have been onboarded to support delivery timelines, with onboarding completed during the first week of the quarter. Their work is tracked under the same sprint cadence as permanent staff.`,
  `The communications plan includes fortnightly updates to all stakeholders, a monthly board summary, and ad-hoc briefings triggered by significant changes to scope or schedule. All materials are archived in the project repository and versioned for audit purposes.`,
  `Integration dependencies have been catalogued in the dependency register maintained by the technical programme manager. Upstream systems requiring changes have been identified and coordination meetings are scheduled bi-weekly with those owning teams.`,
  `The change management approach emphasises early engagement with end users and a structured training programme aligned to each regional rollout phase. Pilot groups have been identified across the affected sites, and feedback from pilots will inform the final rollout sequencing.`,
  `Procurement activities are progressing with vendor contracts finalised and one pending final legal review. Vendor performance is assessed quarterly against agreed service levels. No material risks have emerged from vendor relationships to date and the procurement register is current.`,
  `Documentation standards require all design decisions to be recorded in the architecture decision register before sign-off. Peer reviews of technical documents are completed by a senior engineer not involved in authoring. The technical writing team is supporting knowledge transfer to the operations group ahead of go-live.`,
  `Testing strategy covers unit, integration, system, and acceptance testing phases. Acceptance testing will involve end users from three regional sites to ensure the solution meets business requirements. Entry and exit criteria for each phase have been reviewed and approved by the quality assurance lead.`,
]

// F-A fix: long-document tier to make the eval sensitive to chunking changes.
// Each document is ~5 000 chars (≈ 1 200 tokens for the notion / prose chunker
// at chunkSize=512), producing 2–3 chunks.  The unique fact is buried at roughly
// the 2 400-char mark so it lands in chunk 2 rather than chunk 1 — the harness
// will fail if chunking drops or misaligns the middle chunk.
function buildProseLong(): Fixture {
  const facts = makeFacts(10)
  const documents = facts.map((f, i) => ({
    id: `prose-long-${String(i + 1).padStart(3, '0')}`,
    title: `Project ${f.project} — ${f.quarter} Operations Report`,
    content: [
      `# Project ${f.project} — ${f.quarter} Operations Report`,
      ``,
      `## Executive Summary`,
      LONG_PARAS[i % LONG_PARAS.length],
      filler(f), filler(f),
      ``,
      `## Background and Objectives`,
      LONG_PARAS[(i + 1) % LONG_PARAS.length],
      LONG_PARAS[(i + 2) % LONG_PARAS.length],
      filler(f),
      `The ${pick(SERVICES)} team contributed to initial planning stages for this initiative.`,
      ``,
      `## Team Responsibilities`,
      `${pick(PEOPLE)} manages the infrastructure workstream for this project.`,
      `${pick(PEOPLE)} handles stakeholder coordination across ${pick(REGIONS)} and ${pick(REGIONS)}.`,
      LONG_PARAS[(i + 3) % LONG_PARAS.length],
      filler(f), filler(f),
      ``,
      `## Delivery Progress`,
      LONG_PARAS[(i + 4) % LONG_PARAS.length],
      LONG_PARAS[(i + 5) % LONG_PARAS.length],
      filler(f), filler(f), filler(f),
      `No escalations were required during the reporting period and all milestones remain on track.`,
      ``,
      `## Resource and Budget Decisions`,
      `Following capacity review and workload assessment across ${f.region}, the ${pick(SERVICES)} and ${f.service} workstreams were re-prioritised.`,
      `${f.person} will lead the ${f.service} migration for Project ${f.project}.`,
      `The approved budget for this workstream is $${f.amountK}K, targeting ${f.quarter} delivery in ${f.region}.`,
      `This decision was ratified by the programme board after reviewing all available vendor options.`,
      ``,
      `## Risk Register`,
      LONG_PARAS[(i + 6) % LONG_PARAS.length],
      filler(f),
      `If the ${pick(SERVICES)} cutover slips, downstream reporting in ${pick(REGIONS)} may be affected.`,
      filler(f),
      ``,
      `## Next Steps`,
      LONG_PARAS[(i + 7) % LONG_PARAS.length],
      filler(f), filler(f),
      `All workstream leads to confirm capacity for the upcoming sprint before end of week.`,
    ].join('\n'),
  }))
  const queries: Query[] = []
  facts.forEach((f, i) => {
    const docId = documents[i].id
    queries.push(
      { id: `prose-long-q-${i}a`, query: `who is leading the ${f.service} migration for project ${f.project}?`, relevant_doc_ids: [docId] },
      { id: `prose-long-q-${i}b`, query: `what is the approved budget for ${f.project}'s ${f.service} workstream?`, relevant_doc_ids: [docId] },
    )
  })
  return { shape: 'prose_long', provider: 'notion', documents, queries }
}

// ── Main ────────────────────────────────────────────────────────────────────

const OUT_DIR = join(import.meta.dirname ?? __dirname, 'fixtures')
mkdirSync(OUT_DIR, { recursive: true })

const fixtures = [buildProse(), buildEmail(), buildWorkItem(), buildThread(), buildTabular(), buildProseLong()]
for (const f of fixtures) {
  const path = join(OUT_DIR, `${f.shape}.json`)
  writeFileSync(path, JSON.stringify(f, null, 2) + '\n')
  console.log(`${f.shape}: ${f.documents.length} docs, ${f.queries.length} queries → ${path}`)
}
