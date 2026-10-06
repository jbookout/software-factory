import fs from 'node:fs/promises'
import path from 'node:path'
import { DeliveryError, keyFor, readJson, writeJson, withLease, acquireLease, pause } from './pr-delivery-state.mjs'
import { deliveryStatus } from './delivery-daemon.mjs'
import { createCodexExecArgs } from './codex-build.mjs'

const exists = file => fs.access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const flag = (config, name) => config.orchestratorDir ? exists(path.join(config.orchestratorDir, 'budget', name)) : false

export async function reserveBuilderEscalation(config, repo, pr, head) {
  return withLease(path.join(config.stateDir, 'locks'), `escalation-${keyFor(repo, pr)}`, async () => {
    const file = path.join(config.stateDir, 'escalations', `${keyFor(repo, pr)}.json`)
    const prior=await readJson(file,null)
    if(prior?.state==='requested' && prior.head===head)return prior
    if (prior) throw new DeliveryError('ESCALATION ALREADY REQUESTED: reconcile the alternate builder receipt; never repeat the spent lane', 75)
    const record = { schema: 'factory-builder-escalation/v1', repo, pr, head, lane: 'claude-opus', state: 'requested', at: new Date().toISOString() }
    await writeJson(file, record)
    return record
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
}

export async function queueDotReview(config, { repo, pr, head, full }) {
  if (!full || !await flag(config, 'DOT_AF_ON')) return null
  const queue = path.join(config.orchestratorDir, 'dot', 'queue')
  return withLease(path.join(config.stateDir, 'locks'), 'dot-af', async () => {
    const file = path.join(config.stateDir, 'dot', `${keyFor(repo, pr)}-${head}.json`)
    if (await readJson(file, null)) return null
    await fs.mkdir(queue, { recursive: true, mode: 0o700 })
    if ((await fs.readdir(queue)).filter(name => /-AF-.*\.md$/.test(name)).length >= 4) return null
    const job = `AF-${repo.split('/')[1]}-${pr}`, brief = path.join(queue, `${Date.now()}-${job}.md`)
    await fs.writeFile(brief, `[orch] JOB ${job}. Rules, all required: 1. Read-only, public web and public GitHub only. 2. Never start or delegate a Codex task. 3. Post your answer only in this Slack thread. 4. Finish with exactly DOT-REPORT-END ${job} outside any code block. Task: review https://github.com/${repo}/pull/${pr} at head ${head}, quote the full SHA first. Read the description, every review comment and changed file. Report defects with file:line, triggering input, wrong result, severity and fix; distinguish CI failures from main. Say plainly if nothing blocks merge.\n`, { flag: 'wx', mode: 0o600 })
    await writeJson(file, { repo, pr, head, brief })
    return brief
  }, { waitMs: config.commandTimeoutMs, pollMs: config.pollMs })
}

// Both remote lanes return the same exact-head verdict as the Studio reviewer.
// The controller owns the receipt and final publication; slot claims survive its
// supervised child and recover through the existing lease mechanism.
export async function remoteReview(config, request, { command, observe, sleep = pause, budget, env = process.env }) {
  const { repo, pr, head, prompt, output } = request
  const lockRoot = path.join(config.stateDir, 'locks')
  const failure = lane => deliveryStatus(config, { repo, pr, step: 'review', message: `${lane} review fell through`, nextAction: 'review-on-next-lane' })
  const valid = body => /^(APPROVE|REVIEW: BLOCKED)\nReviewed-SHA: ([0-9a-f]{40})(?:\n|$)/.exec(body ?? '')?.[2] === head
  if (env.MACBOOK_OFF !== '1' && await flag(config, 'MACBOOK_ON')) {
    const slot = await acquireLease(lockRoot, 'review-macbook', { budget })
    if (slot) try {
      const ssh = ['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', 'macbook']
      const probe = await command([...ssh, 'pmset -g ps | head -1 | grep -q "AC Power" && [ $(sysctl -n vm.loadavg | awk \'{printf "%d", $2}\') -lt 4 ] && [ $(df -k ~ | tail -1 | awk \'{print $4}\') -gt 2097152 ]'], undefined, { allowFailure: true })
      if (!probe.code) {
        const remoteOutput = `review-${pr}-${head}-${Date.now()}.txt`
        const model = request.model ?? {model:'gpt-6.1-sol',effort:'high'}
        const argv = ['codex',...createCodexExecArgs(model),'--sandbox','danger-full-access','--output-last-message',remoteOutput,'-']
        // The remote lock names the worker PID, not the SSH transport. Losing
        // the transport cannot free the checkout under a surviving reviewer.
        const script = `export PATH=/opt/homebrew/bin:$PATH CARR_JEV_WORKER=off
cd ~/orch-wt/${repo.split('/')[1]} || exit 9
mkdir -p _to_delete
lock=.factory-review-lock
if ! mkdir "$lock" 2>/dev/null; then
  oldpid=$(cat "$lock/pid" 2>/dev/null)
  [ -n "$oldpid" ] || exit 75
  kill -0 "$oldpid" 2>/dev/null && exit 75
  mv "$lock" "_to_delete/review-lock-$(date +%s)-$$" || exit 75
  mkdir "$lock" || exit 75
fi
echo $$ > "$lock/pid"
cleanup(){ [ -n "$worker" ] && kill -0 "$worker" 2>/dev/null && return; mv "$lock" "_to_delete/review-lock-$(date +%s)-$$" 2>/dev/null; }
trap cleanup EXIT
git fetch -q origin ${quote(head)} && git checkout -q --detach ${quote(head)} || exit 1
tree=$(git rev-parse HEAD^{tree}) || exit 1
exec 3<&0\nperl -e 'alarm shift; exec @ARGV' 4500 ${argv.map(quote).join(' ')} <&3 >&2 &
worker=$!; echo "$worker" > "$lock/pid"
wait "$worker" || exit 1
[ "$(git rev-parse HEAD)" = ${quote(head)} ] && [ "$(git write-tree)" = "$tree" ] && git diff --quiet && git diff --cached --quiet || exit 9
cat ${quote(remoteOutput)}`
        const result = await command([...ssh, script], undefined, { input: prompt, allowFailure: true, timeoutMs: config.limits?.timeoutMs ?? 4500_000,
          onSpawn: (job, signal) => slot.bindJob(job, signal) })
        if (!result.code && valid(result.stdout)) {
          await fs.writeFile(output, result.stdout, { mode: 0o600 })
          return { ...result, lane: 'macbook' }
        }
      }
      await failure('macbook')
    } finally { await slot() }
  }
  if (env.CLOUD_OFF === '1' || repo !== 'jbookout/carr-system' || !await flag(config, 'CLOUD_ON')) return null
  const count = Number(env.CLOUD_SLOTS ?? config.cloudSlots ?? 1)
  if (!Number.isSafeInteger(count) || count < 1 || count > 16) throw new DeliveryError('invalid CLOUD_SLOTS', 9)
  const cloudDir=path.join(config.stateDir,'cloud-reviews'), cloudFile=path.join(cloudDir,`${keyFor(repo,pr)}-${head}.json`)
  // A cloud session outlives the CLI that starts it. Persist its slot and launch
  // intent before dispatch; a restart falls through without starting it twice.
  const admitted=await withLease(lockRoot,'cloud-admission',async()=>{
    if(await readJson(cloudFile,null))return false
    await fs.mkdir(cloudDir,{recursive:true,mode:0o700})
    const records=await Promise.all((await fs.readdir(cloudDir)).filter(name=>name.endsWith('.json')).map(name=>readJson(path.join(cloudDir,name))))
    if(records.filter(row=>['requested','uncertain'].includes(row.state)).length>=count)return false
    await writeJson(cloudFile,{repo,pr,head,state:'requested'})
    return true
  },{waitMs:config.commandTimeoutMs,pollMs:config.pollMs})
  if(!admitted)return null
  for (let i = 0; i < count; i++) {
    const slot = await acquireLease(lockRoot, `review-cloud-${i}`, { budget })
    if (!slot) continue
    try {
      const cloudLog = `${output}.cloud.log`
      const cloudPrompt = `${prompt}\nYou run in a Claude cloud container. Check out PR ${pr} in ${repo} first and prove HEAD is ${head}. Post exactly ONE verdict with gh pr comment ${pr} -R ${repo} --body-file <file>. The factory observes that exact-head trusted comment. No second reviewer or delegated task.`
      const result = await command(['script', '-q', cloudLog, config.claude?.command ?? 'claude', '--cloud', cloudPrompt], request.checkout,
        { allowFailure: true, onSpawn: (job, signal) => slot.bindJob(job, signal) })
      if (!result.code) for (let attempt = 0; attempt < 50; attempt++) {
        budget?.check()
        const body = await observe()
        if (valid(body)) {
          await fs.writeFile(output, body, { mode: 0o600 })
          await writeJson(cloudFile,{...await readJson(cloudFile),state:'completed',execution:result})
          return { ...result, lane: 'cloud' }
        }
        if (attempt < 49) await sleep(120_000)
      }
      await failure('cloud')
      await writeJson(cloudFile,{...await readJson(cloudFile),state:'uncertain'})
      return null
    } finally { await slot() }
  }
  return null
}
