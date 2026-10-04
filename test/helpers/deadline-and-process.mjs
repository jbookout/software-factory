export const never = () => new Promise(() => {})
export function fakeClock() {
  let time = 0, id = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, ms) { timers.set(++id, { at: time + ms, fn }); return id },
    clearTimer: key => timers.delete(key),
    advance(ms) {
      time += ms
      for (const [key, timer] of timers) if (timer.at <= time) { timers.delete(key); timer.fn() }
    },
    pending: () => timers.size
  }
}
export const treeScript = `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('.'),10)"],{stdio:'inherit'});
process.stdout.write('DESCENDANT:'+child.pid+'\\n');
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`
export function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e }
}
export async function waitGone(pid, ms = 2000) {
  const end = Date.now() + ms
  while (alive(pid) && Date.now() < end) await new Promise(r => setTimeout(r, 10))
  return !alive(pid)
}
