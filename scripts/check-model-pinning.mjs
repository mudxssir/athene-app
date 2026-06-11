#!/usr/bin/env node
/**
 * scripts/check-model-pinning.mjs — P1-15 CI assertion
 *
 * Asserts that no org has rows with two different embedding_model values
 * among rows where needs_embedding=false (i.e. rows that have valid embeddings
 * and are actually searchable).
 *
 * Mixed models in the same org's search index means queries return results
 * from different vector spaces — cosine similarity comparisons are meaningless
 * across spaces, degrading recall. This check catches drift before it reaches
 * production search.
 *
 * Exit 0 → all orgs have a single embedding_model in their search index.
 * Exit 1 → one or more orgs have mixed models (logs the affected orgs).
 *
 * Usage (CI):
 *   node scripts/check-model-pinning.mjs
 *
 * Env vars required:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
)

async function main() {
  console.log('[check-model-pinning] Running mixed-model assertion...')

  // Find orgs that have more than one distinct non-null embedding_model
  // among rows with needs_embedding=false (the searchable rows).
  // Uses a raw RPC or SQL query via supabase-js .rpc() isn't ideal here —
  // we'll page through distinct (org_id, embedding_model) pairs instead.
  const { data, error } = await supabase
    .from('document_embeddings')
    .select('org_id, embedding_model')
    .eq('needs_embedding', false)
    .not('embedding_model', 'is', null)
    .not('embedding', 'is', null)

  if (error) {
    console.error('[check-model-pinning] Query failed:', error.message)
    process.exit(1)
  }

  // Group by org_id and count distinct models
  const orgModels = new Map()
  for (const row of (data ?? [])) {
    if (!row.org_id || !row.embedding_model) continue
    const models = orgModels.get(row.org_id) ?? new Set()
    models.add(row.embedding_model)
    orgModels.set(row.org_id, models)
  }

  const mixedOrgs = []
  for (const [orgId, models] of orgModels) {
    if (models.size > 1) {
      mixedOrgs.push({ orgId, models: [...models] })
    }
  }

  if (mixedOrgs.length === 0) {
    console.log('[check-model-pinning] PASS — all orgs have a single embedding model in their search index.')
    process.exit(0)
  }

  console.error('[check-model-pinning] FAIL — the following orgs have mixed embedding models in their search index:')
  for (const { orgId, models } of mixedOrgs) {
    console.error(`  org_id=${orgId}  models=${models.join(', ')}`)
  }
  console.error(
    '\nAction: Run scripts/migrations/re-embed.ts --org <org_id> for each affected org, ' +
    'or check that the embed-retry worker has cleared all needs_embedding=true rows.'
  )
  process.exit(1)
}

main().catch(err => {
  console.error('[check-model-pinning] Unhandled error:', err)
  process.exit(1)
})
