import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const edit of ['notes', 'selection']) {
  test(`edits to ${edit} during a save remain unsaved and can be saved afterward`, async () => {
    const data = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/owner-occupancy.json'), 'utf8'));
    data.feedback = {mode: 'shared', endpoint: '/api/selection'};
    const server = createServer(async (request, response) => {
      try {
        const name = path.basename(request.url === '/' ? 'index.html' : request.url);
        response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
        response.end(name === 'data.js' ? 'window.PresentationData=' + JSON.stringify(data) : await fs.readFile(path.join(root, 'assets/site', name)));
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser, release, received;
    const held = new Promise(resolve => { release = resolve; });
    const dispatched = new Promise(resolve => { received = resolve; });
    let state = {version: 0, selected_ids: [], notes: '', property_notes: {}, updated_at: null, csrf_token: 'synthetic-0'};
    try {
      browser = await chromium.launch({headless: true});
      const page = await browser.newPage();
      await page.route('https://**', route => route.abort());
      await page.route('**/api/selection', async route => {
        if (route.request().method() === 'GET') return route.fulfill({json: state});
        const update = route.request().postDataJSON();
        if (update.version !== state.version || route.request().headers()['x-csrf-token'] !== state.csrf_token) {
          return route.fulfill({status: 409, json: {current: state}});
        }
        if (state.version === 0) { received(); await held; }
        state = {...state, ...update, version: state.version + 1, csrf_token: `synthetic-${state.version + 1}`, updated_at: '2026-10-07T12:00:00Z'};
        await route.fulfill({json: state});
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(() => document.querySelector('#tour-save-status').dataset.state === 'saved');
      await page.locator('#site-nav a[href="#tour"]').click();
      const first = data.properties[0].id, second = data.properties[1].id;
      await page.locator(`[data-add="${first}"]`).click();
      await page.locator('[data-property-note]').fill('Submitted note');
      await page.locator('#tour-save').click();
      await dispatched;
      if (edit === 'selection') {
        await page.locator(`[data-remove="${first}"]`).click();
        await page.locator(`[data-add="${second}"]`).click();
      }
      await page.locator('[data-property-note]').fill('Newer unsaved note');
      const draft = await page.locator('[data-property-note]').elementHandle();
      release();
      await page.waitForFunction(node => !node.isConnected, draft);
      assert.equal(await page.locator('[data-property-note]').inputValue(), 'Newer unsaved note');
      assert.deepEqual(await page.locator('#tour-selected [data-property-id]').evaluateAll(nodes => nodes.map(node => node.dataset.propertyId)), [edit === 'selection' ? second : first]);
      assert.equal(await page.locator('#tour-save-status').getAttribute('data-state'), 'dirty');
      assert.equal(await page.locator('#tour-save').isEnabled(), true);
      await page.locator('#tour-save').click();
      await page.waitForFunction(() => document.querySelector('#tour-save-status').dataset.state === 'saved');
      assert.equal(state.version, 2, 'the second save uses the acknowledged version and rotated token');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#tour-save-status').dataset.state === 'saved');
      await page.locator('#site-nav a[href="#tour"]').click();
      assert.equal(await page.locator('[data-property-note]').inputValue(), 'Newer unsaved note');
      assert.deepEqual(await page.locator('#tour-selected [data-property-id]').evaluateAll(nodes => nodes.map(node => node.dataset.propertyId)), [edit === 'selection' ? second : first]);
      assert.equal(await page.locator('#tour-save').isDisabled(), true);
    } finally {
      release();
      await browser?.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
