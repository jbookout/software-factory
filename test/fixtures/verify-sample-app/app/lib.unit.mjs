import test from 'node:test'
import assert from 'node:assert/strict'
import { addTask, normalizeTitle } from './lib.mjs'

test('sample unit: titles are normalized and tasks are appended', () => {
  assert.equal(normalizeTitle('  Buy   milk '), 'Buy milk')
  assert.equal(normalizeTitle(undefined), '')
  assert.deepEqual(addTask([], 'Buy milk'), [{ id: 1, title: 'Buy milk' }])
})
