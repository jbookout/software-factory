import test from "node:test"

// Disposable hosted acceptance fixture; removed before final delivery.
test("hosted whole-job timeout acceptance", async () => {
  console.log("CI_HANG_FIXTURE_STARTED timeout")
  const heartbeat = setInterval(() => console.log("CI_HANG_FIXTURE_ALIVE timeout"), 1000)
  try { await new Promise(() => {}) } finally { clearInterval(heartbeat) }
})
