const fs = require('node:fs');
const path = require('node:path');
function nextVersion(version, kind = 'build') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('La versión debe tener el formato MAYOR.MENOR.BUILD.');
  const [major, minor, build] = version.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.${build + 1}`;
  if (kind === 'build') return `${major}.${minor}.${build + 1}`;
  throw Error('Tipo de incremento no compatible: ' + kind);
}
function setVersion(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Versión no válida.');
  const manifest = path.join(root, 'package.json'), lockFile = path.join(root, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  pkg.version = version; lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  fs.writeFileSync(path.join(root, "src/shared/version.js"), `// Generated from package.json by scripts/version.cjs.\nObject.defineProperty(window, 'simpleMixVersion', { value: '${version}', writable: false });\n`);
}
if (require.main === module) {
  const root = path.join(__dirname, '..'), args = process.argv.slice(2), pkg = require('../package.json');
  const kind = args.find(arg => !arg.startsWith('--')) || 'build';
  const next = nextVersion(pkg.version, kind);
  if (!args.includes('--dry-run')) setVersion(root, next);
  console.log(`${pkg.version} → ${next}${args.includes('--dry-run') ? ' (sin modificar archivos)' : ''}`);
}
module.exports = { nextVersion, setVersion };
