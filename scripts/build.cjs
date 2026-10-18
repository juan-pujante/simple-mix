const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nextVersion, setVersion } = require('./version.cjs');
const root = path.join(__dirname, '..'), pkg = require('../package.json');
const args = process.argv.slice(2), selected = ['--major', '--minor', '--keep-version'].filter(flag => args.includes(flag));
if (selected.length > 1) { console.error('Usa solo una opción: --major, --minor o --keep-version.'); process.exit(1); }
const keep = args.includes('--keep-version'), kind = args.includes('--major') ? 'major' : args.includes('--minor') ? 'minor' : 'build';
const version = keep ? pkg.version : nextVersion(pkg.version, kind);
setVersion(root, version);
console.log(`Simple Mix ${version}${keep ? ' · reconstrucción de la misma versión' : ' · ' + kind}`);
const forwarded = args.filter(arg => !['--major', '--minor', '--keep-version'].includes(arg));
if (!forwarded.some(arg => arg.startsWith('--config.directories.output='))) forwarded.push(`--config.directories.output=dist/${version}`);
const requestedArch = forwarded.includes('--x64') ? 'x64' : forwarded.includes('--arm64') ? 'arm64' : process.arch;
const ffmpeg = spawnSync(process.execPath, [path.join(__dirname, 'build-ffmpeg.cjs')], { cwd: root, env: { ...process.env, SIMPLEMIX_FFMPEG_ARCH: requestedArch }, stdio: 'inherit' });
if (ffmpeg.error) { console.error(ffmpeg.error.message); process.exit(1); }
if (ffmpeg.status !== 0) process.exit(ffmpeg.status ?? 1);
const builder = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [builder, '--publish', 'never', ...forwarded], { cwd: root, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
