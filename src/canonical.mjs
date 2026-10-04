import { createHash } from "node:crypto"

// Signatures use lexical keys; settings retain JSON's integer-index ordering.
// Both contracts sort keys recursively, independent of input property order.
export function canonicalJson(value, { integerKeysFirst = false } = {}) {
  const serialize = item => canonicalJson(item, { integerKeysFirst })
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`
  if (value && typeof value === "object") {
    const sorted = Object.keys(value).sort()
    const keys = integerKeysFirst
      ? Object.keys(Object.fromEntries(sorted.map(key => [key, null])))
      : sorted
    return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** Hex sha256 of the canonical form. */
export const canonicalDigest = (value, options) => createHash("sha256").update(canonicalJson(value, options)).digest("hex")

export function deepFreeze(value) {
  if (value && typeof value === "object") Object.values(Object.freeze(value)).forEach(deepFreeze)
  return value
}
