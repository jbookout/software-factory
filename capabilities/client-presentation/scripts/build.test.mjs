import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {build,validate} from './build.mjs';

const sample=()=>fs.readFile(new URL('../assets/site/presentation.json',import.meta.url),'utf8').then(JSON.parse);
test('a new client builds an independent package, with inert text and matching canonical data',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'client-presentation-test-'));
  const d=await sample();d.presentation.preparedFor='Juniper Dental <script>alert(1)</script>';
  d.presentation.title='Juniper search review';
  const input=path.join(root,'input.json'),out=path.join(root,'site');
  await fs.writeFile(input,JSON.stringify(d));
  assert.equal(await build(input,out),path.join(out,'index.html'));
  const context={window:{}};
  vm.runInNewContext(await fs.readFile(path.join(out,'data.js'),'utf8'),context);
  assert.equal(context.window.PresentationData.presentation.preparedFor,d.presentation.preparedFor);
  assert.ok(!(await fs.readFile(path.join(out,'data.js'),'utf8')).includes('<script>'));
  for(const file of ['index.html','app.js','styles.css','finance.js','data.js'])assert.ok((await fs.stat(path.join(out,file))).size>0);
  const stored=JSON.parse(await fs.readFile(path.join(out,'presentation.json'),'utf8'));
  assert.deepEqual(stored,d);
  await assert.rejects(build(input,out),/EEXIST/);
});
test('client identity, stable IDs and evidence are required before client generation',async()=>{
  const d=await sample();d.presentation.fictional=false;
  assert.throws(()=>validate(d),/source date/);
  const dup=await sample();dup.leases[0].id=dup.properties[0].id;
  assert.throws(()=>validate(dup),/duplicate item ID/);
});
test('only named local assets are copied and rewritten',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'client-presentation-media-'));
  const d=await sample();d.properties[0].image='example.png';
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfkAAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(root,'example.png'),bytes);
  await fs.writeFile(path.join(root,'not-requested.txt'),'must not be exported');
  const input=path.join(root,'input.json'),out=path.join(root,'site');
  await fs.writeFile(input,JSON.stringify(d));await build(input,out);
  const stored=JSON.parse(await fs.readFile(path.join(out,'presentation.json'),'utf8'));
  assert.match(stored.properties[0].image,/^media\/[a-f0-9]+\.png$/);
  assert.deepEqual(await fs.readFile(path.join(out,stored.properties[0].image)),bytes);
  await assert.rejects(fs.stat(path.join(out,'not-requested.txt')),/ENOENT/);
});

test('client generation rejects unsourced or missing basemaps and missing marker coordinates',async()=>{
  const d=await sample();d.presentation.fictional=false;
  d.sources.forEach(s=>{s.date='2026-10-02';s.title='Verified source';});
  [...d.properties,...d.leases,...d.developments].forEach(x=>{x.image='photo.png';x.sourceId=d.sources[0].id;});
  assert.throws(()=>validate(d),/client locator image/);
  d.locator.image='map.png';d.locator.sourceId=d.sources[0].id;
  assert.equal(validate(d),d);
  delete d.leases[0].locator;
  assert.throws(()=>validate(d),/verified locator coordinates/);
});

test('a property review can omit ownership analysis and its assumptions',async()=>{
  const d=await sample();d.sections=d.sections.filter(s=>s.id!=='strategy');delete d.assumptions;
  assert.equal(validate(d),d);
});
