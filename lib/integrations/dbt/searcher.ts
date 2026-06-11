import { dbtFetch } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

export async function dbtSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  const q = query.toLowerCase()

  try {
    // dbt Cloud doesn't have a search endpoint; filter client-side from jobs list
    const jobsRes = await dbtFetch<any>(connectionId, orgId, '/jobs/')
    const jobs: any[] = jobsRes?.data ?? []
    for (const job of jobs) {
      if (
        job.name?.toLowerCase().includes(q) ||
        job.description?.toLowerCase().includes(q)
      ) {
        chunks.push({
          chunk_id: `dbt_job_${job.id}`,
          title: `dbt Job: ${job.name}`,
          content: job.description || job.name,
          source_url: `https://cloud.getdbt.com/deploy/${job.project_id}/jobs/${job.id}`,
          shape: 'bi_artifact' as const,
          metadata: { provider: 'dbt', resource_type: 'job', job_id: String(job.id) },
        })
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[dbt] Job search failed:')
  }

  try {
    const modelsRes = await dbtFetch<any>(connectionId, orgId, `/models/?search=${encodeURIComponent(query)}&limit=20`)
    const models: any[] = modelsRes?.data ?? []
    for (const model of models) {
      chunks.push({
        chunk_id: `dbt_model_${model.unique_id}`,
        title: `dbt Model: ${model.name}`,
        content: model.description || `dbt model: ${model.name}`,
        source_url: `https://cloud.getdbt.com`,
        shape: 'bi_artifact' as const,
        metadata: { provider: 'dbt', resource_type: 'model', model_name: model.name },
      })
    }
  } catch {
    // Models search endpoint varies by plan
  }

  return chunks
}
