import { createHmac, timingSafeEqual } from "node:crypto"

const SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/

// Key order never changes a signature: objects are serialized with sorted keys.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

export function hmacSignature(payload, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(payload)).digest("hex")}`
}

export function hmacSignatureMatches(payload, signature, key) {
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return false
  const actual = Buffer.from(signature.slice("hmac-sha256:".length), "hex")
  const expected = Buffer.from(hmacSignature(payload, key).slice("hmac-sha256:".length), "hex")
  return timingSafeEqual(actual, expected)
}
