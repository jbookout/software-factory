import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { canonicalDigest, canonicalJson, deepFreeze } from "../src/canonical.mjs"
import { hmacSignature, hmacSignatureMatches } from "../src/hmac-signature.mjs"
import { resolveDesignSettings } from "software-factory/design-settings"
import { authenticateEvaluationBundle, MODEL_ROOM_EVIDENCE_SCHEMA } from "../src/model-room.mjs"

test("one canonical rule: key order never changes the serialization, digest or signature", () => {
  const a = { b: [1, { y: 2, x: 1 }], a: "z" }
  const b = { a: "z", b: [1, { x: 1, y: 2 }] }
  assert.equal(canonicalJson(a), '{"a":"z","b":[1,{"x":1,"y":2}]}')
  assert.equal(canonicalDigest(a), canonicalDigest(b))
  assert.match(canonicalDigest(a), /^[a-f0-9]{64}$/)
  const key = "k".repeat(32)
  assert.equal(hmacSignatureMatches(b, hmacSignature(a, key), key), true)
})

test("deepFreeze freezes nested objects and arrays", () => {
  const value = deepFreeze({ list: [{ x: 1 }] })
  assert.throws(() => { value.list[0].x = 2 }, TypeError)
  assert.throws(() => { value.list.push(1) }, TypeError)
})

test("design settings digest the profile with the shared canonical rule", async () => {
  const profile = JSON.parse(await readFile(new URL("../config/design-manager/joe.example.json", import.meta.url)))
  assert.equal(resolveDesignSettings(profile).digest, `sha256:${canonicalDigest(profile)}`)
})

test("a correctly signed model room bundle with an invalid control is still refused", () => {
  const key = "evaluator-secret-key-material-32-bytes-minimum"
  const payload = { schema: MODEL_ROOM_EVIDENCE_SCHEMA, control: { task_class: "doctorcre-build",
    mode: "qualified_only", minimum_cases: 2 }, observations: [] }
  assert.throws(() => authenticateEvaluationBundle({ ...payload, signature: hmacSignature(payload, key) }, key),
    /invalid model room evaluation bundle/)
})
