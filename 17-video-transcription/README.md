# SeekCast — Video/Podcast Transcription & Moment Search

A transcription and search platform for a fictional podcast network (**Orbit Audio**).
Every search result is a **timestamped moment**, not a document: click a result and
you land inside the transcript reader at that second, with the audio player seeking
to match.

Built with Next.js 14 (App Router), TypeScript, and PostgreSQL. Runs in **full mock
mode with zero API keys** — add `OPENAI_API_KEY` to enable real speech-to-text
(whisper-1) and real embeddings (text-embedding-3-small).

---

## Pipeline

```
            audio file ──whisper-1 (real mode only)──┐
                                                     ▼
  SRT / VTT / "MM:SS text" ──deterministic parse─► segments (start, end, text)
                                                     │
                                                     ▼  buildMoments()
                                       moments (~45s / ~400-char windows,
                                        1-segment overlap at boundaries)
                                                     │
                                     ┌─────────────┴────────────┐
                                     ▼                            ▼
                              tsvector + GIN               embedding (JSONB)
                              (keyword search)             (semantic search)
                                     └───────────┬─────────────┘
                                                 ▼
                                  hybrid = Reciprocal Rank Fusion (k=60)
                                                 ▼
                              results = { episode, MM:SS, snippet, ranks }
```

## Design

- **Moments, not segments, are the unit of search.** Raw speech segments are a few
  seconds each — too short to embed meaningfully. Whole episodes are far too long.
  `buildMoments()` merges consecutive segments into ~45-second / ~400-character
  windows with a one-segment overlap, so a sentence spoken across a boundary is
  findable from either side. The window keeps its `start_sec`, which is what makes
  every result deep-linkable in time.
- **Three search modes exposed on purpose.** Keyword (Postgres `ts_rank`) nails
  exact terms (“pgvector”, “dead letter queue”) but has zero synonymy; semantic
  (embedding cosine) finds “scaling problems with lots of small services” in an
  episode that never says “scaling”; hybrid fuses both lists with **Reciprocal Rank
  Fusion** — rank-based, because cosine similarities and `ts_rank` scores live on
  incomparable scales and averaging them is a category error. The UI mode toggle
  turns this into a live demo instead of a claim.
- **No fake transcription.** In mock mode, audio uploads are rejected with a clear
  400 pointing at the transcript-paste path (SRT / WebVTT / `MM:SS text` — all
  parsed deterministically). A mock that “transcribes” audio it cannot hear would
  be a lie; degrading to a smaller true claim beats degrading to a fake one.
- **Deterministic mock embeddings** (`mock-v1`): 256-dim hashed bag-of-words
  (unigrams + bigrams, djb2, hash-derived sign, L2-normalized). Same text → same
  vector on every machine, so search behavior is reproducible without any key.
  Every moment stores its `embedding_model`, and semantic search **refuses to mix
  embedding spaces** — cosine across models is meaningless, so it errors with a
  re-ingest instruction instead of silently returning garbage.
- **Transactional ingest.** Episode + segments + moments are inserted in one
  transaction — a failed embed call can't leave a half-indexed episode behind.

## Run it

```bash
npm install
cp .env.example .env.local     # set DATABASE_URL (Neon/Supabase free tier works)
npm run setup                  # schema + 4 seeded episodes (~70 segments) + logins
npm run dev                    # http://localhost:3000
```

Seeded sign-ins (password printed by setup, default `ChangeMe123!`):

| Email | Role | Can |
| --- | --- | --- |
| `producer@orbitaudio.test` | producer | add/delete episodes |
| `ops@orbitaudio.test` | admin | add/delete episodes |

Search is public — no sign-in needed.

### Try these (in the mode toggle)

| Query | Watch |
| --- | --- |
| `pgvector` | keyword finds it instantly; exact-term win |
| `scaling problems with lots of small services` | semantic finds the microservices episode |
| `how do maintainers get paid` | paraphrase → semantic/hybrid |
| `dead letter queue` | exact phrase, both legs agree |
| `running fewer meetings` | hybrid fuses both lists |

## Mock vs real mode

| Capability | Mock (no key) | Real (`OPENAI_API_KEY`) |
| --- | --- | --- |
| Transcript paste (SRT/VTT/lines) | ✅ deterministic parse | ✅ same |
| Audio upload → speech-to-text | ❌ honest 400 | ✅ whisper-1, timestamped segments |
| Embeddings | `mock-v1` (256-dim, deterministic) | `text-embedding-3-small` |
| Keyword search | ✅ identical | ✅ identical |

⚠️ Switching modes changes the embedding space — re-run `npm run setup` against a
fresh database (or re-ingest) rather than mixing models. The API enforces this.

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/search?q=...&mode=hybrid\|keyword\|semantic` | — | timestamped moments + per-leg ranks + timings |
| GET | `/api/episodes` | — | list episodes with moment counts |
| GET | `/api/episodes?id=3` | — | episode + raw segments (reader) |
| POST | `/api/episodes` (JSON `{show,title,description,transcript}`) | producer | ingest pasted transcript |
| POST | `/api/episodes` (multipart `{show,title,audio}`) | producer | whisper-1 transcription (real mode) |
| DELETE | `/api/episodes?id=3` | producer | delete episode + transcript data |
| GET/POST/DELETE | `/api/auth` | — | session check / sign in / sign out |

Audio upload via curl (real mode):

```bash
curl -X POST http://localhost:3000/api/episodes \
  -H "Cookie: sc_session=..." \
  -F show="The Build Log" -F title="#44 — Live show" -F audio=@episode.mp3
```

## Edge cases handled

| Case | Behavior |
| --- | --- |
| Audio upload without API key | 400 with instructions — never fake transcription |
| Audio > 25 MB | 400 (whisper-1 hard limit), also enforced in `lib/transcribe.ts` |
| Transcript with no parseable timestamps | 400 listing the three supported formats |
| Transcript > 200k chars | 400 with limit |
| Embedding model mismatch (key added/removed later) | semantic search errors with re-ingest instruction — refuses to mix vector spaces |
| Failure mid-ingest | transaction rollback — no half-indexed episodes |
| Query > 200 chars / bad mode | 400 |
| Unknown email vs wrong password | identical 401 (no account enumeration) |
| Sentence at a window boundary | 1-segment overlap makes it findable from both windows |
| Episode without audio | reader still deep-links; UI says so instead of showing a broken player |

## Scaling honestly

Vectors live in JSONB and are compared in-process — correct and honest at demo
scale (hundreds of moments). At real scale, swap to **pgvector**: change the column
to `vector(1536)`, add an HNSW index, and replace the in-process cosine loop with
`ORDER BY embedding <=> $1 LIMIT 10`. The search interface doesn't change — that
swap path is the reason embeddings live in Postgres rather than a separate store.
Keyword search already scales further via the GIN index. For diarization (who
spoke), whisper-1 doesn't provide it — `Speaker:` prefixes in pasted SRTs are
preserved as plain text, and that limitation is stated rather than papered over.

## Deploy

- **Vercel** for the Next.js app (set `DATABASE_URL`, optional `OPENAI_API_KEY`)
- **Neon** or **Supabase** for Postgres (free tier is plenty)
- Run `npm run setup` once locally against the production `DATABASE_URL`
