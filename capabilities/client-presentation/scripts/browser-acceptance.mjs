import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
import {build} from './build.mjs';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA4YAAAAASUVORK5CYII=', 'base64');
export async function assertPins(page, selector) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  const pins = await page.locator(selector).evaluateAll(nodes => nodes.map(node => {
    const b = node.getBoundingClientRect(), map = node.closest('[role=region]').getBoundingClientRect(), s = getComputedStyle(node);
    return {id: node.dataset.entityId, x:b.x,y:b.y,right:b.right,bottom:b.bottom,
      visible: !node.hidden && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && b.width > 0,
      inside:b.x>=map.x && b.y>=map.y && b.right<=map.right && b.bottom<=map.bottom,
      clickable:node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))};
  }));
  assert.ok(pins.length>0,'map must render source-backed pins');
  for(const p of pins) assert.ok(p.visible && p.inside && p.clickable,`pin hidden, clipped or covered: ${p.id}`);
  for(let i=0;i<pins.length;i++) for(let j=i+1;j<pins.length;j++) {const a=pins[i],b=pins[j];assert.ok(a.right<=b.x || b.right<=a.x || a.bottom<=b.y || b.bottom<=a.y,`pins overlap: ${a.id}, ${b.id}`);}
  return pins.map(p=>p.id);
}
export async function acceptBrowserSite({directory,negativeChecks=true,screenshots,offlineFixture=false}={}) {
  const files=path.resolve(directory), input=JSON.parse(await fs.readFile(path.join(files,'presentation.json'),'utf8'));
  let state={version:0,selected_ids:[],notes:'',property_notes:{},updated_at:null,csrf_token:'synthetic-csrf'}, failService=false, conflictNext=false;
  const server=createServer(async(request,response)=>{
    try {
      if(input.feedback.mode==='shared' && request.url===input.feedback.endpoint) {
        response.setHeader('Content-Type','application/json');
        if(failService){response.writeHead(503);response.end('{"error":"unavailable"}');return;}
        if(request.method==='PUT') {
          let body='';for await(const part of request)body+=part;const update=JSON.parse(body);
          if(conflictNext || update.version!==state.version){conflictNext=false;state.version++;response.writeHead(409);response.end(JSON.stringify({current:state}));return;}
          assert.equal(request.headers[(input.feedback.csrfHeader || 'X-CSRF-Token').toLowerCase()],state.csrf_token);
          state={...state,...update,version:state.version+1,updated_at:'2026-10-07T12:00:00Z'};
        }
        response.end(JSON.stringify(state));return;
      }
      const pathname=new URL(request.url,'http://127.0.0.1').pathname;
      const vendor=pathname==='/vendor/maplibre.js'?require.resolve('maplibre-gl/dist/maplibre-gl.js'):pathname==='/vendor/maplibre.css'?require.resolve('maplibre-gl/dist/maplibre-gl.css'):null;
      const filename=vendor || path.resolve(files,'.'+(pathname==='/'?'/index.html':pathname));
      if(!vendor && !filename.startsWith(files+path.sep)){response.writeHead(404);response.end();return;}
      let bytes=await fs.readFile(filename);
      if(pathname==='/' || pathname==='/index.html')bytes=Buffer.from(bytes.toString().replace('https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.js','/vendor/maplibre.js').replace('https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.css','/vendor/maplibre.css'));
      response.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.png')?'image/png':filename.endsWith('.json')?'application/json':'text/html');response.end(bytes);
    }catch{response.writeHead(404);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  const results=[];
  try {
    browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    for(const [device,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
      state={version:0,selected_ids:[],notes:'',property_notes:{},updated_at:null,csrf_token:'synthetic-csrf'};
      const context=await browser.newContext({viewport,reducedMotion:'reduce'});if(offlineFixture)await context.route('https://**',route=>route.abort());
      const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      assert.deepEqual(await page.locator('#site-nav a').allTextContents(),['Home',...(input.leases.length?['Leases']:[]),...(input.properties.length?['Purchases']:[]),...(input.sections.some(s=>s.id==='strategy' && s.visible!==false)?['Strategy']:[]),'Tour List','Demographics','Sources']);
      await page.locator('.home-actions a').click();await page.locator(input.properties.length?'#purchases':'#leases').waitFor({state:'visible'});
      await page.locator('#site-nav a[href="#home"]').click();await page.locator('#home').waitFor({state:'visible'});
      assert.match(await page.locator('#home-demographic-overview').innerText(),/Population[\s\S]*Households[\s\S]*Median household income/);
      assert.ok((await page.locator('#home-population-chart .bar-row').allTextContents()).at(-1).includes(new Intl.NumberFormat('en-US').format(input.demographics.population.values.at(-1).value)));
      await page.locator('#home-demographics a').click();await page.locator('#demographics').waitFor({state:'visible'});
      await page.locator('#site-nav a[href="#home"]').click();
      await page.waitForSelector('#development-map[data-map-ready=true]');await assertPins(page,'#development-map .map-pin, #development-map .map-practice');
      assert.equal(await page.locator('#development-table,#purchase-table,#lease-table,#property-preview,.detail-view').count(),0);
      assert.ok(await page.locator('a[href^="https://carr.us"]').count()>=2);
      if(input.developments.length){
      await page.locator('.development-tile').first().hover();assert.equal(await page.locator('#project-dialog').isVisible(),false);
      await page.locator('.development-tile').first().click();assert.equal(await page.locator('#project-dialog').isVisible(),true);await page.keyboard.press('Escape');
      assert.equal(await page.locator('.development-tile').first().evaluate(n=>n===document.activeElement),true);
      }
      const transaction=input.properties.length?'purchases':'leases',dir=input.properties.length?'property-directory':'lease-directory';
      await page.locator(`#site-nav a[href="#${transaction}"]`).click();
      await page.locator(`#${transaction}`).waitFor({state:'visible'});
      if(input.properties.length){await page.waitForSelector('#purchase-map[data-map-ready=true]');await assertPins(page,'#purchase-map .map-pin, #purchase-map .map-practice');}
      if(input.currentPractice)assert.equal(await page.locator(`#${input.properties.length?'purchase':'development'}-map .map-practice .pin-stem`).count(),1);
      if(input.market.purchaseScreening?.length)assert.equal(await page.locator('#purchase-screening article').count(),input.market.purchaseScreening.length);
      await page.locator(`#${transaction} .next-action a`).click();await page.locator('#tour').waitFor({state:'visible'});
      await page.locator(`#site-nav a[href="#${transaction}"]`).click();
      await page.locator(`#${transaction}`).waitFor({state:'visible'});
      const cards=await page.locator(`#${dir} .property-jump`).evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y};}));
      if(device==='desktop' && cards.length===4){assert.equal(cards[0].y,cards[1].y);assert.ok(cards[2].y>cards[0].y);assert.equal(cards[2].y,cards[3].y);}
      if(device==='mobile' && cards.length>1)assert.ok(cards[1].y>cards[0].y);
      await page.locator(`#${dir} .property-jump`).first().click();assert.equal(await page.locator('#property-dialog').isVisible(),true);
      assert.match(await page.locator('#property-dialog-content').innerText(),/Property review/);assert.equal(await page.locator('#property-dialog-content a[href*="listing"]').count(),0);
      const label=await page.locator('#property-dialog .property-number').boundingBox(),bar=await page.locator('#property-dialog .project-dialog-bar').boundingBox();assert.ok(label.y>=bar.y+bar.height,'option label below toolbar');
      await page.locator('#property-dialog [data-toggle]').click();await page.keyboard.press('Escape');await page.locator('#site-nav a[href="#tour"]').click();await page.locator("#tour").waitFor({state:"visible"});
      const id=input.properties[0]?.id || input.leases[0].id;assert.equal(await page.locator(`#tour-selected [data-remove="${id}"]`).count(),1);
      const columns=await page.locator('.tour-layout>section').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y};}));assert.ok(device==='desktop'?columns[1].x>columns[0].x:columns[1].y>columns[0].y,JSON.stringify({device,columns}));
      if(device==='desktop') {
        await page.locator('#tour-selected [data-property-id]').first().dragTo(page.locator('#tour-available'));
        assert.equal(await page.locator(`#tour-available [data-add="${id}"]`).count(),1);
        await page.locator(`#tour-available [data-property-id="${id}"]`).dragTo(page.locator('#tour-selected'));
        await page.locator('[data-property-note]').waitFor({state:'visible'});
      }
      await page.locator('[data-property-note]').first().fill('Synthetic per-property note');
      if(input.feedback.mode==='shared') {
        await page.locator('#tour-save').click();await page.waitForFunction(()=>document.querySelector('#tour-save-status').dataset.state==='saved');await page.reload();await page.locator('#site-nav a[href="#tour"]').click();await page.locator("#tour").waitFor({state:"visible"});await page.waitForSelector('[data-property-note]');
        assert.equal(await page.locator('[data-property-note]').first().inputValue(),'Synthetic per-property note');
        await page.locator('[data-property-note]').first().fill('Conflict draft');conflictNext=true;await page.locator('#tour-save').click();await page.waitForFunction(()=>document.querySelector('#tour-save-status').dataset.state==='conflict');
        assert.equal(await page.locator('[data-property-note]').first().inputValue(),'Conflict draft');assert.equal(await page.locator('#tour-save').isDisabled(),true);
        page.on('dialog',d=>d.accept());await page.locator('#tour-reload').click();await page.waitForFunction(()=>document.querySelector('#tour-save-status').dataset.state==='saved');
        failService=true;await page.locator('[data-property-note]').first().fill('Failed save draft');await page.locator('#tour-save').click();await page.waitForFunction(()=>document.querySelector('#tour-save-status').dataset.state==='error');assert.equal(await page.locator('[data-property-note]').first().inputValue(),'Failed save draft');failService=false;
      }
      if(input.strategy.mode==='owner_occupancy_30_70') {
        await page.locator('#site-nav a[href="#strategy"]').click();await page.locator('#strategy').waitFor({state:'visible'});
        const before=await page.locator('#finance-results').innerText();
        await page.locator('input[name="tenant-ti-rate"][value="50"]').check();assert.notEqual(await page.locator('#finance-results').innerText(),before);
        await page.locator('#equity-year').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#equity-year-label').innerText(),'1');
        await page.locator('#line-view').selectOption('carry');assert.equal(await page.locator('#line-property-control').isVisible(),true);
        assert.match(await page.locator('.ownership-line-svg').getAttribute('aria-label'),/Equity and cash carry/);
        await page.locator('#finance-property').selectOption(input.properties[1].id);assert.match(await page.locator('#strategy-table').innerText(),new RegExp(input.properties[1].name));
      }
      for(const id of ['home',transaction,...(input.strategy.mode==='owner_occupancy_30_70'?['strategy']:[]),'tour','demographics','sources']) {
        await page.locator(`#site-nav a[href="#${id}"]`).click();await page.locator(`#${id}`).waitFor({state:"visible"});assert.equal(await page.locator('.site-view:visible').count(),1);await page.evaluate(()=>scrollTo(0,350));
        const boxes=await page.locator('.site-header,.sticky-page-title').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{top:b.top,bottom:b.bottom};}));assert.ok(boxes[1].top>=boxes[0].bottom-1,`${device} ${id} sticky heading overlaps masthead ${JSON.stringify(boxes)}`);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${device} page overflow`);
        if(screenshots){await fs.mkdir(screenshots,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(screenshots,`${device}-${id}.png`),fullPage:true});}
      }
      await page.locator('#site-nav a[href="#demographics"]').click();assert.match(await page.locator('.income-summary').innerText(),/Median household income/);
      const boxes=await page.locator('#demographic-charts .visual-card').evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom};}));
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];assert.ok(a.right<=b.x || b.right<=a.x || a.bottom<=b.y || b.bottom<=a.y,'demographic cards overlap');}
      assert.equal(await page.locator('.property-jump').first().evaluate(n=>getComputedStyle(n).transitionDuration),'0s');
      if(negativeChecks && device==='desktop' && input.properties.length>1) {
        await page.locator('#site-nav a[href="#purchases"]').click();await page.evaluate(()=>document.querySelector('#purchase-map .map-pin').style.visibility='hidden');await assert.rejects(assertPins(page,'#purchase-map .map-pin'),/hidden, clipped or covered/);
        await page.evaluate(()=>{const p=document.querySelectorAll('#purchase-map .map-pin');p[0].style.visibility='visible';p[1].style.transform=p[0].style.transform;});await assert.rejects(assertPins(page,'#purchase-map .map-pin'),/overlap|hidden, clipped or covered/);
        results.push({device,check:'hidden-and-overlapping-pin-negative-controls',passed:true});
      }
      assert.deepEqual(errors,[],`${device} browser exceptions`);
      results.push({device,check:'navigation-grid-sticky-dialog-selection-demographics-reduced-motion',passed:true});await context.close();
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
  return{schema:'presentation-browser-acceptance/v1',engine:'playwright@1.63.0',runtime:'chromium',syntheticAdapter:true,results};
}
export async function qualifyFixtures({screenshots}={}) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'presentation-browser-')),runs=[];
  for(const name of ['owner-occupancy','owner-occupancy-30-70','lease-only']) {
    const data=JSON.parse(await fs.readFile(path.join(root,'test/fixtures',`${name}.json`),'utf8'));
    data.feedback={mode:'shared',endpoint:'/api/selection'};data.locator.style={version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#edf2f7'}}]};
    if(data.strategy.mode==='owner_occupancy_30_70'){data.strategy.tiRange={min:0,max:100,step:50};data.strategy.tiContributionPerSf=0;}
    if(name==='owner-occupancy')data.currentPractice.locator={...data.properties[0].locator};
    for(const entity of [...data.properties,...data.leases,...data.developments])entity.image='synthetic.png';
    const input=path.join(temporary,`${name}.json`),output=path.join(temporary,name);await fs.writeFile(path.join(temporary,'synthetic.png'),png);await fs.writeFile(input,JSON.stringify(data));await build(input,output);
    runs.push({fixture:name,...await acceptBrowserSite({directory:output,offlineFixture:true,screenshots:screenshots && path.join(screenshots,name)})});
  }
  return runs;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await qualifyFixtures({screenshots:process.env.PRESENTATION_SCREENSHOTS})));}catch(error){console.error(error.stack);process.exitCode=1;}
}
