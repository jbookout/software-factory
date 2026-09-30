import test from "node:test"

// Disposable hosted acceptance fixture; removed before final delivery.
test("hosted PR supersession acceptance", async () => {
  console.log("CI_HANG_FIXTURE_STARTED supersession")
  const heartbeat = setInterval(() => console.log("CI_HANG_FIXTURE_ALIVE supersession"), 1000)
  try { await new Promise(() => {}) } finally { clearInterval(heartbeat) }
})
