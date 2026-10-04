import { createHmac, timingSafeEqual } from "node:crypto"
import { canonicalJson } from "./canonical.mjs"

const SIGNATURE = /^hmac-sha256:[0-9a-f]{64}$/

export const isHmacSignature = value => typeof value === "string" && SIGNATURE.test(value)

export function hmacSignature(payload, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(payload)).digest("hex")}`
}

export function hmacSignatureMatches(payload, signature, key) {
  if (!isHmacSignature(signature)) return false
  const actual = Buffer.from(signature.slice("hmac-sha256:".length), "hex")
  const expected = Buffer.from(hmacSignature(payload, key).slice("hmac-sha256:".length), "hex")
  return timingSafeEqual(actual, expected)
}
