import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { parse } from 'yaml'
import { compile } from 'tailwindcss'

const require = createRequire(import.meta.url)
const packageRoot = path.dirname(require.resolve('tailwindcss/index.css'))
function syntax(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
  assert.equal(source.parseDiagnostics.length, 0, 'source must parse')
  function visit(node) {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression)
    const children = []; ts.forEachChild(node, child => { children.push(visit(child)) })
    const value = ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node) ? node.text : null
    return [ts.SyntaxKind[node.kind], value, children]
  }
  return visit(source)
}
async function loadStylesheet(id, base) {
  const file = await fs.realpath(id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : path.resolve(base, id))
  assert(file.startsWith(packageRoot + path.sep), 'only pinned Tailwind stylesheet imports qualify')
  return { path: file, base: path.dirname(file), content: await fs.readFile(file, 'utf8') }
}

/** A bounded fixture comparison, never a proof for arbitrary repository files. */
export async function assertSemanticParity(kind, before, after, filename) {
  if (['js', 'mjs', 'ts', 'tsx'].includes(kind)) {
    assert.deepEqual(syntax(before, filename), syntax(after, filename))
    // JSX text whitespace is interpreted by the compiler, not raw AST text.
    // Compare emitted JSX calls as well so changed visible text cannot disappear.
    if (kind === 'tsx') {
      const emit = text => ts.transpileModule(text, { fileName: filename,
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      assert.deepEqual(syntax(emit(before), 'emitted.js'), syntax(emit(after), 'emitted.js'))
    }
  }
  else if (kind === 'json') assert.deepEqual(JSON.parse(before), JSON.parse(after))
  else if (kind === 'yaml') assert.deepEqual(parse(before), parse(after))
  else if (kind === 'css') {
    const a = await compile(before, { loadStylesheet }), b = await compile(after, { loadStylesheet })
    const candidates = ['bg-primary', 'text-primary-foreground', 'p-4', 'flex']
    assert.equal(a.build(candidates), b.build(candidates))
  } else throw new Error(`no semantic comparator for ${kind}`)
}
