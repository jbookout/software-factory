import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('finish line covers the scope exactly once and starts with the approved priorities', async () => {
  const scope = JSON.parse(await readFile(new URL('../factory.scope.json', import.meta.url), 'utf8'))
  const document = await readFile(new URL('../docs/finish-line.md', import.meta.url), 'utf8')
  const rows = document.split('\n').filter(line => /^\| \d+ \| `/.test(line))
  const ids = rows.map(line => line.split('|')[2].trim().match(/^`([^`]+)`/)[1])
  const expected = [...scope.capabilities.map(({ id }) => id), 'pr-delivery-loop', 'design-manager']
  assert.equal(ids.length, new Set(ids).size, 'duplicate finish-line row')
  assert.deepEqual([...ids].sort(), expected.sort(), 'missing or undeclared finish-line row')
  assert.deepEqual(ids.slice(0, 2), ['pr-delivery-loop', 'design-manager'])
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    assert.equal(cells.length, 7, `expected all finish-line columns: ${row}`)
    assert.ok(cells.every(Boolean), `empty finish-line cell: ${row}`)
  }
})
