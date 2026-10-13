import OpenAI from "openai"
import type { ParsedSegment } from "./transcript"

/**
 * Real speech-to-text via whisper-1 (verbose_json → timestamped segments).
 *
 * There is deliberately NO mock for this stage. A mock that "transcribes"
 * audio it cannot hear would be a lie — so in mock mode the API rejects audio
 * uploads with a clear 400 pointing at the transcript-paste path (SRT / VTT /
 * timestamped lines), which is fully supported without any key.
 * Same honesty rule as the other projects: degrade to a smaller true claim,
 * never to a fake one.
 *
 * Whisper's 25 MB limit is enforced client-side AND here; long episodes
 * should be split (or use the paste path with an externally produced SRT).
 */

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export function transcriptionAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

export async function transcribeAudio(file: File): Promise<ParsedSegment[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "Speech-to-text requires OPENAI_API_KEY. In mock mode, paste a transcript (SRT, VTT, or 'MM:SS text' lines) instead.",
    )
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error("Audio file exceeds the 25 MB whisper-1 limit — split the file or paste an SRT.")
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const res = (await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "verbose_json",
  })) as unknown as { segments?: Array<{ start: number; end: number; text: string }> }

  const segments = (res.segments ?? [])
    .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
    .filter((s) => s.text.length > 0)
  if (segments.length === 0) {
    throw new Error("Transcription returned no segments — is the file actually audio?")
  }
  return segments
}
