import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {executableBytes} from '../deploy/orch/factory-verify.mjs'
const root=fileURLToPath(new URL('../',import.meta.url))

test('installed entrypoint removes repository replay without relying on explanatory comments',async () => {
 const template=await fs.readFile(path.join(root,'deploy/orch/factory-entry.sh'),'utf8')
 const expected=Buffer.from(`#!/bin/sh
export CARR_JEV_WORKER=off
DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 9
RECEIPT="$DIRECTORY/.factory-orch.json"
if [ -f "$RECEIPT" ]; then
  exec node "$DIRECTORY/factory-verify.mjs" "$DIRECTORY" "$@"
fi
echo 'missing installation receipt; reinstall delivered factory source' >&2
exit 9
`)
 assert.deepEqual(executableBytes('deploy/orch/factory-entry.sh',Buffer.from(template)),expected)
 const prose=template.replace('if [ -n "$FACTORY_ROOT" ]',' # Reworded repository replay explanation.\nif [ -n "$FACTORY_ROOT" ]')
 const transformed=executableBytes('deploy/orch/factory-entry.sh',Buffer.from(prose)).toString()
 assert.equal(transformed.split('\n').filter(line=>!line.trim().startsWith('#')).join('\n'),expected.toString().split('\n').filter(line=>!line.trim().startsWith('#')).join('\n'))
 assert.throws(()=>executableBytes('deploy/orch/factory-entry.sh',Buffer.from(template.replaceAll('FACTORY_ROOT','MISSING_ROOT'))),/invalid factory entrypoint template/)
})

test('repository entrypoint retains replay and installed entrypoint refuses it',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'factory-replay-template-'))
 t.after(()=>fs.rm(directory,{recursive:true,force:true}))
 const adapter=path.join(directory,'deploy/orch'),bin=path.join(directory,'bin')
 await fs.mkdir(adapter,{recursive:true});await fs.mkdir(bin)
 const template=await fs.readFile(path.join(root,'deploy/orch/factory-entry.sh'))
 const entry=path.join(adapter,'factory-entry.sh')
 await fs.writeFile(entry,template)
 await fs.writeFile(path.join(bin,'pr-delivery.mjs'),"console.log(JSON.stringify(process.argv.slice(2)))\n")
 const env={...process.env,FACTORY_ROOT:directory,FACTORY_PR_CONFIG:'fixture-config'}
 assert.deepEqual(JSON.parse(execFileSync('sh',[entry,'fixture-command','fixture-argument'],{env,encoding:'utf8'})),['fixture-config','fixture-command','fixture-argument'])
 await fs.writeFile(entry,executableBytes('deploy/orch/factory-entry.sh',template))
 assert.throws(()=>execFileSync('sh',[entry,'fixture-command'],{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),error=>error.status===9 && /missing installation receipt/.test(error.stderr.toString()))
})
