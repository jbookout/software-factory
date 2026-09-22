import { createHash, randomUUID } from "node:crypto"

import { evaluatePerformance } from "./performance-factory.mjs"
import { classifyRisk, reviewsFor } from "./risk-router.mjs"

const DEFAULT_BUDGETS = { verificationRounds: 3, reviewRounds: 2 }

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function findingKey(findings) {
  return hash(findings ?? [])
}

function assertJob(job) {
  if (!job || typeof job !== "object") throw new Error("job is required")
  for (const field of ["outcome", "sourceRevision"]) {
    if (typeof job[field] !== "string" || !job[field].trim()) throw new Error(`${field} is required`)
  }
}

export function createFactory({ now = () => new Date().toISOString(), makeId = randomUUID,
  modelRoomAdvisor = null } = {}) {
  return {
    async run(job, adapter) {
      assertJob(job)
      if (!adapter || typeof adapter.execute !== "function") throw new Error("adapter.execute is required")

      const startedAt = now()
      const jobId = job.id ?? makeId()
      const budgets = { ...DEFAULT_BUDGETS, ...job.budgets }
      const events = []
      const findings = []
      const evidence = []
      const proposals = []
      let stopped = null
      let prepared = false
      let environmentId = null

      async function execute(step, input = {}) {
        let result
        try {
          result = await adapter.execute(step, {
            jobId,
            outcome: job.outcome,
            sourceRevision: job.sourceRevision,
            ...input
          })
        } catch (error) {
          result = {
            status: "fail",
            evidence: [],
            findings: [{ reason: "adapter execution failed", errorType: error.name, errorDigest: hash(error.message) }],
            measurements: {},
            proposals: [],
            data: {}
          }
        }
        events.push({ step, status: result.status })
        evidence.push(...result.evidence.map((item) => ({ step, ...item })))
        findings.push(...result.findings.map((item) => ({ step, ...item })))
        proposals.push(...result.proposals.map((item) => ({ step, ...item })))
        return result
      }

      async function repairLoop(step, repairStep, limit) {
        let previous = null
        for (let round = 1; round <= limit; round += 1) {
          const result = await execute(step, { round })
          if (result.status === "pass") return true
          if (result.status === "skip") {
            stopped = `${step}:missing`
            return false
          }
          const current = findingKey(result.findings)
          if (current === previous) {
            stopped = `${step}:stalled`
            return false
          }
          previous = current
          if (round < limit) await execute(repairStep, { round, findings: result.findings })
        }
        stopped = `${step}:budget-exhausted`
        return false
      }

      const environment = await execute("environment:prepare")
      environmentId = environment.data.environmentId ?? null
      prepared = Boolean(environmentId)
      if (environment.status !== "pass" || environment.data.isolated !== true || !environment.data.environmentId) {
        stopped = environment.status === "skip" ? "environment:missing" : "environment:prepare"
      }

      const context = !stopped ? await execute("context:collect", { environmentId }) : { status: "skip" }
      if (!stopped && context.status !== "pass") {
        stopped = context.status === "skip" ? "context:missing" : "context:collect"
      }
      const declaredRisk = classifyRisk(job.risk)
      const evidenceRequired = job.kind === "bug" || declaredRisk.signals.includes("interface")
      const before = !stopped ? await execute("evidence:before", { required: evidenceRequired }) : { status: "skip" }
      if (!stopped && evidenceRequired && before.status !== "pass") stopped = "evidence:before:missing"
      let modelRoom = null
      if (!stopped && job.product === "DoctorCRE" && modelRoomAdvisor) {
        try {
          modelRoom = await modelRoomAdvisor({ job, context: context.data })
          if (!modelRoom || modelRoom.schema !== "doctorcre-build-route.v1" || !modelRoom.selected_route)
            throw new Error("invalid model room advice")
          events.push({ step: "model-room:advise", status: "pass" })
        } catch (error) {
          stopped = "model-room:advise"
          findings.push({ step: "model-room:advise", reason: "model room advice failed",
            errorType: error.name, errorDigest: hash(error.message) })
          events.push({ step: "model-room:advise", status: "fail" })
        }
      }
      if (!stopped) {
        const build = await execute("build", modelRoom ? { route: modelRoom.selected_route,
          modelRoomStateDigest: modelRoom.state_digest } : {})
        if (build.status !== "pass") stopped = build.status === "skip" ? "build:missing" : "build"
      }
      if (!stopped) await repairLoop("verify", "repair:verification", budgets.verificationRounds)

      const inspected = !stopped ? await execute("risk:inspect") : { status: "skip", data: {} }
      if (!stopped && inspected.status !== "pass") {
        stopped = inspected.status === "skip" ? "risk:missing" : "risk:inspect"
      }
      const risk = classifyRisk({
        changedPaths: [...new Set([...(job.risk?.changedPaths ?? []), ...(inspected.data.changedPaths ?? [])])],
        signals: [...new Set([...(job.risk?.signals ?? []), ...(inspected.data.signals ?? [])])]
      })
      const reviewRoles = reviewsFor(risk)
      if (!stopped && (job.kind === "bug" || risk.signals.includes("interface")) && before.status !== "pass") {
        stopped = "evidence:before:missing-after-inspection"
      }
      if (!stopped) {
        let previous = null
        for (let round = 1; round <= budgets.reviewRounds; round += 1) {
          const results = await Promise.all(reviewRoles.map((role) => execute(`review:${role}`, { role, round, risk })))
          const missing = results.some((result) => result.status === "skip")
          if (missing) {
            stopped = "review:missing"
            break
          }
          const failed = results.flatMap((result, index) => {
            if (result.status === "pass") return []
            return result.findings.length ? result.findings : [{ role: reviewRoles[index], reason: "review did not pass" }]
          })
          if (!failed.length) break
          const current = findingKey(failed)
          if (current === previous) {
            stopped = "review:stalled"
            break
          }
          previous = current
          if (round === budgets.reviewRounds) {
            stopped = "review:budget-exhausted"
            break
          }
          await execute("repair:review", { round, findings: failed })
        }
      }

      if (!stopped) {
        const after = await execute("evidence:after", {
          risk,
          required: job.kind === "bug" || risk.signals.includes("interface")
        })
        if ((job.kind === "bug" || risk.signals.includes("interface")) && after.status !== "pass") {
          stopped = "evidence:after:missing"
        }
      }

      let release = { status: "skip", findings: [] }
      let production = { status: "skip", findings: [] }
      if (!stopped) {
        release = await execute("release:observe", { risk })
        if (release.status === "fail") stopped = "release:observe"
      }
      if (!stopped) {
        production = await execute("production:observe", { risk })
        if (production.status === "fail") stopped = "production:observe"
      }

      const measurement = !stopped
        ? await execute("performance:measure", { risk })
        : { status: "skip", measurements: {} }
      let performance = evaluatePerformance({
        baseline: job.performance?.baseline,
        current: measurement.measurements,
        budgets: job.performance?.budgets,
        knownFingerprints: job.performance?.knownFingerprints
      })
      if (Object.keys(job.performance?.budgets ?? {}).length && measurement.status !== "pass") {
        performance = {
          status: "fail",
          findings: [{ metric: null, reason: "required performance measurement did not pass" }],
          duplicates: []
        }
      }
      if (performance.findings.length) {
        findings.push(...performance.findings.map((item) => ({ step: "performance:evaluate", ...item })))
        await execute("performance:analyze", { regressions: performance.findings })
      }

      const incidentSignals = [release, production].flatMap((result) => result.findings)
        .filter((item) => ["critical", "outage"].includes(item.severity))
      if (incidentSignals.length) {
        await execute("incident:investigate", { signals: incidentSignals, authority: "read-only" })
      }

      if (prepared) await execute("garden:inspect", { risk })
      if (prepared) {
        const disposed = await execute("environment:dispose", { environmentId })
        if (disposed.status !== "pass" && !stopped) stopped = "environment:dispose"
      }
      const outcome = stopped || performance.status === "fail" ? "needs-attention" : "complete"
      await execute("learn:record", { outcome, stopped, risk, findings })
      const completedAt = now()
      const result = {
        contractVersion: 1,
        jobId,
        outcome,
        stopped,
        environmentId,
        sourceRevision: job.sourceRevision,
        risk,
        riskRecommendation: ["critical", "high"].includes(risk.level)
          ? { blocking: false, text: "Obtain explicit product-owner judgment after reviewing the evidence." }
          : null,
        reviewRoles,
        performance,
        events,
        evidence,
        findings,
        proposals,
        modelRoom,
        startedAt,
        completedAt
      }
      return { ...result, receiptDigest: hash(result) }
    }
  }
}
