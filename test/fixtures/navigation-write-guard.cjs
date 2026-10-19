const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const block = name => (...args) => {
  process.stderr.write(`WRITE_ATTEMPT ${name}\n`);
  throw Object.assign(new Error(`write forbidden: ${name}`), { code: 'EROFS' });
};
for (const name of ['appendFile', 'writeFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'link', 'symlink', 'chmod', 'chown', 'lchmod', 'lchown', 'utimes', 'lutimes', 'truncate', 'write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes']) {
  if (fsp[name]) fsp[name] = block(name);
  if (fs[name]) fs[name] = block(name);
  if (fs[`${name}Sync`]) fs[`${name}Sync`] = block(`${name}Sync`);
}
const writable = flags => typeof flags === 'number'
  ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
  : /[wa+]/.test(flags);
for (const [target, name] of [[fs, 'open'], [fs, 'openSync'], [fsp, 'open']]) {
  const original = target[name];
  target[name] = function (file, flags, ...args) {
    if (writable(flags)) return block(name)(file, flags, ...args);
    return original.call(this, file, flags, ...args);
  };
}
fs.createWriteStream = block('createWriteStream');
syncBuiltinESMExports();
