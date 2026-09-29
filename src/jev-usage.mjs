// One receipt shape for every local factory TypeSafe call. The CARR cost
// guard reads this ledger alongside its own receipts and Worker daily usage.
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
const STATE_DIR = join(homedir(), ".local", "state", "software-factory")
const DEFAULT_LOG = join(STATE_DIR, "jev-calls.jsonl")
const DEFAULT_CACHE = join(STATE_DIR, "jev-cache")
const CACHE_MS = 60_000

const sha = value => createHash("sha256").update(value).digest("hex")
const encoded = value => JSON.stringify(value)

async function receipt(path, row) {
  if (!path) return
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, `${encoded(row)}\n`, { mode: 0o600 })
}

async function cached(path) {
  try {
    const row = JSON.parse(await readFile(path, "utf8"))
    return row.expires_at > Date.now() && row.model && row.answers ? row : null
  } catch { return null }
}

async function store(path, result) {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, encoded({ expires_at: Date.now() + CACHE_MS,
      model: result.model, answers: result.answers }), { mode: 0o600 })
    await rename(temp, path)
  } catch { /* Losing a cache entry must not erase a receipt. */ }
}

export async function askJev({ state, model, questions, apiKey, caller,
  fetchImpl = fetch, usageLog, cacheDir }) {
  if (!apiKey || !caller || !questions || !Object.keys(questions).length)
    throw new Error("Jev call needs key, caller and questions")
  const log = usageLog === undefined ? (fetchImpl === fetch ? DEFAULT_LOG : null) : usageLog
  const cache = cacheDir === undefined ? (fetchImpl === fetch ? DEFAULT_CACHE : null) : cacheDir
  const payload = { model, state, questions }
  const promptHash = sha(encoded(payload))
  const key = sha(encoded({ endpoint: ENDPOINT, caller, model, promptHash,
    credential: sha(apiKey) }))
  const cachePath = cache ? join(cache, `${key}.json`) : null
  const base = { ts: new Date().toISOString(),
    session: process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || null,
    caller, prompt_sha256: promptHash,
    question_ids_sha256: Object.keys(questions).sort().map(sha),
    question_kind: [...new Set(Object.values(questions).map(q => q.type))].sort().join(","),
    facets: [], model, cache_hit: false }
  if (cachePath) {
    const hit = await cached(cachePath)
    if (hit) {
      await receipt(log, { ...base, model: hit.model, usage: null, ok: false, cache_hit: true })
      return { model: hit.model, answers: hit.answers, usage: null, cache_hit: true }
    }
  }
  let logged = false
  try {
    const response = await fetchImpl(ENDPOINT, { method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: encoded(payload), signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error(`TypeSafe HTTP ${response.status ?? "error"}`)
    const result = await response.json()
    const usage = result?.usage && typeof result.usage === "object" ? result.usage : null
    const valid = result && typeof result.model === "string" && result.answers &&
      typeof result.answers === "object" && !Array.isArray(result.answers) &&
      Object.keys(result.answers).length === Object.keys(questions).length
    await receipt(log, { ...base, model: result?.model, usage, ok: Boolean(valid),
      http_status: response.status ?? 200 })
    logged = true
    if (!valid) throw new Error("TypeSafe answer shape invalid")
    if (cachePath && Number.isInteger(usage?.input_tokens) && usage.input_tokens >= 0)
      await store(cachePath, result)
    return { model: result.model, answers: result.answers, usage }
  } catch (error) {
    if (!logged) await receipt(log, { ...base, usage: null, ok: false,
      error: error instanceof Error ? error.name : "Error" })
    throw error
  }
}
