import { createHash } from "node:crypto"

export function isDeliveryBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const { repo, pr, head } = value
  return typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    !repo.split("/").some(part => part === "." || part === "..") &&
    Number.isSafeInteger(pr) && pr > 0 && typeof head === "string" && /^[0-9a-f]{40}$/.test(head)
}

// Effect identity binds semantic input; retries keep the same explicit attempt.
export function deliveryEffectId({ repo, pr, head, action, attempt = 1, policy = "pr-delivery/v1" }) {
  if (!isDeliveryBinding({ repo, pr, head }) ||
      typeof action !== "string" || !action || !Number.isSafeInteger(attempt) || attempt <= 0 ||
      typeof policy !== "string" || !policy) throw Error("invalid delivery effect binding")
  return createHash("sha256").update(JSON.stringify([repo, pr, head, action, policy, attempt])).digest("hex")
}
