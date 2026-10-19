import test from "node:test"
import assert from "node:assert/strict"
import { canonicalDigest, canonicalJson, deepFreeze } from "../src/canonical.mjs"

test("one canonical rule: key order never changes the serialization, digest or signature", () => {
  const a = { b: [1, { y: 2, x: 1 }], a: "z" }
  const b = { a: "z", b: [1, { x: 1, y: 2 }] }
  assert.equal(canonicalJson(a), '{"a":"z","b":[1,{"x":1,"y":2}]}')
  assert.equal(canonicalDigest(a), canonicalDigest(b))
  assert.match(canonicalDigest(a), /^[a-f0-9]{64}$/)
})

test("deepFreeze freezes nested objects and arrays", () => {
  const value = deepFreeze({ list: [{ x: 1 }] })
  assert.throws(() => { value.list[0].x = 2 }, TypeError)
  assert.throws(() => { value.list.push(1) }, TypeError)
})

test("numeric keys preserve both JSON settings ordering and lexical signature ordering", () => {
  const value = { rows: [{ '2': 'two', '10': 'ten', '01': 'leading', '4294967295': 'non-index' }] }
  const lexical = '{"rows":[{"01":"leading","10":"ten","2":"two","4294967295":"non-index"}]}'
  const json = '{"rows":[{"2":"two","10":"ten","01":"leading","4294967295":"non-index"}]}'
  assert.equal(canonicalJson(value), lexical)
  assert.equal(canonicalJson(value, { integerKeysFirst: true }), json)
  assert.notEqual(canonicalDigest(value), canonicalDigest(value, { integerKeysFirst: true }))
})
