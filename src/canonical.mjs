import { createHash } from "node:crypto"

// The one canonical form for digests and signatures: key order never changes meaning.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}

/** Hex sha256 of the canonical form. */
export const canonicalDigest = value => createHash("sha256").update(canonicalJson(value)).digest("hex")

export function deepFreeze(value) {
  if (value && typeof value === "object") Object.values(Object.freeze(value)).forEach(deepFreeze)
  return value
}
