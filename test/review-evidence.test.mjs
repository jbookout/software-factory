import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deliveryPrompt } from '../src/pr-delivery-prompts.mjs'
const api=()=>import('../src/review-evidence.mjs')
const binding={repo:'fixture/repo',pr:7,base:'a'.repeat(40),head:'b'.repeat(40),tree:'c'.repeat(40),observedAt:'2026-10-05T00:00:00.000Z'}
async function input() {
 const {writeReviewEvidence}=await api()
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-evidence-'))
 return writeReviewEvidence(root,binding,{description:'Fixture description',diff:'diff --git a/source b/source\n+fixed',checks:{state:'success',head:binding.head}})
}
test('exact-head owner inputs support review without worker GitHub credentials',async()=>{
 const {readReviewEvidence}=await api(), manifest=await input()
 const evidence=await readReviewEvidence(manifest,binding)
 assert.match(await fs.readFile(evidence.files.diff.path,'utf8'),/\+fixed/)
 assert.equal(await fs.readFile(evidence.files.description.path,'utf8'),'Fixture description')
 assert.equal(JSON.parse(await fs.readFile(evidence.files.checks.path,'utf8')).state,'success')
 const prompt=deliveryPrompt('review',{repo:binding.repo,pr:7,head:binding.head,evidence})
 assert.match(prompt,/OWNER-CAPTURED INPUT/)
 assert.doesNotMatch(prompt,/gh pr diff/)
 assert.match(prompt,/client.*route.*probe/)
 assert.equal((await fs.stat(evidence.files.diff.path)).mode & 0o222,0)
 await assert.rejects(readReviewEvidence(manifest,{...binding,head:'d'.repeat(40)}),/binding/)
})
test('omitted diff or modified input is rejected before a review verdict',async()=>{
 const {readReviewEvidence}=await api(), manifest=await input()
 const value=JSON.parse(await fs.readFile(manifest,'utf8'))
 await fs.chmod(value.files.diff.path,0o600)
 await fs.appendFile(value.files.diff.path,'altered')
 await assert.rejects(readReviewEvidence(manifest,binding),/digest/)
 await fs.chmod(manifest,0o600);delete value.files.diff
 await fs.writeFile(manifest,JSON.stringify(value))
 await assert.rejects(readReviewEvidence(manifest,binding),/diff/)
})
test('a successful same-endpoint alternate probe establishes availability without hiding TLS failure',async()=>{
 const {readProbe,probeAvailability}=await import('../src/github-snapshot.mjs')
 const failure=readProbe('gh','repos/fixture/repo/pulls/7',{code:1,stderr:'tls: failed to verify certificate: x509: OSStatus -26276'})
 assert.equal(failure.kind,'tls');assert.match(failure.error,/OSStatus -26276/)
 assert.equal(failure.client,'gh');assert.equal(failure.route,'repos/fixture/repo/pulls/7')
 assert.equal(probeAvailability([failure]).availability,'unproven')
 const successful=readProbe('sanctioned-owner','repos/fixture/repo/pulls/7',{code:0})
 assert.equal(probeAvailability([failure,successful]).availability,'reachable')
 assert.equal(probeAvailability([failure,{...successful,route:'other'}]).availability,'unproven')
})

test('review launch requires owner-captured input',()=>{assert.throws(()=>deliveryPrompt('review',{repo:binding.repo,pr:7,head:binding.head}),/owner-captured/)})
