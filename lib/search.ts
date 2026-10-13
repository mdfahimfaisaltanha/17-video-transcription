import { db } from "./db"
import { activeModel, cosine, embed } from "./embeddings"
import type { SearchMode, SearchResponse, SearchResult } from "./types"

/**
 * Three search modes over moments — exposed separately ON PURPOSE.
 *
 * Most search UIs hide the retrieval strategy; SeekCast makes it a toggle so
 * you can run the same query three ways and watch the difference:
 *
 *  - keyword  — Postgres full-text (ts_rank). Nails exact words ("pgvector",
 *    "BM25", names), zero notion of synonymy.
 *  - semantic — embedding cosine. Finds "scaling problems with many small
 *    services" in an episode that never says the word "scaling".
 *  - hybrid   — both lists fused with Reciprocal Rank Fusion (k=60).
 *    Rank-based fusion, no score calibration between incomparable scales.
 *
 * Results are MOMENTS (~45s windows), so every hit carries a timestamp —
 * the search result IS a place in time, not just a document id.
 */

const TOP_K = 10
const RRF_K = 60

type MomentRow = {
  id: number
  episode_id: number
  moment_index: number
  start_sec: number
  end_sec: number
  text: string
  show: string
  title: string
}

function toResult(r: MomentRow): SearchResult {
  return {
    momentId: r.id,
    episodeId: r.episode_id,
    show: r.show,
    episodeTitle: r.title,
    startSec: Number(r.start_sec),
    endSec: Number(r.end_sec),
    text: r.text,
    keywordRank: null,
    semanticRank: null,
    vectorSim: null,
    rrfScore: null,
  }
}

async function keywordSearch(query: string): Promise<SearchResult[]> {
  const res = await db().query(
    `SELECT m.id, m.episode_id, m.moment_index, m.start_sec, m.end_sec, m.text,
            e.show, e.title,
            ts_rank(m.tsv, plainto_tsquery('english', $1)) AS rank_score
     FROM moments m JOIN episodes e ON e.id = m.episode_id
     WHERE m.tsv @@ plainto_tsquery('english', $1)
     ORDER BY rank_score DESC
     LIMIT ${TOP_K}`,
    [query],
  )
  return res.rows.map((r: MomentRow, i: number) => ({ ...toResult(r), keywordRank: i + 1 }))
}

async function semanticSearch(query: string): Promise<{ model: string; results: SearchResult[] }> {
  const model = activeModel()

  const models = await db().query(`SELECT DISTINCT embedding_model FROM moments`)
  const available = models.rows.map((r) => r.embedding_model)
  if (available.length > 0 && !available.includes(model)) {
    throw new Error(
      `Moments are embedded with [${available.join(", ")}] but the active model is "${model}". ` +
        `Re-ingest the corpus (npm run setup on a fresh DB) instead of mixing embedding spaces.`,
    )
  }

  const { vectors } = await embed([query])
  const qVec = vectors[0]
  const all = await db().query(
    `SELECT m.id, m.episode_id, m.moment_index, m.start_sec, m.end_sec, m.text, m.embedding,
            e.show, e.title
     FROM moments m JOIN episodes e ON e.id = m.episode_id
     WHERE m.embedding_model = $1`,
    [model],
  )
  const ranked = all.rows
    .map((r) => ({ row: r as MomentRow & { embedding: number[] }, sim: cosine(qVec, r.embedding) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, TOP_K)
  return {
    model,
    results: ranked.map((r, i) => ({
      ...toResult(r.row),
      semanticRank: i + 1,
      vectorSim: Math.round(r.sim * 1000) / 1000,
    })),
  }
}

export async function search(query: string, mode: SearchMode): Promise<SearchResponse> {
  const t0 = Date.now()
  let embedMs = 0
  let keywordMs = 0
  let semanticMs = 0
  let embeddingModel: string | null = null
  let results: SearchResult[] = []

  if (mode === "keyword") {
    const t = Date.now()
    results = await keywordSearch(query)
    keywordMs = Date.now() - t
  } else if (mode === "semantic") {
    const t = Date.now()
    const sem = await semanticSearch(query)
    semanticMs = Date.now() - t
    embeddingModel = sem.model
    results = sem.results
  } else {
    const tK = Date.now()
    const kw = await keywordSearch(query)
    keywordMs = Date.now() - tK
    const tS = Date.now()
    const sem = await semanticSearch(query)
    semanticMs = Date.now() - tS
    embeddingModel = sem.model

    // Reciprocal Rank Fusion
    const byId = new Map<number, SearchResult>()
    kw.forEach((r, i) => {
      byId.set(r.momentId, { ...r, rrfScore: 1 / (RRF_K + i + 1) })
    })
    sem.results.forEach((r, i) => {
      const existing = byId.get(r.momentId)
      if (existing) {
        existing.semanticRank = r.semanticRank
        existing.vectorSim = r.vectorSim
        existing.rrfScore = (existing.rrfScore ?? 0) + 1 / (RRF_K + i + 1)
      } else {
        byId.set(r.momentId, { ...r, rrfScore: 1 / (RRF_K + i + 1) })
      }
    })
    results = [...byId.values()]
      .sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0))
      .slice(0, TOP_K)
  }

  return {
    mode,
    query,
    embeddingModel,
    results,
    timings: { embedMs, keywordMs, semanticMs, totalMs: Date.now() - t0 },
  }
}
