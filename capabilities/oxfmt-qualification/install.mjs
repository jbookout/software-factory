import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../../src/process-runner.mjs'

export const VERSION = '0.72.0'
const assets = {
  'darwin-arm64': ['aarch64-apple-darwin', '7ec5c56444c116cbcda08277537e109900b17e335d07d7798e7b124cf8e34c86'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '79ac743aa36a91c26e54caa649ed64150ea4f8d36a60518424f156d67d55fe73']
}
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const tool = fileURLToPath(new URL('./tool/', import.meta.url))
const cleanEnv = () => ({ PATH: process.env.PATH, LANG: 'C.UTF-8' })

async function execute(argv, cwd) {
  const result = await runProcess(argv, { cwd, env: cleanEnv(), timeoutMs: 120000 })
  if (result.code !== 0) throw new Error(`tool installation failed (${result.code}): ${result.stderr.slice(0, 500)}`)
  return result.stdout
}

// tarfile supplies the archive parser. Never extract paths or links from an archive:
// read the single expected regular member and create our chosen output exclusively.
const extract = `import os,sys,tarfile
with tarfile.open(sys.argv[1]) as archive:
 members=archive.getmembers()
 if len(members)!=1 or members[0].name!=sys.argv[2] or not members[0].isfile() or members[0].size>20000000:
  raise ValueError('unexpected release archive member')
 data=archive.extractfile(members[0]).read()
 fd=os.open(sys.argv[3],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700)
 with os.fdopen(fd,'wb') as output: output.write(data)
`

export async function extractPinnedArchive(bytes, { member, digest }, directory) {
  if (sha(bytes) !== digest) throw new Error('release archive digest mismatch')
  await fs.mkdir(directory)
  const archive = path.join(directory, 'release.tar.gz'), binary = path.join(directory, 'oxfmt')
  await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
  await execute(['python3', '-c', extract, archive, member, binary], directory)
  return binary
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`official release download failed (${response.status})`)
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 16000000) throw new Error('release archive exceeds limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Install both pinned distributions into a new caller-owned directory. */
export async function installOxfmt({ directory, archiveCache, npmCache }) {
  const asset = assets[`${process.platform}-${process.arch}`]
  if (!asset) throw new Error(`native trial platform not qualified: ${process.platform}-${process.arch}`)
  await fs.mkdir(directory)
  const [target, digest] = asset, member = `oxfmt-${target}`
  const url = `https://github.com/oxc-project/oxc/releases/download/oxfmt_v${VERSION}/${member}.tar.gz`
  const started = performance.now()
  let bytes, archiveReused = false
  try {
    if (!(await fs.lstat(archiveCache)).isFile()) throw new Error('archive cache is not a regular file')
    bytes = await fs.readFile(archiveCache); archiveReused = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    bytes = await download(url)
    if (sha(bytes) !== digest) throw new Error('release archive digest mismatch')
    await fs.writeFile(archiveCache, bytes, { flag: 'wx', mode: 0o600 })
  }
  const native = await extractPinnedArchive(bytes, { member, digest }, path.join(directory, 'native'))
  const architecture = await execute(['file', '-b', native], directory)
  if (!(process.platform === 'darwin' ? /Mach-O.*arm64/ : /ELF.*x86-64/).test(architecture))
    throw new Error('native executable architecture mismatch')
  if ((await execute([native, '--version'], directory)).trim() !== `Version: ${VERSION}`)
    throw new Error('native version mismatch')
  const nativeMs = performance.now() - started
  const npmStarted = performance.now(), npm = path.join(directory, 'npm')
  await fs.mkdir(npm)
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(tool, name), path.join(npm, name))
  const cacheReused = await fs.stat(npmCache).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  const userConfig = path.join(directory, 'npm-user.npmrc'), globalConfig = path.join(directory, 'npm-global.npmrc')
  await fs.writeFile(userConfig, '', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 })
  const installLog = await execute(['npm', 'ci', '--prefix', npm, '--cache', npmCache, '--ignore-scripts',
    '--no-audit', '--no-fund', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, '--registry=https://registry.npmjs.org/'], directory)
  await fs.writeFile(path.join(directory, 'npm-install.log'), installLog)
  const lock = JSON.parse(await fs.readFile(path.join(npm, 'package-lock.json')))
  const installed = JSON.parse(await fs.readFile(path.join(npm, 'node_modules/oxfmt/package.json')))
  if (installed.version !== VERSION || lock.packages['node_modules/oxfmt'].version !== VERSION)
    throw new Error('npm version binding mismatch')
  const npmCommand = [process.execPath, path.join(npm, 'node_modules/oxfmt/bin/oxfmt')]
  if ((await execute([...npmCommand, '--version'], directory)).trim() !== `Version: ${VERSION}`)
    throw new Error('npm CLI version mismatch')
  return { commands: { native: [native], npm: npmCommand }, receipt: {
    version: VERSION, platform: process.platform, architecture: process.arch,
    native: { url, sha256: digest, archiveReused, installMs: nativeMs },
    npm: { lockDigest: sha(await fs.readFile(path.join(tool, 'package-lock.json'))), cacheReused,
      installMs: performance.now() - npmStarted, lifecycleScripts: false },
    cacheLimits: 'Fresh owned targets; first npm cache is fresh, second reused. Host DNS/TLS/filesystem and upstream caches are uncontrolled; this is not a hardware cold-start benchmark.'
  } }
}
