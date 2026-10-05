// Node's host monotonic clock is shared by the controller and its supervisor.
export const monotonicNow = () => Number(process.hrtime.bigint() / 1_000_000n)
const MAX_TIMER_MS = 2 ** 31 - 1
export const validDuration = (ms, minimum = 1) => Number.isSafeInteger(ms) && ms >= minimum && ms <= MAX_TIMER_MS
const realClock = { now: monotonicNow, setTimer: setTimeout, clearTimer: clearTimeout }
export class DeadlineError extends Error {
  constructor(phase) {
    super(`${phase.toUpperCase()}-TIMEOUT`)
    this.code = 142; this.phase = phase; this.transient = false
    this.nextAction = 'reobserve-condition-before-retry'
  }
}
// Phase clocks share the attempt's monotonic end. Bytes, retries and nested
// probes never renew it. Injectable clock is used by deterministic replays.
export class Deadline {
  constructor(ms, { phase = 'attempt', clock = realClock, end = Infinity, signal } = {}) {
    if (!validDuration(ms)) throw new Error('deadline must fit the supported timer range')
    this.clock = clock; this.phase = phase; this.signal = signal
    this.end = Math.min(end, clock.now() + ms)
  }
  remaining() { return Math.max(0, this.end - this.clock.now()) }
  check() {
    if (this.signal?.aborted) { const e = new Error('ATTEMPT-CANCELLED'); e.code = 130; throw e }
    if (!this.remaining()) throw new DeadlineError(this.phase)
  }
  phaseBudget(phase, ms) {
    const limitingPhase = this.clock.now() + ms >= this.end ? this.phase : phase
    return new Deadline(ms, { phase: limitingPhase, clock: this.clock, end: this.end, signal: this.signal })
  }
  async run(fn) {
    this.check()
    let timer, abort
    const controller = new AbortController()
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => fn(controller.signal)),
        new Promise((_, reject) => {
          timer = this.clock.setTimer(() => { controller.abort(); reject(new DeadlineError(this.phase)) }, this.remaining())
          abort = () => { controller.abort(); const e = new Error('ATTEMPT-CANCELLED'); e.code = 130; reject(e) }
          this.signal?.addEventListener('abort', abort, { once: true })
          if (this.signal?.aborted) abort()
        })
      ])
      this.check()
      return value
    } finally { this.clock.clearTimer(timer); this.signal?.removeEventListener('abort', abort) }
  }
  async sleep(ms) {
    this.check()
    let timer, abort
    const duration = Math.min(ms, this.remaining())
    try {
      await new Promise((resolve, reject) => {
        timer = this.clock.setTimer(resolve, duration)
        abort = () => { const e = new Error('ATTEMPT-CANCELLED'); e.code = 130; reject(e) }
        this.signal?.addEventListener('abort', abort, { once: true })
        if (this.signal?.aborted) abort()
      })
      this.check()
    } finally { this.clock.clearTimer(timer); this.signal?.removeEventListener('abort', abort) }
  }
}
export async function waitForCondition(probe, { budget, ready, pollMs, maxPollMs = pollMs * 8, boundedProbe = false }) {
  let delay = pollMs
  while (true) {
    budget.check()
    const value = boundedProbe ? await probe() : await budget.run(probe)
    budget.check()
    if (ready(value)) return value
    await budget.sleep(Math.max(delay, value?.retryAfterMs ?? 0))
    delay = Math.min(maxPollMs, delay * 2)
  }
}
