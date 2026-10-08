import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {runProcess} from '../../src/process-runner.mjs'

export const VERSION='1.80.0'
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const tool=fileURLToPath(new URL('./tool/',import.meta.url))
const platforms={'darwin-arm64':'@oxlint/binding-darwin-arm64','linux-x64':'@oxlint/binding-linux-x64-gnu'}
export function validateToolLock(lock){
 assert.equal(lock.lockfileVersion,3,'frozen tool lock required')
 assert.equal(lock.packages[''].dependencies.oxlint,VERSION,'root tool pin changed')
 for(const [location,row] of Object.entries(lock.packages)){
  if(!location)continue
  const name=location.replace(/^node_modules\//,'')
  assert(name==='oxlint'||/^@oxlint\/binding-[a-z0-9-]+$/.test(name),'unexpected tool dependency')
  assert.equal(row.version,VERSION,'tool version mismatch')
  const expected='https://registry.npmjs.org/'+name+'/-/'+name.split('/').at(-1)+'-'+VERSION+'.tgz'
  assert.equal(row.resolved,expected,'non-official tool artifact')
  assert.match(row.integrity,/^sha512-[A-Za-z0-9+/]{86}==$/,'tool integrity missing')
 }
 assert(lock.packages['node_modules/oxlint'],'tool missing')
 for(const name of Object.values(platforms))assert(lock.packages['node_modules/'+name],'qualified platform pin missing')
}
async function execute(argv,cwd){
 const result=await runProcess(argv,{cwd,env:{PATH:process.env.PATH,LANG:'C.UTF-8'},timeoutMs:120000})
 if(result.code!==0)throw new Error('tool command failed ('+result.code+'): '+result.stderr.slice(0,500))
 return result.stdout
}
export async function installOxlint(directory){
 const binding=platforms[process.platform+'-'+process.arch]
 assert(binding,'unsupported qualification platform')
 const lockBytes=await fs.readFile(path.join(tool,'package-lock.json'))
 validateToolLock(JSON.parse(lockBytes))
 await fs.mkdir(directory)
 const npm=path.join(directory,'npm'),cache=path.join(directory,'cache')
 await fs.mkdir(npm)
 for(const name of ['package.json','package-lock.json'])await fs.copyFile(path.join(tool,name),path.join(npm,name))
 const user=path.join(directory,'user.npmrc'),global=path.join(directory,'global.npmrc')
 await fs.writeFile(user,'',{flag:'wx',mode:0o600});await fs.writeFile(global,'',{flag:'wx',mode:0o600})
 const started=performance.now()
 const log=await execute(['npm','ci','--prefix',npm,'--cache',cache,'--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org','--userconfig='+user,'--globalconfig='+global],directory)
 await fs.writeFile(path.join(directory,'install.log'),log,{flag:'wx',mode:0o600})
 const packageRoot=path.join(npm,'node_modules','oxlint')
 assert.equal(JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'))).version,VERSION)
 const nativeRoot=path.join(npm,'node_modules',binding)
 const nativePackage=JSON.parse(await fs.readFile(path.join(nativeRoot,'package.json')))
 assert.equal(nativePackage.version,VERSION)
 const native=path.resolve(nativeRoot,nativePackage.main)
 assert(native.startsWith(nativeRoot+path.sep),'binding escaped package')
 assert((await fs.lstat(native)).isFile(),'binding must be regular')
 const architecture=await execute(['file','-b',native],directory)
 assert((process.platform==='darwin'?/Mach-O.*arm64/:/ELF.*x86-64/).test(architecture),'native architecture mismatch')
 const command=[process.execPath,path.join(packageRoot,'bin','oxlint')]
 assert.equal((await execute([...command,'--version'],directory)).trim(),'Version: '+VERSION)
 return {command,receipt:{version:VERSION,platform:process.platform,architecture:process.arch,
  distribution:'official npm frozen lock',lockDigest:sha(lockBytes),nativeBinding:binding,nativeDigest:sha(await fs.readFile(native)),
  lifecycleScripts:false,installMs:performance.now()-started,log:'installer/install.log',logDigest:sha(log),
  cacheLimits:'Fresh owned npm target/cache. Host DNS/TLS/filesystem and upstream caches are uncontrolled.'}}
}
