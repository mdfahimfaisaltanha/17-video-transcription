import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { buildMoments, parseTranscript, type ParsedSegment } from "@/lib/transcript"
import { embed } from "@/lib/embeddings"
import { MAX_AUDIO_BYTES, transcribeAudio, transcriptionAvailable } from "@/lib/transcribe"

export const dynamic = "force-dynamic"

const MAX_TRANSCRIPT_CHARS = 200_000

/**
 * GET  /api/episodes          → list with moment counts (public)
 * GET  /api/episodes?id=3     → one episode + raw segments (public)
 * POST JSON { show, title, description?, transcript }        (producer)
 * POST multipart FormData { show, title, description?, audio } (producer, real mode)
 * DELETE ?id=3                → remove episode + segments + moments (producer)
 */

export async function GET(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get("id")

  if (id) {
    const ep = await db().query(`SELECT * FROM episodes WHERE id = $1`, [Number(id)])
    if (!ep.rows[0]) return NextResponse.json({ error: "Episode not found" }, { status: 404 })
    const segments = await db().query(
      `SELECT id, seg_index, start_sec, end_sec, text FROM segments WHERE episode_id = $1 ORDER BY seg_index`,
      [Number(id)],
    )
    return NextResponse.json({ episode: ep.rows[0], segments: segments.rows })
  }

  const res = await db().query(
    `SELECT e.id, e.show, e.title, e.description, e.duration_sec, e.media_url, e.source_type, e.created_at,
            count(m.id)::int AS moment_count
     FROM episodes e LEFT JOIN moments m ON m.episode_id = e.id
     GROUP BY e.id ORDER BY e.id`,
  )
  return NextResponse.json({ episodes: res.rows, transcriptionAvailable: transcriptionAvailable() })
}

export async function POST(req: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Sign in to add episodes" }, { status: 401 })

  let show = ""
  let title = ""
  let description = ""
  let segments: ParsedSegment[] = []
  let sourceType: "paste" | "upload" = "paste"
  let formatNote = ""

  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("multipart/form-data")) {
    // —— audio upload path (real mode only) ——
    const form = await req.formData()
    show = String(form.get("show") ?? "").trim()
    title = String(form.get("title") ?? "").trim()
    description = String(form.get("description") ?? "").trim()
    const audio = form.get("audio")
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: "audio file is required in multipart uploads" }, { status: 400 })
    }
    if (!transcriptionAvailable()) {
      return NextResponse.json(
        {
          error:
            "Speech-to-text requires OPENAI_API_KEY. In mock mode, paste a transcript (SRT, VTT, or 'MM:SS text' lines) instead — SeekCast won't pretend to hear audio it can't transcribe.",
        },
        { status: 400 },
      )
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio exceeds the 25 MB whisper-1 limit" }, { status: 400 })
    }
    try {
      segments = await transcribeAudio(audio)
      sourceType = "upload"
      formatNote = "whisper-1"
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Transcription failed" }, { status: 502 })
    }
  } else {
    // —— transcript paste path (works in every mode) ——
    let body: { show?: string; title?: string; description?: string; transcript?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }
    show = (body.show ?? "").trim()
    title = (body.title ?? "").trim()
    description = (body.description ?? "").trim()
    const transcript = (body.transcript ?? "").trim()
    if (!transcript) return NextResponse.json({ error: "transcript is required" }, { status: 400 })
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      return NextResponse.json({ error: `Transcript too large (max ${MAX_TRANSCRIPT_CHARS.toLocaleString()} chars)` }, { status: 400 })
    }
    const parsed = parseTranscript(transcript)
    segments = parsed.segments
    formatNote = parsed.format
    if (segments.length === 0) {
      return NextResponse.json(
        {
          error:
            "No timestamped segments found. Supported formats: SRT, WebVTT, or lines like '12:34 spoken text' (MM:SS or HH:MM:SS).",
        },
        { status: 400 },
      )
    }
  }

  if (!show || !title) {
    return NextResponse.json({ error: "Both show and title are required" }, { status: 400 })
  }

  const moments = buildMoments(segments)
  const { model, vectors } = await embed(moments.map((m) => m.text))
  const durationSec = Math.ceil(segments[segments.length - 1].end)

  const client = await db().connect()
  try {
    await client.query("BEGIN")
    const ep = await client.query(
      `INSERT INTO episodes (show, title, description, duration_sec, source_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [show, title, description, durationSec, sourceType],
    )
    const epId = ep.rows[0].id
    for (let i = 0; i < segments.length; i++) {
      await client.query(
        `INSERT INTO segments (episode_id, seg_index, start_sec, end_sec, text) VALUES ($1, $2, $3, $4, $5)`,
        [epId, i, segments[i].start, segments[i].end, segments[i].text],
      )
    }
    for (let i = 0; i < moments.length; i++) {
      await client.query(
        `INSERT INTO moments (episode_id, moment_index, start_sec, end_sec, text, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [epId, moments[i].index, moments[i].start, moments[i].end, moments[i].text, JSON.stringify(vectors[i]), model],
      )
    }
    await client.query("COMMIT")
    return NextResponse.json(
      {
        episode: ep.rows[0],
        segmentCount: segments.length,
        momentCount: moments.length,
        embeddingModel: model,
        format: formatNote,
      },
      { status: 201 },
    )
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

export async function DELETE(req: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Sign in to delete episodes" }, { status: 401 })
  const url = new URL(req.url)
  const id = Number(url.searchParams.get("id"))
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id query param required" }, { status: 400 })
  const res = await db().query(`DELETE FROM episodes WHERE id = $1 RETURNING id`, [id])
  if (!res.rows[0]) return NextResponse.json({ error: "Episode not found" }, { status: 404 })
  return NextResponse.json({ ok: true, deletedId: id })
}
