// The orchestrator's merge-holds.txt, read fresh on every use so an edit takes
// effect on the next decision: `<owner/repo> <title-regex> <reason>`, `#` comments.
// A matching line keeps a PR out of the queue; a line whose reason starts with
// FREEZE also stops merging queued entries. A file that cannot be read exactly
// stops merges rather than dropping a hold.
import fs from "node:fs/promises"
import { DeliveryError } from "./pr-delivery-state.mjs"

export async function readHolds(file) {
  if (!file) return []
  const text = await fs.readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return ""
    throw new DeliveryError(`MERGE HOLDS UNREADABLE: ${error.code}`, 75, true)
  })
  return text.split("\n").flatMap((line, index) => {
    if (!line.trim() || line.startsWith("#")) return []
    const [, repo, pattern, reason = ""] = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim()) ?? []
    let regex = null
    try { if (pattern) regex = new RegExp(pattern, "i") } catch {}
    if (!regex) throw new DeliveryError(`MERGE HOLDS UNREADABLE: line ${index + 1} needs <repo> <title-regex> <reason>`, 75, true)
    return [{ repo, regex, reason, freeze: reason.startsWith("FREEZE") }]
  })
}

export const holdFor = (holds, repo, title) => holds.find(h => h.repo === repo && h.regex.test(title)) ?? null
export const freezeFor = (holds, repo, title) => holds.find(h => h.freeze && h.repo === repo && h.regex.test(title)) ?? null
