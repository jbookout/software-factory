import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { artifactAuthorityFindings } from '../scripts/schema-artifact-authority.mjs'

const artifact = {
  type: 'object', additionalProperties: false, required: ['ref', 'digest'],
  properties: { ref: { type: 'string' }, digest: { type: 'string' } }
}
const schema = () => ({
  $defs: { artifact: structuredClone(artifact) },
  properties: { proof: { $ref: '#/$defs/artifact' } }
})

test('artifact authority accepts references and schemas with no artifact contract', () => {
  assert.deepEqual(artifactAuthorityFindings(schema()), [])
  assert.deepEqual(artifactAuthorityFindings({ type: 'object' }), [])
})

test('artifact authority rejects a second rule even when its constraints differ', () => {
  const input = schema()
  input.properties.proof = structuredClone(artifact)
  input.properties.proof.properties.ref.minLength = 3
  assert.deepEqual(artifactAuthorityFindings(input), [{
    pointer: '/properties/proof',
    remediation: 'Reference #/$defs/artifact instead of defining another ref/digest contract.'
  }])
})

test('artifact authority finds copies inside arrays, alternatives and other definitions', () => {
  const input = schema()
  input.$defs.copy = structuredClone(artifact)
  input.properties.proofs = { type: 'array', items: { anyOf: [artifact, { type: 'null' }] } }
  assert.deepEqual(artifactAuthorityFindings(input).map(f => f.pointer),
    ['/$defs/copy', '/properties/proofs/items/anyOf/0'])
})

test('artifact authority rejects a removed, unused or malformed canonical definition', () => {
  for (const [mutate, remediation] of [
    [input => { delete input.$defs.artifact },
      'Define the ref/digest contract once at #/$defs/artifact.'],
    [input => { input.properties = {} },
      'Use #/$defs/artifact at artifact fields; remove an unused definition.'],
    [input => { input.$defs.artifact = { type: 'string' } },
      'Define the ref/digest contract once at #/$defs/artifact.']
  ]) {
    const input = schema()
    mutate(input)
    assert.deepEqual(artifactAuthorityFindings(input), [{ pointer: '/$defs/artifact', remediation }])
  }
})

test('instance data and annotations resembling artifact definitions are not schema rules', () => {
  const input = schema()
  input.examples = [artifact]
  input.default = artifact
  input.properties.proof.const = artifact
  input.$defs.evidence = { ...artifact, required: ['ref', 'digest', 'outcome'],
    properties: { ...artifact.properties, outcome: { type: 'string' } } }
  assert.deepEqual(artifactAuthorityFindings(input), [])
})

test('repository artifact schemas keep one used authority per contract', async () => {
  const directory = new URL('../schemas/', import.meta.url)
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.schema.json'))) {
    const input = JSON.parse(await readFile(new URL(name, directory), 'utf8'))
    assert.deepEqual(artifactAuthorityFindings(input), [], `${name}: duplicated or missing artifact authority`)
  }
})
