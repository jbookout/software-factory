import { spawn } from 'node:child_process'

// The supervisor persists this group's lease before opening the launch latch.
// The command inherits the group; it cannot execute while the lease is unbound.
process.on('disconnect', () => process.exit(1))
process.once('message', ({ argv, input }) => {
  const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') process.exit(1) })
  child.on('error', () => process.exit(1))
  child.on('close', (code, signal) => {
    // Preserve interruption across the latch so the controller retains readback.
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 1)
  })
  child.stdin.end(input)
})
