// Idempotent DB setup + seed for SeekCast.
// Usage: node scripts/setup.mjs   (reads .env.local or environment)
//
// IMPORTANT: parseTimestampLines, buildMoments and mockEmbed below are exact
// mirrors of lib/transcript.ts and lib/embeddings.ts (scripts can't import
// TS). Seeded moments must live in the same vector space and window shape as
// anything ingested at runtime — if you change one side, change both.

import { readFileSync, existsSync } from "node:fs"
import { randomBytes, scryptSync } from "node:crypto"
import pg from "pg"

// —— env ——
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local first.")
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })

// —— mirrors of lib/auth.ts ——
function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384 })
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`
}

// —— mirror of lib/transcript.ts :: parseTimestampLines ——
function clockToSec(clock) {
  const parts = clock.replace(",", ".").split(":").map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return parts[0] * 60 + parts[1]
}
function parseTimestampLines(text) {
  const out = []
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

// —— mirror of lib/transcript.ts :: buildMoments ——
const WINDOW_MAX_CHARS = 400
const WINDOW_MAX_SEC = 45
function buildMoments(segments) {
  const moments = []
  let cur = []
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

// —— mirror of lib/embeddings.ts :: mockEmbed ——
const DIM = 256
function djb2(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0
  }
  return h
}
function mockEmbed(text) {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
  const grams = [...words]
  for (let i = 0; i < words.length - 1; i++) {
    grams.push(words[i] + "_" + words[i + 1])
  }
  const vec = new Array(DIM).fill(0)
  for (const g of grams) {
    const h = djb2(g)
    const idx = h % DIM
    const sign = (h >>> 8) & 1 ? 1 : -1
    vec[idx] += sign
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => Math.round((v / norm) * 1e6) / 1e6)
}

// —— schema ——
async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('producer', 'admin')),
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id SERIAL PRIMARY KEY,
      show TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_sec INTEGER NOT NULL,
      media_url TEXT,
      source_type TEXT NOT NULL DEFAULT 'seed' CHECK (source_type IN ('seed', 'paste', 'upload')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS segments (
      id SERIAL PRIMARY KEY,
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      seg_index INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS segments_ep_idx ON segments(episode_id, seg_index);

    CREATE TABLE IF NOT EXISTS moments (
      id SERIAL PRIMARY KEY,
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      moment_index INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      text TEXT NOT NULL,
      embedding JSONB NOT NULL,
      embedding_model TEXT NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
    );
    CREATE INDEX IF NOT EXISTS moments_tsv_idx ON moments USING GIN (tsv);
    CREATE INDEX IF NOT EXISTS moments_ep_idx ON moments(episode_id);
  `)
}

// —— seed transcripts (MM:SS lines) ——
const EPISODES = [
  {
    show: "The Build Log",
    title: "#42 — Why we killed our microservices",
    description: "Priya and Marcus on collapsing 14 services back into a modular monolith.",
    transcript: `
0:00 Welcome back to The Build Log, I'm Priya and as always I'm joined by Marcus.
0:09 Today we are finally telling the story of how we deleted thirteen of our fourteen microservices.
0:21 So set the scene, two years ago every team wanted its own service with its own database and its own deploy pipeline.
0:34 The pitch was independence, teams shipping without stepping on each other.
0:43 What we actually got was a distributed system where every product feature touched four services.
0:55 A single checkout request crossed six network boundaries before it hit the database.
1:08 Debugging meant stitching together traces from six different log streams.
1:21 And the on-call rotation was brutal, because a timeout anywhere looked like an outage everywhere.
1:34 The breaking point was a Black Friday incident where a retry storm between the cart service and the pricing service took the whole site down.
1:50 Retries multiplied the load, circuit breakers were misconfigured, and the queue backed up for forty minutes.
2:05 After the postmortem we asked the uncomfortable question, what are we actually buying with all this?
2:18 We had the operational cost of scaling problems that come with lots of small services, without the traffic to justify any of it.
2:33 So we merged everything into a modular monolith with enforced module boundaries.
2:45 One repo, one deploy, one database, modules talk through interfaces instead of HTTP.
2:57 Deploys went from forty minutes to six, and cross-feature changes became one pull request.
3:10 The lesson is not that microservices are bad, it's that they are a scaling tool, not an architecture aesthetic.
3:24 If you don't have the team count or the traffic, the network boundaries are pure overhead.
3:36 Next week we'll talk about what we kept as a separate service and why.
`,
  },
  {
    show: "The Build Log",
    title: "#43 — Postgres is all you need",
    description: "Search, queues, and vectors — how far one database can take you.",
    transcript: `
0:00 This is The Build Log episode forty three, Postgres is all you need, maybe.
0:11 We keep meeting teams running five pieces of infrastructure where one database would do.
0:23 Let's go through the greatest hits, starting with full text search.
0:32 Postgres ships ts_vector and ts_rank out of the box, with GIN indexes it handles millions of rows before you need a dedicated search engine.
0:47 You get stemming, ranking, and highlighting without operating an Elasticsearch cluster.
0:58 Second, background jobs, you do not need a message broker on day one.
1:08 A jobs table with SELECT FOR UPDATE SKIP LOCKED gives you a work queue with transactional guarantees.
1:21 If a worker dies mid-job the row lock releases and another worker picks it up, and a dead letter queue is just a failed_jobs table.
1:36 Third, and this is the fun one, vector search with pgvector.
1:46 The pgvector extension adds a vector column type, cosine distance operators, and HNSW indexes.
1:59 You can store embeddings next to your relational data and join semantic search with normal WHERE clauses.
2:13 No separate vector database, no sync pipeline keeping two systems consistent.
2:25 The pattern in all three cases is the same, your data already lives in Postgres, keeping the derived data there too removes an entire class of consistency bugs.
2:41 When do you graduate? Search at tens of millions of documents, queues at thousands of jobs a second, vectors when recall at scale actually degrades.
2:57 Measure first, migrate when the numbers say so, not when the conference talk says so.
3:09 That's the show, benchmarks and links in the show notes.
`,
  },
  {
    show: "Signal Boost",
    title: "#7 — Async by default, with Dr. Lena Osei",
    description: "A conversation about remote work culture and running fewer meetings.",
    transcript: `
0:00 Welcome to Signal Boost, conversations about how teams actually work, I'm Jordan.
0:10 My guest today is Dr. Lena Osei, who studies distributed collaboration at scale.
0:21 Lena, your headline finding is that most meetings are status theater, unpack that.
0:31 Happily. When we shadowed twelve remote teams, sixty percent of recurring meeting time was people reading updates to each other.
0:46 Updates are documents, not performances, so the fix is to write them down and make the reading asynchronous.
0:58 The teams that switched to written weekly updates cut their meeting load roughly in half.
1:11 What survives as a meeting? Decisions with real disagreement, kickoffs where trust gets built, and retros.
1:25 Anything with a fixed agenda and no live conflict becomes a document with a comment thread.
1:38 The objection I always hear is that people miss the face time, and honestly the data backs a version of that.
1:52 So keep the social time deliberately, a weekly optional coffee call with no agenda does more for cohesion than four status meetings.
2:07 The second finding is about interruptions, a ping that demands an answer within five minutes is a meeting in disguise.
2:21 Healthy async teams agree on response windows, four working hours for normal questions, and a real pager for genuine emergencies.
2:36 Nothing in between, because the in-between is where focus goes to die.
2:47 If a listener changes one thing tomorrow, what should it be?
2:55 Cancel one recurring meeting and replace it with a written update, then watch what actually breaks. Usually nothing does.
3:09 Dr. Lena Osei, thank you for coming on Signal Boost.
`,
  },
  {
    show: "Signal Boost",
    title: "#8 — The economics of open source",
    description: "Licenses, sponsorships, and why maintainers burn out.",
    transcript: `
0:00 This is Signal Boost episode eight, today we follow the money in open source.
0:11 The core puzzle: software that runs the global economy is maintained by a handful of unpaid volunteers.
0:24 Start with how maintainers get paid today, because there are more channels than people think.
0:35 GitHub Sponsors and Open Collective handle small recurring donations, and for a lucky few they add up to a salary.
0:48 Corporate sponsorship is bigger money, companies paying maintainers a retainer for the projects they depend on.
1:01 Then there are foundations, the Linux Foundation model, which pay for security audits, infrastructure, and sometimes full-time staff.
1:15 And the most reliable channel is still simply being employed to work on the project, a company hires the maintainer and donates their time.
1:29 The dark side is the pipeline problem, popularity generates issues and demands, but not income.
1:42 A maintainer with ten thousand stars gets ten thousand people's bug reports and nobody's invoice.
1:55 That gap between responsibility and reward is where burnout comes from, and why critical libraries go unmaintained.
2:09 Some projects respond with license changes, moving from MIT to licenses that restrict hosted competitors.
2:23 It's controversial, but the underlying question is fair, why should a cloud vendor monetize a project's work at scale while contributing nothing back?
2:38 The healthiest pattern we found is boring, companies auditing their dependency tree and funding the top twenty projects on it.
2:52 Treat it like infrastructure spend, because that is what it is.
3:02 If your business runs on a library maintained by one exhausted person, that is a business risk, fund it.
3:14 That's the show, all the sponsorship links we mentioned are in the notes.
`,
  },
]

async function seed() {
  const existing = await pool.query(`SELECT count(*)::int AS user_count FROM users`)
  if (existing.rows[0].user_count > 0) {
    console.log("Users already exist — skipping seed (setup is idempotent).")
    return
  }

  const password = process.env.SEED_PASSWORD || "ChangeMe123!"
  await pool.query(
    `INSERT INTO users (name, email, role, password_hash) VALUES
     ('Rafael Mendes', 'producer@orbitaudio.test', 'producer', $1),
     ('Ingrid Halvorsen', 'ops@orbitaudio.test', 'admin', $2)`,
    [hashPassword(password), hashPassword(password)],
  )

  let totalSegments = 0
  let totalMoments = 0
  for (const ep of EPISODES) {
    const segments = parseTimestampLines(ep.transcript)
    const moments = buildMoments(segments)
    const durationSec = Math.ceil(segments[segments.length - 1].end)

    const res = await pool.query(
      `INSERT INTO episodes (show, title, description, duration_sec, source_type)
       VALUES ($1, $2, $3, $4, 'seed') RETURNING id`,
      [ep.show, ep.title, ep.description, durationSec],
    )
    const epId = res.rows[0].id
    for (let i = 0; i < segments.length; i++) {
      await pool.query(
        `INSERT INTO segments (episode_id, seg_index, start_sec, end_sec, text) VALUES ($1, $2, $3, $4, $5)`,
        [epId, i, segments[i].start, segments[i].end, segments[i].text],
      )
    }
    for (const m of moments) {
      await pool.query(
        `INSERT INTO moments (episode_id, moment_index, start_sec, end_sec, text, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'mock-v1')`,
        [epId, m.index, m.start, m.end, m.text, JSON.stringify(mockEmbed(m.text))],
      )
    }
    totalSegments += segments.length
    totalMoments += moments.length
    console.log(`Seeded “${ep.title}” — ${segments.length} segments → ${moments.length} moments`)
  }

  console.log("")
  console.log(`Seeded ${EPISODES.length} episodes, ${totalSegments} segments, ${totalMoments} moments (embeddings: mock-v1).`)
  console.log("")
  console.log("Sign-in credentials:")
  console.log(`  producer@orbitaudio.test  (producer)  password: ${password}`)
  console.log(`  ops@orbitaudio.test       (admin)     password: ${password}`)
}

try {
  await createSchema()
  console.log("Schema ready.")
  await seed()
  console.log("\nDone. Start the app with: npm run dev")
} catch (e) {
  console.error("Setup failed:", e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
