// Forward result markers, never test names, console output or error payloads.
export default async function* browserResults(events) {
  let passed = 0, filePassed = 0, terminal, failed = false
  for await (const { type, data } of events) {
    if (type === 'test:pass' && data.details?.type === 'test' && data.name !== data.file && !data.skip && !data.todo) passed++
    if (type === 'test:fail') failed = true
    if (type === 'test:summary') {
      const counts = data.counts
      const valid = data.success === true && counts &&
        ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
        counts.failed === 0 && counts.cancelled === 0 && counts.tests === counts.passed + counts.skipped + counts.todo
      if (!valid) failed = true
      if (data.file) filePassed += counts?.passed ?? 0
      else terminal = valid ? counts : null
    }
  }
  // File envelopes and suite markers never acknowledge a test body. A missing
  // final summary (including early process.exit) cannot produce a browser pass.
  if (!failed && passed > 0 && filePassed === passed && terminal?.passed === passed) yield `pass ${passed}\n`
}
