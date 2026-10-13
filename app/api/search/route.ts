import { NextResponse } from "next/server"
import { search } from "@/lib/search"
import type { SearchMode } from "@/lib/types"

export const dynamic = "force-dynamic"

const MODES: SearchMode[] = ["keyword", "semantic", "hybrid"]
const MAX_QUERY_CHARS = 200

/**
 * GET /api/search?q=...&mode=hybrid|keyword|semantic
 * → timestamped moments across all episodes, with per-leg ranks + timings.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = (url.searchParams.get("q") ?? "").trim()
  const modeParam = url.searchParams.get("mode") ?? "hybrid"

  if (!q) return NextResponse.json({ error: "q query param is required" }, { status: 400 })
  if (q.length > MAX_QUERY_CHARS) {
    return NextResponse.json({ error: `Query too long (max ${MAX_QUERY_CHARS} chars)` }, { status: 400 })
  }
  if (!MODES.includes(modeParam as SearchMode)) {
    return NextResponse.json({ error: `mode must be one of: ${MODES.join(", ")}` }, { status: 400 })
  }

  try {
    const result = await search(q, modeParam as SearchMode)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Search failed" }, { status: 500 })
  }
}
