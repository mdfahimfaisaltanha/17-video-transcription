"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { SearchMode, SearchResponse, SearchResult } from "@/lib/types"

type UserInfo = { id: number; name: string; email: string; role: string }
type EpisodeRow = {
  id: number
  show: string
  title: string
  description: string
  duration_sec: number
  media_url: string | null
  source_type: string
  moment_count: number
}
type SegmentRow = { id: number; seg_index: number; start_sec: number; end_sec: number; text: string }

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter((w) => w.length > 2))]
  if (words.length === 0) return <>{text}</>
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")
  const parts = text.split(re)
  return (
    <>
      {parts.map((p, i) =>
        re.test(p) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  )
}

const SUGGESTIONS = [
  { q: "pgvector", note: "exact term → keyword wins" },
  { q: "scaling problems with lots of small services", note: "paraphrase → semantic wins" },
  { q: "how do maintainers get paid", note: "paraphrase" },
  { q: "running fewer meetings", note: "" },
  { q: "dead letter queue", note: "exact phrase" },
]

export default function Home() {
  const [tab, setTab] = useState<"search" | "episodes" | "add">("search")
  const [user, setUser] = useState<UserInfo | null>(null)

  // search state
  const [query, setQuery] = useState("")
  const [mode, setMode] = useState<SearchMode>("hybrid")
  const [searching, setSearching] = useState(false)
  const [searchRes, setSearchRes] = useState<SearchResponse | null>(null)
  const [searchErr, setSearchErr] = useState("")

  // episodes state
  const [episodes, setEpisodes] = useState<EpisodeRow[]>([])
  const [transcriptionAvailable, setTranscriptionAvailable] = useState(false)
  const [openEp, setOpenEp] = useState<EpisodeRow | null>(null)
  const [segments, setSegments] = useState<SegmentRow[]>([])
  const [targetSec, setTargetSec] = useState<number | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  // add state
  const [form, setForm] = useState({ show: "", title: "", description: "", transcript: "" })
  const [addMsg, setAddMsg] = useState("")
  const [addErr, setAddErr] = useState("")
  const [adding, setAdding] = useState(false)

  // login state
  const [login, setLogin] = useState({ email: "", password: "" })
  const [loginErr, setLoginErr] = useState("")

  const loadEpisodes = useCallback(async () => {
    const res = await fetch("/api/episodes")
    const data = await res.json()
    setEpisodes(data.episodes ?? [])
    setTranscriptionAvailable(Boolean(data.transcriptionAvailable))
  }, [])

  useEffect(() => {
    fetch("/api/auth").then((r) => r.json()).then((d) => setUser(d.user))
    loadEpisodes()
  }, [loadEpisodes])

  async function runSearch(q?: string, m?: SearchMode) {
    const qq = (q ?? query).trim()
    const mm = m ?? mode
    if (!qq) return
    setSearching(true)
    setSearchErr("")
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(qq)}&mode=${mm}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Search failed")
      setSearchRes(data)
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : "Search failed")
      setSearchRes(null)
    } finally {
      setSearching(false)
    }
  }

  async function openEpisode(id: number, jumpTo: number | null = null) {
    const res = await fetch(`/api/episodes?id=${id}`)
    const data = await res.json()
    if (!res.ok) return
    const listRow = episodes.find((e) => e.id === id)
    setOpenEp(
      listRow ?? { ...data.episode, moment_count: 0 },
    )
    setSegments(data.segments)
    setTargetSec(jumpTo)
    setTab("episodes")
  }

  // scroll to + seek the target moment once segments render
  useEffect(() => {
    if (targetSec == null || segments.length === 0) return
    const el = readerRef.current?.querySelector("[data-hit='true']")
    if (el) el.scrollIntoView({ block: "center" })
    if (audioRef.current) {
      audioRef.current.currentTime = targetSec
      audioRef.current.play().catch(() => {})
    }
  }, [targetSec, segments])

  function openResult(r: SearchResult) {
    openEpisode(r.episodeId, r.startSec)
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault()
    setAdding(true)
    setAddErr("")
    setAddMsg("")
    try {
      const res = await fetch("/api/episodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Failed to add episode")
      setAddMsg(
        `Added “${data.episode.title}” — ${data.segmentCount} segments → ${data.momentCount} searchable moments (format: ${data.format}, embeddings: ${data.embeddingModel}).`,
      )
      setForm({ show: "", title: "", description: "", transcript: "" })
      loadEpisodes()
    } catch (err) {
      setAddErr(err instanceof Error ? err.message : "Failed to add episode")
    } finally {
      setAdding(false)
    }
  }

  async function submitLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginErr("")
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(login),
    })
    const data = await res.json()
    if (!res.ok) {
      setLoginErr(data.error ?? "Sign-in failed")
      return
    }
    setUser(data.user)
    setLogin({ email: "", password: "" })
  }

  async function signOut() {
    await fetch("/api/auth", { method: "DELETE" })
    setUser(null)
  }

  async function deleteEpisode(id: number) {
    if (!confirm("Delete this episode and all its transcript data?")) return
    await fetch(`/api/episodes?id=${id}`, { method: "DELETE" })
    setOpenEp(null)
    setSegments([])
    loadEpisodes()
  }

  return (
    <main>
      <h1>🎙️ SeekCast</h1>
      <p className="subtitle">
        Transcription &amp; moment search for Orbit Audio — every result is a timestamp, not just a document.
        {user ? (
          <>
            {" "}· signed in as {user.name}{" "}
            <button className="ghost" onClick={signOut} style={{ marginLeft: 6 }}>Sign out</button>
          </>
        ) : null}
      </p>

      <div className="tabs">
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>🔍 Search</button>
        <button className={tab === "episodes" ? "active" : ""} onClick={() => setTab("episodes")}>🎧 Episodes</button>
        <button className={tab === "add" ? "active" : ""} onClick={() => setTab("add")}>➕ Add episode</button>
      </div>

      {tab === "search" && (
        <>
          <div className="card">
            <div className="search-row">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                placeholder="Search every spoken moment…"
              />
              <button className="primary" disabled={searching} onClick={() => runSearch()}>
                {searching ? "Searching…" : "Search"}
              </button>
            </div>
            <div className="mode-toggle">
              {(["hybrid", "keyword", "semantic"] as SearchMode[]).map((m) => (
                <button
                  key={m}
                  className={mode === m ? "active" : ""}
                  onClick={() => {
                    setMode(m)
                    if (query.trim()) runSearch(undefined, m)
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.q} onClick={() => { setQuery(s.q); runSearch(s.q) }}>
                  {s.q}{s.note ? ` · ${s.note}` : ""}
                </button>
              ))}
            </div>
            {searchErr && <div className="error-box">{searchErr}</div>}
          </div>

          {searchRes && (
            <div className="card">
              <div>
                <span className="badge accent">{searchRes.mode}</span>
                {searchRes.embeddingModel && <span className="badge">{searchRes.embeddingModel}</span>}
                <span className="badge">{searchRes.results.length} moments</span>
              </div>
              <div className="timing-chips">
                {searchRes.timings.keywordMs > 0 && <span>keyword {searchRes.timings.keywordMs}ms</span>}
                {searchRes.timings.semanticMs > 0 && <span>semantic {searchRes.timings.semanticMs}ms</span>}
                <span>total {searchRes.timings.totalMs}ms</span>
              </div>
              {searchRes.results.length === 0 && (
                <p style={{ color: "var(--muted)", fontSize: 14 }}>
                  No moments matched. Try the semantic or hybrid mode for paraphrased queries.
                </p>
              )}
              {searchRes.results.map((r) => (
                <div key={`${r.momentId}`} className="result" onClick={() => openResult(r)}>
                  <div className="meta">
                    <span className="ts-chip">▶ {fmt(r.startSec)}</span>
                    {r.show} — {r.episodeTitle}
                  </div>
                  <div className="snippet">
                    <Highlighted text={r.text} query={searchRes.query} />
                  </div>
                  <div className="rank-chips">
                    <span className={`rank-chip ${r.keywordRank ? "hit" : ""}`}>
                      keyword {r.keywordRank ? `#${r.keywordRank}` : "—"}
                    </span>
                    <span className={`rank-chip ${r.semanticRank ? "hit" : ""}`}>
                      semantic {r.semanticRank ? `#${r.semanticRank}` : "—"}{r.vectorSim != null ? ` (${r.vectorSim})` : ""}
                    </span>
                    {r.rrfScore != null && <span className="rank-chip">rrf {r.rrfScore.toFixed(4)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "episodes" && !openEp && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Episodes</h2>
          {episodes.map((e) => (
            <div key={e.id} className="ep-row" onClick={() => openEpisode(e.id)}>
              <div>
                <div className="title">{e.title}</div>
                <div className="sub">{e.show} · {fmt(e.duration_sec)} · {e.moment_count} moments · {e.source_type}</div>
              </div>
              <span className="badge">open →</span>
            </div>
          ))}
        </div>
      )}

      {tab === "episodes" && openEp && (
        <div className="card">
          <button className="ghost" onClick={() => { setOpenEp(null); setTargetSec(null) }}>← All episodes</button>
          <h2>{openEp.title}</h2>
          <p className="subtitle">{openEp.show} · {fmt(openEp.duration_sec)} · {openEp.description}</p>
          {openEp.media_url ? (
            <div className="audio-bar">
              <audio ref={audioRef} controls src={openEp.media_url} />
            </div>
          ) : (
            <p className="no-audio">
              No audio attached (demo transcript) — timestamps still deep-link into the reader below.
            </p>
          )}
          <div className="reader" ref={readerRef}>
            {segments.map((s) => {
              const hit = targetSec != null && targetSec >= s.start_sec - 0.5 && targetSec < s.end_sec
              return (
                <div key={s.id} className={`seg ${hit ? "hit" : ""}`} data-hit={hit ? "true" : "false"}>
                  <span
                    className="t"
                    title="Jump audio here"
                    onClick={() => {
                      setTargetSec(s.start_sec)
                      if (audioRef.current) {
                        audioRef.current.currentTime = s.start_sec
                        audioRef.current.play().catch(() => {})
                      }
                    }}
                  >
                    {fmt(s.start_sec)}
                  </span>
                  <span>{s.text}</span>
                </div>
              )
            })}
          </div>
          {user && (
            <button className="ghost" style={{ marginTop: 12, color: "var(--bad)" }} onClick={() => deleteEpisode(openEp.id)}>
              Delete episode
            </button>
          )}
        </div>
      )}

      {tab === "add" && (
        <>
          {!user ? (
            <div className="card login-wrap">
              <h2 style={{ marginTop: 0 }}>Producer sign-in</h2>
              <p className="subtitle">Try producer@orbitaudio.test or ops@orbitaudio.test (password from setup output).</p>
              <form onSubmit={submitLogin}>
                <label>Email</label>
                <input value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
                <label>Password</label>
                <input type="password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
                <button className="primary" type="submit">Sign in</button>
                {loginErr && <div className="error-box">{loginErr}</div>}
              </form>
            </div>
          ) : (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Add an episode</h2>
              <p className="subtitle">
                Paste a transcript as SRT, WebVTT, or plain <code>MM:SS text</code> lines — parsing is deterministic, no API key needed.{" "}
                {transcriptionAvailable
                  ? "Audio upload with whisper-1 is available via the API (see README)."
                  : "Audio upload requires OPENAI_API_KEY — SeekCast won't pretend to transcribe audio it can't hear."}
              </p>
              <form onSubmit={submitAdd}>
                <label>Show</label>
                <input value={form.show} onChange={(e) => setForm({ ...form, show: e.target.value })} placeholder="The Build Log" />
                <label>Title</label>
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="#44 — Shipping on Fridays" />
                <label>Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                <label>Transcript</label>
                <textarea
                  value={form.transcript}
                  onChange={(e) => setForm({ ...form, transcript: e.target.value })}
                  placeholder={"0:00 Welcome back to the show.\n0:12 Today we're talking about deploy pipelines.\n0:31 …"}
                />
                <button className="primary" type="submit" disabled={adding}>
                  {adding ? "Ingesting…" : "Ingest transcript"}
                </button>
                {addMsg && <div className="ok-box">{addMsg}</div>}
                {addErr && <div className="error-box">{addErr}</div>}
              </form>
            </div>
          )}
        </>
      )}
    </main>
  )
}
