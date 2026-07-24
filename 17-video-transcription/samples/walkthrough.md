# 5-minute demo walkthrough

1. **The mode toggle is the showpiece.** On 🔍 Search, run
   `scaling problems with lots of small services` in **keyword** mode — weak or
   empty results (the microservices episode never uses the word “scaling” in that
   sentence shape). Flip to **semantic** — the right moment from *#42 — Why we
   killed our microservices* appears. Flip to **hybrid** — it stays on top, with
   rank chips showing which leg found it (keyword —, semantic #1, plus the RRF
   score).

2. **Exact terms go the other way.** Search `pgvector` in **semantic** mode, then
   **keyword** mode. Exact identifiers are where full-text wins — this asymmetry
   is the argument for hybrid, demonstrated live in two clicks.

3. **Every result is a timestamp.** Click any result — the transcript reader opens
   scrolled to that moment, highlighted, with the matching `MM:SS` chip. If the
   episode had audio attached, the player would seek to that second (seeded
   episodes are transcript-only and say so honestly).

4. **Ingest your own.** Sign in as `producer@orbitaudio.test` → ➕ Add episode →
   paste `samples/sample-transcript.txt`. Note the response: segments → moments,
   detected format, embedding model. Then search `coffee roasting` and jump into
   your new episode.

5. **Honest mock boundary.** Still in mock mode, try the audio-upload curl from the
   README — you get a clear 400 explaining that SeekCast won't pretend to
   transcribe audio without a speech-to-text key. Failure modes are part of the
   design, not an afterthought.
