export type User = {
  id: number
  name: string
  email: string
  role: "producer" | "admin"
}

export type Episode = {
  id: number
  show: string
  title: string
  description: string
  duration_sec: number
  media_url: string | null
  source_type: "seed" | "paste" | "upload"
  created_at: string
}

export type Segment = {
  id: number
  episode_id: number
  seg_index: number
  start_sec: number
  end_sec: number
  text: string
}

/**
 * A "moment" is the unit of search: a ~45-second / ~400-char window of
 * consecutive segments. Raw segments are too short to embed meaningfully
 * (a few words each); whole episodes are far too long. Moments are the
 * middle ground — and their start_sec is what makes results jumpable.
 */
export type Moment = {
  id: number
  episode_id: number
  moment_index: number
  start_sec: number
  end_sec: number
  text: string
  embedding_model: string
}

export type SearchMode = "keyword" | "semantic" | "hybrid"

export type SearchResult = {
  momentId: number
  episodeId: number
  show: string
  episodeTitle: string
  startSec: number
  endSec: number
  text: string
  /** 1-based rank in the keyword list (null if not found by keyword) */
  keywordRank: number | null
  /** 1-based rank in the semantic list (null if not found by vector) */
  semanticRank: number | null
  vectorSim: number | null
  rrfScore: number | null
}

export type SearchResponse = {
  mode: SearchMode
  query: string
  embeddingModel: string | null
  results: SearchResult[]
  timings: { embedMs: number; keywordMs: number; semanticMs: number; totalMs: number }
}
