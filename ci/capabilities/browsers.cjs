const assert = require('node:assert/strict');
const {chromium, webkit} = require('/opt/playwright/node_modules/playwright');
assert.equal(require('/opt/playwright/node_modules/playwright/package.json').version, process.argv[2]);
(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({headless: true, args: engine === chromium ? ['--no-sandbox', '--disable-dev-shm-usage'] : []});
    try {
      const page = await browser.newPage();
      await page.setContent('<title>offline-image-ok</title>');
      assert.equal(await page.title(), 'offline-image-ok');
    } finally {
      await browser.close();
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
