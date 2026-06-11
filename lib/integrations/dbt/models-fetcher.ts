import { dbtFetch } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

interface DbtModel {
  unique_id: string
  name: string
  description: string
  package_name: string
  schema: string
  alias: string | null
  tags: string[]
  depends_on: { nodes: string[] }
  meta: Record<string, unknown>
}

interface DbtJob {
  id: number
  name: string
  description: string
  project_id: number
  environment_id: number
}

interface DbtRun {
  id: number
  job_id: number
  status: string
  created_at: string
  finished_at: string | null
  run_duration_humanized: string | null
  job_definition?: { name: string }
}

export async function fetchDbtContent(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  // browseDbt returns job IDs (as strings) as resource IDs.
  // If selected, only index those jobs and their recent runs.
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const jobAllowed = (jobId: number) =>
    !selectedIds || selectedIds.size === 0 || selectedIds.has(String(jobId))

  // Fetch Jobs
  try {
    const jobsRes = await dbtFetch<any>(connectionId, orgId, '/jobs/')
    const jobs: DbtJob[] = jobsRes?.data ?? []
    for (const job of jobs) {
      if (!jobAllowed(job.id)) continue
      chunks.push({
        chunk_id: `dbt_job_${job.id}`,
        title: `dbt Job: ${job.name}`,
        content: job.description || `dbt transformation job: ${job.name}`,
        source_url: `https://cloud.getdbt.com/deploy/${job.project_id}/jobs/${job.id}`,
        shape: 'bi_artifact' as const,
        metadata: {
          provider: 'dbt',
          resource_type: 'job',
          job_id: String(job.id),
          project_id: String(job.project_id),
        },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[dbt] Failed to fetch jobs:')
  }

  // Fetch recent Runs
  try {
    const runsRes = await dbtFetch<any>(connectionId, orgId, '/runs/?limit=50&order_by=-id')
    const runs: DbtRun[] = runsRes?.data ?? []
    for (const run of runs) {
      if (!jobAllowed(run.job_id)) continue
      const duration = run.run_duration_humanized ?? 'unknown duration'
      chunks.push({
        chunk_id: `dbt_run_${run.id}`,
        title: `dbt Run #${run.id} — ${run.status}`,
        content: `Job: ${run.job_definition?.name ?? String(run.job_id)}. Status: ${run.status}. Duration: ${duration}. Started: ${run.created_at}.`,
        source_url: `https://cloud.getdbt.com/runs/${run.id}`,
        shape: 'bi_artifact' as const,
        metadata: {
          provider: 'dbt',
          resource_type: 'run',
          run_id: String(run.id),
          job_id: String(run.job_id),
          status: run.status,
        },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[dbt] Failed to fetch runs:')
  }

  // Fetch Models from Discovery API (if available)
  try {
    const modelsRes = await dbtFetch<any>(connectionId, orgId, '/models/?limit=100')
    const models: DbtModel[] = modelsRes?.data ?? []
    for (const model of models) {
      const tags = model.tags?.join(', ')
      const deps = model.depends_on?.nodes?.slice(0, 5).join(', ')
      chunks.push({
        chunk_id: `dbt_model_${model.unique_id}`,
        title: `dbt Model: ${model.name}`,
        content: [
          model.description,
          tags ? `Tags: ${tags}` : null,
          deps ? `Depends on: ${deps}` : null,
          `Schema: ${model.schema}`,
        ].filter(Boolean).join('\n'),
        source_url: `https://cloud.getdbt.com`,
        shape: 'bi_artifact' as const,
        metadata: {
          provider: 'dbt',
          resource_type: 'model',
          model_name: model.name,
          schema: model.schema,
          package_name: model.package_name,
        },
      })
    }
  } catch {
    // Models endpoint may not be available on all dbt plans
  }

  return chunks
}
