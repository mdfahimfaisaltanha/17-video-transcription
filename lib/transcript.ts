/**
 * Transcript parsing + moment windowing.
 *
 * Three input formats, auto-detected:
 *  1. WebVTT  ("WEBVTT" header, `00:01:02.500 --> 00:01:05.000`)
 *  2. SRT     (numeric counters, `00:01:02,500 --> 00:01:05,000`)
 *  3. Timestamp lines (`MM:SS text` or `HH:MM:SS text`) — the friendliest
 *     format for hand-written or copy-pasted transcripts. End times are
 *     inferred from the next line's start (last line gets +8s).
 *
 * Parsing is fully deterministic — this is what makes mock mode honest:
 * SeekCast never fakes speech-to-text; without an API key it asks for a
 * transcript in one of these formats instead of pretending to hear audio.
 *
 * scripts/setup.mjs mirrors parseTimestampLines + buildMoments exactly
 * (scripts can't import TS) so seeded and pasted content are identical in shape.
 */

export type ParsedSegment = {
  start: number
  end: number
  text: string
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`
}

function clockToSec(clock: string): number {
  const parts = clock.replace(",", ".").split(":").map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return parts[0] * 60 + parts[1]
}

export function parseTimestampLines(text: string): ParsedSegment[] {
  const out: Array<{ start: number; text: string }> = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const m = line.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/)
    if (m) out.push({ start: clockToSec(m[1]), text: m[2].trim() })
  }
  return out.map((s, i) => ({
    start: s.start,
    end: i + 1 < out.length ? out[i + 1].start : s.start + 8,
    text: s.text,
  }))
}

function parseCueBlocks(text: string): ParsedSegment[] {
  const out: ParsedSegment[] = []
  const re = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})([^]*?)(?=\n\s*\n|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[3]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\d+$/.test(l))
      .join(" ")
    if (body) out.push({ start: clockToSec(m[1]), end: clockToSec(m[2]), text: body })
  }
  return out
}

export function parseTranscript(text: string): { format: "vtt" | "srt" | "lines"; segments: ParsedSegment[] } {
  const trimmed = text.trim()
  if (/^WEBVTT/i.test(trimmed)) return { format: "vtt", segments: parseCueBlocks(trimmed) }
  if (trimmed.includes("-->")) return { format: "srt", segments: parseCueBlocks(trimmed) }
  return { format: "lines", segments: parseTimestampLines(trimmed) }
}

// —— moment windowing ——

export type MomentWindow = {
  index: number
  start: number
  end: number
  text: string
}

const WINDOW_MAX_CHARS = 400
const WINDOW_MAX_SEC = 45

/**
 * Merge consecutive segments into search windows (~45s / ~400 chars), with a
 * one-segment overlap between windows so sentences spoken at a boundary are
 * findable from either side.
 */
export function buildMoments(segments: ParsedSegment[]): MomentWindow[] {
  const moments: MomentWindow[] = []
  let cur: ParsedSegment[] = []

  function emit() {
    if (cur.length === 0) return
    moments.push({
      index: moments.length,
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map((s) => s.text).join(" "),
    })
  }

  for (const seg of segments) {
    const curChars = cur.reduce((n, s) => n + s.text.length + 1, 0)
    const curDur = cur.length > 0 ? seg.end - cur[0].start : 0
    if (cur.length > 0 && (curChars + seg.text.length > WINDOW_MAX_CHARS || curDur > WINDOW_MAX_SEC)) {
      const overlap = cur[cur.length - 1]
      emit()
      cur = [overlap]
    }
    cur.push(seg)
  }
  emit()
  return moments
}
