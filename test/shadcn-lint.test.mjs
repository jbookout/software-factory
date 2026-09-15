import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(
  root,
  "capabilities",
  "tailwind-design-system-lint",
  "fixture"
)

async function lint(file) {
  const eslint = new ESLint({
    cwd: fixture,
    overrideConfigFile: path.join(fixture, "eslint.config.mjs")
  })
  return eslint.lintFiles([path.join(fixture, "src", file)])
}

test("the design-system fixture accepts declared usage", async () => {
  const [result] = await lint("valid.tsx")
  assert.equal(result.errorCount, 0, JSON.stringify(result.messages, null, 2))
})

test("the design-system fixture rejects drift with actionable diagnostics", async () => {
  const [result] = await lint("invalid.tsx")
  const rules = new Set(result.messages.map(({ ruleId }) => ruleId))

  assert.ok(result.errorCount >= 4, JSON.stringify(result.messages, null, 2))
  assert.ok(rules.has("shadcn/no-restyle"))
  assert.ok(rules.has("shadcn/no-raw-colors"))
  assert.ok(rules.has("shadcn/no-arbitrary-values"))
  assert.ok(rules.has("shadcn/no-inline-styles"))
  assert.ok(rules.has("shadcn/require-static-classes"))
  assert.ok(
    result.messages.some(({ message }) => message.includes("Use an existing component variant")),
    "expected repair guidance in at least one diagnostic"
  )
})
