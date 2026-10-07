import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

/** Compare the declared task fixture's actual routes and persisted interaction. */
export async function assertHtmlParity(before, after) {
  const { chromium } = await import('../agentic-ui-evaluation/fixture/node_modules/playwright/index.mjs')
  const copies = { before, after }, hash = b => createHash('sha256').update(b).digest('hex')
  const server = createServer((req, res) => {
    const key = new URL(req.url, 'http://localhost').searchParams.get('copy')
    if (!Object.hasOwn(copies, key)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'")
    res.end(copies[key])
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, rows = []; let browser
  try {
    browser = await chromium.launch({ headless: true })
    async function pageFor(key, route) {
      const context = await browser.newContext({ viewport: { width: 900, height: 650 }, serviceWorkers: 'block' })
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
      const page = await context.newPage()
      await page.goto(origin + route + (route.includes('?') ? '&' : '?') + 'copy=' + key)
      return { context, page }
    }
    for (const route of ['/', '/?filter=done', '/?filter=archived', '/admin', '/help']) {
      const results = {}
      for (const key of ['before', 'after']) {
        const { context, page } = await pageFor(key, route)
        try {
          if (route.includes('archived')) await page.getByText('No archived tasks', { exact: true }).waitFor()
          results[key] = { text: await page.locator('body').innerText(),
            screenshot: hash(await page.screenshot({ animations: 'disabled' })) }
        } finally { await context.close() }
      }
      assert.deepEqual(results.before, results.after, `HTML render changed: ${route}`)
      rows.push({ route, screenshotDigest: results.after.screenshot })
    }
    const saved = {}
    for (const key of ['before', 'after']) {
      const { context, page } = await pageFor(key, '/')
      try {
        assert.equal(await page.locator('ul li').count(), 2)
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        assert.equal(await page.getByRole('alert').innerText(), 'Title required')
        await page.locator('#title').fill('Bounded formatter check')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        assert.equal(await page.getByTestId('success').isVisible(), true)
        saved[key] = await page.evaluate(() => JSON.parse(localStorage.getItem('tasks')))
        assert.deepEqual(saved[key].at(-1), { title: 'Bounded formatter check', done: false })
        await page.reload(); assert.equal(await page.locator('ul li').count(), 3)
      } finally { await context.close() }
    }
    assert.deepEqual(saved.before, saved.after)
    return { routes: rows, blankValidation: true, saveAndIndependentStoredRead: true, reloadTaskCount: 3 }
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}
