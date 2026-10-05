import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const roots = []
test.after(() => {for (const root of roots) fs.rmSync(root,{recursive:true,force:true})})
import assert from "node:assert/strict"
import { createGithubProvider, latestTrustedReview } from "../src/github-snapshot.mjs"

const repo = "jbookout/software-factory", head = "a".repeat(40), base = "b".repeat(40)
const comment = (id, verdict = "APPROVE", sha = head, login = "reviewer") => ({ id, body: `${verdict}\nReviewed-SHA: ${sha}`,
  user: { login }, created_at: new Date(id * 1000).toISOString(), updated_at: new Date(id * 1000).toISOString() })
function fixture({ comments = [], fault, move, runs, link, liveBase = base } = {}) {
  const calls = [], cfg = { requiredChecks: [{ name: "test", appId: 15368 }], trustedReviewers: ["reviewer"], checkout: "/synthetic/factory" }
  let views = 0, refs = 0
  const command = async (argv, cwd) => {
    assert.equal(cwd, cfg.checkout); assert.equal(argv[0], "gh"); assert.equal(argv[1], "api")
    calls.push(argv); await Promise.resolve()
    const route = argv[2], url = new URL("https://api.github.com/" + route)
    const page = Number(url.searchParams.get("page") ?? 1)
    let value, headers = ""
    if (/pulls\/\d+$/.test(url.pathname)) {
      views++
      value = { number: Number(url.pathname.split("/").at(-1)), title: "Synthetic", state: "open", merged: false, draft: false,
        head: { sha: move === "head" && views % 2 === 0 ? base : head, ref: "topic", repo: { full_name: repo } },
        base: { sha: move === "base" && views % 2 === 0 ? head : base, ref: "main", repo: { full_name: repo } },
        comments: comments.length, mergeable: true, mergeable_state: "clean" }
    } else if (url.pathname.includes("/git/ref/heads/")) {
      refs++
      value = { ref: "refs/heads/main", object: { type: "commit", sha: move === "live-base" && refs % 2 === 0 ? head : liveBase } }
    } else if (url.pathname.endsWith("/comments")) {
      value = comments.slice((page - 1) * 25, page * 25)
      if (fault === "missing-page" && page === 2) value = []
      if (fault === "duplicate-page" && page === 2) value = comments.slice(0, 1)
      if (fault === "comment-error") return { stdout: "HTTP/2.0 401 Refused\n\n{\"token\":\"secret-canary\"}", code: 1 }
      if (link && page === 1) headers = `Link: <${link}>; rel="next"\n`
    } else if (url.pathname.endsWith("/check-runs")) {
      const checkRuns = runs ?? [{ id: 1, name: "test", head_sha: head, app: { id: 15368 }, status: "completed", conclusion: "success" }]
      value = { total_count: checkRuns.length, check_runs: checkRuns }
    } else if (url.pathname.endsWith("/statuses")) value = []
    else throw new Error("unexpected route")
    if (fault === "body-error") return { stdout: 'HTTP/2.0 500 Failed\n\n{"head":{"sha":"fatal-canary"}}', code: 1 }
    return { code: 0, stdout: `HTTP/2.0 200 OK\n${headers}\n${JSON.stringify(value)}` }
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(),"snapshot-")); roots.push(stateDir)
  const provider = createGithubProvider({ stateDir, pollMs:5, github:{cacheMs:0}, retryMs: 0, commandTimeoutMs: 100 }, { command,
    getRepo: r => { assert.equal(r, repo); return cfg }, authenticate: async () => true })
  return { provider, calls, cfg }
}

test("50 observations share one immutable snapshot per PR across concurrent readers", async () => {
  const f = fixture()
  const ids = new Set()
  for (let pr = 1; pr <= 50; pr++) {
    const values = await Promise.all(Array.from({ length: 4 }, () => f.provider.snapshot(repo, pr)))
    assert.equal(values[0].state, "known"); assert.equal(values[0].metrics.providerCalls, 7)
    assert.ok(values.every(v => v === values[0])); assert.ok(Object.isFrozen(values[0].inventory.checkRuns))
    ids.add(values[0].observationId)
  }
  assert.equal(f.calls.length, 350, "seven REST reads per observation, not per consumer")
  assert.equal(ids.size, 50)
  const later = await f.provider.snapshot(repo, 50)
  assert.ok(!ids.has(later.observationId))
  assert.equal(f.calls.length, 357, "later observation reads mutable inputs again")
})
for (const fault of ["missing-page", "duplicate-page", "comment-error", "body-error"]) test(`${fault} remains unknown and no failed body becomes source`, async () => {
  const f = fixture({ comments: Array.from({ length: 26 }, (_, i) => comment(i + 1)), fault })
  const value = await f.provider.snapshot(repo, 7)
  assert.equal(value.state, "unknown"); assert.equal(value.ci.state, "provider-unknown"); assert.equal(value.review, null)
  assert.equal(value.head, undefined); assert.ok(value.errors.length)
  assert.ok(!JSON.stringify(value).includes("canary"))
  assert.ok(f.calls.every(argv => argv[0] === "gh" && !argv.join(" ").includes("fatal-canary")))
})
for (const move of ["head", "base"]) test(`changed ${move} invalidates observation and records stale-action count`, async () => {
  const value = await fixture({ move }).provider.snapshot(repo, 7)
  assert.equal(value.state, "unknown"); assert.equal(value.metrics.staleActions, 1)
})
test("limit+1 comments and out-of-order verdicts use the latest trusted timestamp", async () => {
  const comments = Array.from({ length: 26 }, (_, i) => comment(i + 1)); comments[5] = comment(40, "BLOCK")
  const f = fixture({ comments }); const value = await f.provider.snapshot(repo, 7)
  assert.equal(value.state, "known"); assert.equal(value.inventory.comments.length, 26)
  assert.equal(value.review.verdict, "BLOCK"); assert.equal(value.metrics.providerCalls, 8)
})
for (const body of [`APPROVE\nReviewed-SHA: ${head.slice(0,7)}`, `APPROVE\nReviewed-SHA: ${head}`]) test("invalid latest trusted approval cannot revive older approval", async () => {
  const comments = [{ ...comment(1), body: comment(1).body + "\nFactory-Review: older" }, { ...comment(2), body }]
  const latest = await latestTrustedReview(comments, ["reviewer"], async candidate => candidate.body === comments[0].body)
  assert.equal(latest, null)
})
test("trusted BLOCK needs no approval receipt; outsider cannot override it", async () => {
  const latest = await latestTrustedReview([comment(1), comment(2,"BLOCK"), comment(3,"APPROVE",head,"outsider")], ["reviewer"], async () => true)
  assert.equal(latest.verdict,"BLOCK")
})
test("editing an older approval cannot leapfrog a newer blocking verdict", async () => {
  const approval = { ...comment(1), updated_at: new Date(50_000).toISOString() }
  const latest = await latestTrustedReview([comment(2,"BLOCK"), approval], ["reviewer"], async () => true)
  assert.equal(latest.verdict,"BLOCK")
})
for (const link of ["https://evil.invalid/comments?page=2&per_page=25", `https://api.github.com/repos/${repo}/issues/7/comments?page=3&per_page=25`])
 test("invalid pagination link refuses before following it", async () => {
  const f = fixture({ comments: [comment(1)], link }); const value = await f.provider.snapshot(repo, 7)
  assert.equal(value.state, "unknown"); assert.equal(f.calls.length, 3)
 })
test("current missing/cancelled/malformed checks are never green", async () => {
 for(const runs of [[], [{id:1,name:"test",head_sha:head,app:{id:15368},status:"completed",conclusion:"cancelled"}], [{}]]) {
  const value = await fixture({runs}).provider.snapshot(repo,7)
  assert.notEqual(value.ci.state,"success"); assert.equal(value.review,null)
 }
})
test("scan refuses unapproved candidates without spending provider calls on checks", async () => {
  const f = fixture({ comments: [comment(1,"BLOCK")] })
  const value = await f.provider.snapshot(repo,7,{ requireApproval: true })
  assert.equal(value.state,"refused"); assert.equal(value.review.verdict,"BLOCK")
  assert.equal(value.ci.state,"unobserved"); assert.equal(value.inventory.checkRuns,null)
  assert.equal(f.calls.length,5)
  const complete = await f.provider.snapshot(repo,7)
  assert.equal(complete.state,"known"); assert.equal(complete.ci.state,"success")
  assert.equal(f.calls.length,12,"partial scan never substitutes for full observation")
})

for (const body of [`Reviewed-SHA: ${head}`, `REVIEW: BLOCKED \nReviewed-SHA: ${head}\n1. unresolved`, ` APPROVE\nReviewed-SHA: ${head}`])
 test("malformed attempted review invalidates an authenticated older approval", async () => {
  const older = comment(1), newer = { ...comment(2), body }
  assert.equal((await latestTrustedReview([older], ["reviewer"], async c => c.body === older.body)).verdict, "APPROVE")
  assert.equal(await latestTrustedReview([older, newer], ["reviewer"], async c => c.body === older.body), null)
 })
test("ordinary trusted notes preserve authenticated approval", async () => {
 const older = comment(1), note = { ...comment(2), body: "Thanks; the next review will follow." }
 assert.equal((await latestTrustedReview([older, note], ["reviewer"], async c => c.body === older.body)).verdict, "APPROVE")
})
test("snapshot base is live target ref rather than recorded PR base", async () => {
 const value = await fixture({ liveBase: head }).provider.snapshot(repo, 7)
 assert.equal(value.state, "known"); assert.equal(value.base.sha, head); assert.equal(value.baseRefOid, head)
})
test("live target movement invalidates an unchanged PR envelope", async () => {
 const value = await fixture({ move: "live-base" }).provider.snapshot(repo, 7)
 assert.equal(value.state, "unknown"); assert.equal(value.metrics.staleActions, 1)
})

test('owner snapshot retains successful same-endpoint probes for worker diagnostics',async()=>{
 const value=await fixture().provider.snapshot(repo,7)
 assert.equal(value.availability.availability,'reachable')
 assert.equal(value.availability.probes.length,2)
 assert.ok(value.availability.probes.every(p=>p.client==='gh' && p.route===`repos/${repo}/pulls/7` && p.ok))
})
test('TLS observation preserves its probe and leaves service availability unproven',async()=>{
 const stateDir = fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-')); roots.push(stateDir)
 const provider=createGithubProvider({stateDir,pollMs:5,retryMs:0,commandTimeoutMs:100},{getRepo:()=>({checkout:'/synthetic/factory',requiredChecks:[],trustedReviewers:[]}),authenticate:async()=>true,
  command:async()=>({code:1,stdout:'',stderr:'tls: failed to verify certificate: x509: OSStatus -26276'})})
 const value=await provider.snapshot(repo,7)
 assert.equal(value.state,'unknown');assert.equal(value.availability.availability,'unproven')
 assert.equal(value.errors[0].probe.kind,'tls');assert.equal(value.errors[0].probe.route,`repos/${repo}/pulls/7`)
})
for (const failure of ["quota", "before launch", "after launch", "reported uncertainty"])
 test(`PR46 finding 7: mutation dispatch evidence survives ${failure}`, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(),"snapshot-")); roots.push(stateDir)
  const config = { stateDir, commandTimeoutMs:100, pollMs:5, github:{requestsPerHour:failure === "quota" ? 1 : 20} }
  if (failure === "quota") fs.writeFileSync(path.join(stateDir,"github.json"),JSON.stringify({
    schema:'factory-github/v1',requests:[{at:Date.now(),pool:'rest',mutation:false}],cache:{},failures:{}
  }))
  let calls = 0
  const provider = createGithubProvider(config, { getRepo: () => ({checkout:"/synthetic/factory"}), command: async (argv, cwd, options) => {
    calls++
    if (failure === "after launch") await options.onSpawn({},undefined)
    const error = new Error('synthetic transport stop')
    if (failure === "reported uncertainty") error.uncertain = true
    throw error
  } })
  await assert.rejects(provider.mutate(repo,"PUT","pulls/7/update-branch",{expected_head_sha:head}), error => {
    assert.equal(error.uncertain, failure === "reported uncertainty" ? true : failure === "after launch" ? undefined : false)
    if (failure === "quota") assert.equal(error.state,"quota_hold")
    return true
  })
  assert.equal(calls,failure === "quota" ? 0 : 1)
 })
