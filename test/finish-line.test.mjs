import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { lexer } from 'marked'

const scope = JSON.parse(await readFile(new URL('../factory.scope.json', import.meta.url), 'utf8'))
const document = await readFile(new URL('../docs/finish-line.md', import.meta.url), 'utf8')
const expected = [...scope.capabilities.map(({ id }) => id), 'pr-delivery-loop', 'design-manager']

function checkFinishLine(document) {
  const headers = ['Order', 'Capability', 'What it is', 'Current state and proof file',
    'Done test: command, fixture, expected result', 'Dependencies', 'Remaining working days']
  const tables = lexer(document, { gfm: true }).filter(token => token.type === 'table' &&
    token.header[0]?.text === 'Order' && token.header[1]?.text === 'Capability')
  assert.equal(tables.length, 1, 'expected one rendered finish-line table')
  const table = tables[0]
  assert.deepEqual(table.header.map(cell => cell.text), headers, 'expected all finish-line columns')
  const ids = table.rows.map(cells => {
    assert.equal(cells.length, headers.length, 'expected all finish-line columns')
    assert.ok(cells.every(cell => cell.text.trim()), 'empty finish-line cell')
    assert.match(cells[0].text, /^\d+$/, 'expected numeric finish-line order')
    const capability = cells[1].tokens[0]
    assert.equal(capability?.type, 'codespan', 'expected capability ID at start of cell')
    return capability.text
  })
  assert.equal(ids.length, new Set(ids).size, 'duplicate finish-line row')
  assert.deepEqual([...ids].sort(), [...expected].sort(), 'missing or undeclared finish-line row')
  assert.deepEqual(ids.slice(0, 2), ['pr-delivery-loop', 'design-manager'])
}

test('finish line covers the scope exactly once and starts with the approved priorities', () => {
  checkFinishLine(document)
})

const dataRow = /^\| \d+ \| `/
const lines = document.split('\n')
const rows = lines.filter(line => dataRow.test(line))
const firstRow = rows[0]
const lastRow = rows.at(-1)

for (const [name, extra] of [
  ['duplicate', firstRow.replace('| 1 |', '| 22|')],
  ['undeclared', firstRow.replace('| 1 |', '| 22|').replace('`pr-delivery-loop`', '`undeclared-capability`')]
]) {
  test(`finish line rejects a compact-spaced ${name} table row`, () => {
    assert.throws(() => checkFinishLine(document.replace(lastRow, `${lastRow}\n${extra}`)))
  })
}

for (const fence of ['```', '~~~~']) {
  test(`finish line rejects coverage found only inside a ${fence} fence`, () => {
    const withoutRows = lines.filter(line => !dataRow.test(line)).join('\n')
    assert.throws(() => checkFinishLine(`${withoutRows}\n${fence}text\n${rows.join('\n')}\n${fence}\n`))
  })
}

test('finish line accepts rendered rows with compact delimiter spacing', () => {
  checkFinishLine(document.replaceAll('| 1 |', '|1|'))
})

test('finish line accepts rendered rows without outer delimiters', () => {
  checkFinishLine(lines.map(line => line.startsWith('|') ? line.slice(1, -1) : line).join('\n'))
})

test('finish line ignores table lookalikes inside a fenced example', () => {
  checkFinishLine(`${document}\n\`\`\`text\n${rows.join('\n')}\n\`\`\`\n`)
})

for (const [name, fixture] of [
  ['missing row', document.replace(firstRow, '')],
  ['duplicate row', document.replace(lastRow, `${lastRow}\n${firstRow}`)],
  ['undeclared row', document.replace('`pr-delivery-loop`', '`undeclared-capability`')],
  ['empty cell', document.replace(firstRow, firstRow.replace('| 8–12 |', '| |'))],
  ['missing table header', document.replace(/^\| Order \|.*\n/m, '')],
  ['malformed extra row', document.replace(lastRow, `${lastRow}\n${firstRow.replace('| 1 |', '| bogus |')}`)]
]) {
  test(`finish line rejects ${name}`, () => {
    assert.throws(() => checkFinishLine(fixture))
  })
}
