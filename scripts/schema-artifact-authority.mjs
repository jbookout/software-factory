// Repository schema policy only: each ref/digest contract has one local owner.
// Walk schema positions, never annotations or instance data such as examples.
const maps = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']
const lists = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
const singles = ['items', 'contains', 'additionalProperties', 'unevaluatedProperties',
  'propertyNames', 'not', 'if', 'then', 'else', 'additionalItems', 'unevaluatedItems']
const escape = key => key.replaceAll('~', '~0').replaceAll('/', '~1')
const isArtifact = node => node?.type === 'object' &&
  Array.isArray(node.required) && node.required.length === 2 && node.required.includes('ref') && node.required.includes('digest') &&
  Object.keys(node.properties ?? {}).length === 2 &&
  Object.hasOwn(node.properties ?? {}, 'ref') && Object.hasOwn(node.properties ?? {}, 'digest')

export function artifactAuthorityFindings(schema) {
  const findings = [], definitions = [], references = []
  const walk = (node, pointer) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    if (isArtifact(node)) definitions.push(pointer)
    if (node.$ref === '#/$defs/artifact') references.push(pointer)
    for (const keyword of maps) for (const [key, child] of Object.entries(node[keyword] ?? {})) {
      walk(child, `${pointer}/${keyword}/${escape(key)}`)
    }
    for (const keyword of lists) if (Array.isArray(node[keyword])) {
      node[keyword].forEach((child, index) => walk(child, `${pointer}/${keyword}/${index}`))
    }
    for (const keyword of singles) walk(node[keyword], `${pointer}/${keyword}`)
  }
  walk(schema, '')
  const canonical = '/$defs/artifact'
  if (!definitions.length && !references.length && !Object.hasOwn(schema.$defs ?? {}, 'artifact')) return []
  if (!definitions.includes(canonical)) findings.push({ pointer: canonical,
    remediation: 'Define the ref/digest contract once at #/$defs/artifact.' })
  for (const pointer of definitions.filter(pointer => pointer !== canonical)) findings.push({ pointer,
    remediation: 'Reference #/$defs/artifact instead of defining another ref/digest contract.' })
  if (definitions.length === 1 && definitions.includes(canonical) && !references.length) findings.push({ pointer: canonical,
    remediation: 'Use #/$defs/artifact at artifact fields; remove an unused definition.' })
  return findings
}
