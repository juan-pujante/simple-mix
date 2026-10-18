const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const buildDir = path.join(__dirname, 'ffmpeg-build');
const ffmpegVersion = '8.1.2';
const lameVersion = '3.100';
const sources = [
  { file: `ffmpeg-${ffmpegVersion}.tar.gz`, url: `https://ffmpeg.org/releases/ffmpeg-${ffmpegVersion}.tar.gz`, sha256: '32faba5ef67340d54724941eae1425580791195312a4fd13bf6f820a2818bf22' },
  { file: `lame-${lameVersion}.tar.gz`, url: `https://downloads.sourceforge.net/project/lame/lame/${lameVersion}/lame-${lameVersion}.tar.gz`, sha256: 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e' }
];

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
async function sourceArchive(item) {
  const file = path.join(buildDir, item.file);
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch {
    console.log(`Downloading verified source: ${item.file}`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error(`Source download failed (${response.status}): ${item.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(file, bytes);
  }
  if (hash(bytes) !== item.sha256) throw Error(`Source checksum mismatch: ${item.file}`);
  return file;
}

async function main() {
  const platform = process.platform;
  const arch = process.env.SIMPLEMIX_FFMPEG_ARCH || process.arch;
  const scriptByPlatform = { darwin: 'build-macos.sh', linux: 'build-linux.sh', win32: 'build-windows.sh' };
  const script = scriptByPlatform[platform];
  if (!script || (platform === 'darwin' && !['arm64', 'x64'].includes(arch)) || (platform !== 'darwin' && arch !== 'x64')) {
    throw Error(`No verified LGPL FFmpeg build target for ${platform}-${arch}.`);
  }

  let targetName;
  if (platform === 'darwin') {
    targetName = arch === 'arm64' ? 'arm64-apple-macos11' : 'x86_64-apple-macos10.9';
  } else {
    targetName = platform === 'linux' ? 'x86_64-linux-gnu' : 'x86_64-w64-mingw32';
  }
  const stage = path.join(root, '.cache', 'release-ffmpeg', ffmpegVersion, `${platform}-${arch}`);
  const cachedBinary = path.join(stage, `ffmpeg${platform === 'win32' ? '.exe' : ''}`);
  try {
    const info = JSON.parse(await fs.readFile(path.join(stage, 'BUILD-INFO.json'), 'utf8'));
    const bytes = await fs.readFile(cachedBinary);
    const conf = execFileSync(cachedBinary, ['-hide_banner', '-buildconf'], { encoding: 'utf8', timeout: 15000 });
    if (info.platform === platform && info.arch === arch && info.ffmpegVersion === ffmpegVersion && info.lameVersion === lameVersion && info.ffmpegSourceSha256 === sources[0].sha256 && info.lameSourceSha256 === sources[1].sha256 && info.binarySha256 === hash(bytes) && conf.includes('--enable-filter=asetpts') && conf.includes('--enable-filter=pan')) {
      const output = path.join(root, 'dist', require('../package.json').version);
      await fs.mkdir(output, { recursive: true });
      for (const item of sources) await fs.copyFile(await sourceArchive(item), path.join(output, item.file));
      console.log(`Reusing verified LGPL FFmpeg for ${platform}-${arch}: ${hash(bytes)}`);
      return;
    }
  } catch {}

  await Promise.all(sources.map(sourceArchive));
  const env = { ...process.env, FFMPEG_VARIANT: 'encode' };
  for (const key of ['CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'CPATH', 'LIBRARY_PATH', 'PKG_CONFIG_PATH']) delete env[key];
  if (platform === 'darwin') env.TARGET = targetName;
  else env.ARCH = 'x86_64';
  const built = spawnSync('bash', [path.join(buildDir, script)], { cwd: buildDir, env, stdio: 'inherit' });
  if (built.error) throw built.error;
  if (built.status !== 0) throw Error(`FFmpeg source build failed with exit code ${built.status}.`);

  const variant = `ffmpeg-${ffmpegVersion}-audio-encode-${targetName}`;
  const executable = path.join(buildDir, 'artifacts', variant, 'bin', `ffmpeg${platform === 'win32' ? '.exe' : ''}`);
  const bytes = await fs.readFile(executable);
  await fs.mkdir(stage, { recursive: true });
  const destination = path.join(stage, path.basename(executable));
  await fs.writeFile(destination, bytes, { mode: 0o755 });

  const buildconf = execFileSync(destination, ['-hide_banner', '-buildconf'], { encoding: 'utf8', timeout: 15000 });
  for (const forbidden of ['--enable-gpl', '--enable-nonfree', '--enable-version3']) {
    if (buildconf.includes(forbidden)) throw Error(`Refusing FFmpeg with forbidden configuration ${forbidden}.`);
  }
  for (const required of ['--enable-libmp3lame', '--enable-filter=asetpts', '--enable-filter=pan', '--enable-filter=loudnorm', '--enable-filter=ebur128', '--enable-filter=ametadata', '--enable-filter=astats', '--enable-filter=acompressor', '--enable-muxer=pcm_s16le', '--enable-muxer=pcm_f32le']) {
    if (!buildconf.includes(required)) throw Error(`FFmpeg build is missing required option ${required}.`);
  }
  const ffmpegLicense = execFileSync('tar', ['-xOf', path.join(buildDir, sources[0].file), `ffmpeg-${ffmpegVersion}/COPYING.LGPLv2.1`]);
  const lameLicense = execFileSync('tar', ['-xOf', path.join(buildDir, sources[1].file), `lame-${lameVersion}/COPYING`]);
  await fs.writeFile(path.join(stage, 'FFmpeg-LGPL-2.1.txt'), ffmpegLicense);
  await fs.writeFile(path.join(stage, 'LAME-LGPL-2.0.txt'), lameLicense);
  await fs.writeFile(path.join(stage, 'BUILD-CONFIG.txt'), buildconf);
  await fs.writeFile(path.join(stage, 'BUILD-INFO.json'), JSON.stringify({
    platform, arch, ffmpegVersion, lameVersion,
    ffmpegSourceSha256: sources[0].sha256, lameSourceSha256: sources[1].sha256,
    binarySha256: hash(bytes), license: 'LGPL-2.1-or-later',
    upstreamBuildScripts: 'acoustid/ffmpeg-build@4e18a4ed86d7c1bc5aaa8eb3ced32199af1ef48b'
  }, null, 2) + '\n');

  const output = path.join(root, 'dist', require('../package.json').version);
  await fs.mkdir(output, { recursive: true });
  for (const item of sources) await fs.copyFile(path.join(buildDir, item.file), path.join(output, item.file));
  console.log(`Verified LGPL FFmpeg for ${platform}-${arch}: ${hash(bytes)}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
