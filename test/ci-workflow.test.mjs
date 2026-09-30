import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { parse } from "yaml"
import { Lexer, Parser, Evaluator, data } from "@actions/expressions"

const workflow = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"))

test("required test keeps running the complete baseline suite on PRs and main", () => {
  assert.deepEqual(workflow.on, { pull_request: null, push: { branches: ["main"] } })
  assert.deepEqual(workflow.permissions, { contents: "read" })
  assert.deepEqual(Object.keys(workflow.jobs), ["test"])
  const job = workflow.jobs.test
  assert.equal(job.name ?? "test", "test")
  assert.equal(job.if, undefined)
  assert.equal(job["continue-on-error"], undefined)
  assert.equal(job["runs-on"], "ubuntu-latest")
  assert.deepEqual(job.steps, [
    { uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" },
    { uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", with: { "node-version": 22, cache: "npm" } },
    { run: "npm ci" },
    { run: "npm test" },
    { run: "python3 capabilities/jev-browser-select/test_select.py" },
  ])
})

test("hung required test has a whole-job ceiling with room for ordinary successful work", () => {
  const minutes = workflow.jobs.test["timeout-minutes"]
  assert.ok(Number.isInteger(minutes), "missing finite job timeout; step-only limits leave setup unbounded")
  // Successful hosted jobs take at most 15 seconds. A hung-run experiment added
  // 15 seconds of runner termination after the execution timeout. Reserve 30
  // seconds for termination within the accepted two-minute completion ceiling.
  assert.ok(minutes >= 1, "allow cold-install headroom above the 15-second baseline")
  assert.ok(minutes * 60 + 30 <= 120, "execution and termination budgets must fit the two-minute ceiling")
})

function evaluate(expression, github) {
  const tokens = new Lexer(expression).lex().tokens
  const ast = new Parser(tokens, ["github"], []).parse()
  return new Evaluator(ast, JSON.parse(JSON.stringify({ github }), data.reviver)).evaluate()
}

function concurrencyFor({ workflowName = "CI", event = "pull_request", pr = 17, run = 100 } = {}) {
  assert.ok(workflow.concurrency, "superseded PR runs need a workflow concurrency policy")
  const github = {
    workflow: workflowName, event_name: event, run_id: String(run),
    event: event === "pull_request" ? { pull_request: { number: pr } } : {},
  }
  const group = workflow.concurrency.group.replace(/\$\{\{([\s\S]*?)\}\}/g,
    (_, expression) => evaluate(expression, github).coerceString())
  const cancellation = workflow.concurrency["cancel-in-progress"]
  const cancel = typeof cancellation === "boolean" ? cancellation
    : evaluate(cancellation.match(/^\$\{\{([\s\S]*?)\}\}$/)[1], github).value
  return { group, cancel }
}

test("two pushes to the same PR supersede only that PR's required run", () => {
  const first = concurrencyFor({ run: 100 })
  const latest = concurrencyFor({ run: 101 })
  assert.equal(first.group, latest.group)
  assert.equal(latest.cancel, true)
  assert.notEqual(latest.group, concurrencyFor({ pr: 18 }).group)
  assert.notEqual(latest.group, concurrencyFor({ workflowName: "Release" }).group)
  assert.notEqual(latest.group, concurrencyFor({ event: "push", run: 17 }).group)
})

test("main pushes keep independent results and cannot starve a main health run", () => {
  const first = concurrencyFor({ event: "push", run: 100 })
  const latest = concurrencyFor({ event: "push", run: 101 })
  assert.notEqual(first.group, latest.group)
  assert.equal(first.cancel, false)
  assert.equal(latest.cancel, false)
})
