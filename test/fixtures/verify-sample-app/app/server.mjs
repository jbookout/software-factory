// Sample task app. Starts only with --serve so a test runner can import-scan this file.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { addTask, normalizeTitle } from './lib.mjs'

const args = process.argv.slice(2)
if (args[0] === '--serve') {
  const dataFile = args[args.indexOf('--data') + 1]
  const build = JSON.parse(readFileSync(new URL('./build.json', import.meta.url), 'utf8'))
  let tasks = []
  try { tasks = JSON.parse(readFileSync(dataFile, 'utf8')) } catch { /* Start empty. */ }
  const persist = () => fs.writeFile(dataFile, JSON.stringify(tasks))
  const escape = text => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
  const page = body => `<!doctype html><html lang="en"><body>${body}</body></html>`
  const form = (id, action) => `<form id="${id}" method="post" action="${action}">` +
    '<label>Title <input name="title"></label><button type="submit">Add</button></form>'
  const send = (res, status, body, type = 'text/html') => {
    res.writeHead(status, { 'content-type': type })
    res.end(body)
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://sample.invalid')
    if (req.method === 'GET' && url.pathname === '/health')
      return send(res, 200, JSON.stringify({ ...build, pid: process.pid }), 'application/json')
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page(form('add-task', '/tasks')))
    if (req.method === 'GET' && url.pathname === '/quick-add') return send(res, 200, page(form('quick-add', '/tasks?via=quick-add')))
    if (req.method === 'GET' && url.pathname === '/tasks') return send(res, 200, page(tasks.length
      ? `<ul id="tasks">${tasks.map(task => `<li>${escape(task.title)}</li>`).join('')}</ul>`
      : '<p id="empty">No tasks yet. Add one from the home page.</p>'))
    if (req.method === 'POST' && url.pathname === '/tasks') {
      let body = ''
      for await (const chunk of req) body += chunk
      const title = normalizeTitle(new URLSearchParams(body).get('title'))
      if (!title) return send(res, 422, page('<p id="error">Title is required.</p>'))
      tasks = addTask(tasks, title)
      await persist()
      res.writeHead(303, { location: '/tasks' })
      return res.end()
    }
    send(res, 404, page('<p>Not found</p>'))
  })
  server.listen(0, '127.0.0.1', () => console.log(`listening ${server.address().port}`))
}
