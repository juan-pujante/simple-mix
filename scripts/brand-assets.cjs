// Platform resampling and binary containers; the artwork itself stays unchanged.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
app.whenReady().then(() => {
  try {
    const root = path.join(__dirname, '../assets/brand');
    const source = nativeImage.createFromPath(path.join(root, 'app-icon.png'));
    if (source.isEmpty()) throw new Error('Missing app-icon.png');
    const iconset = path.join(root, 'icon.iconset'); fs.mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) fs.writeFileSync(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), source.resize({ width: size * scale, height: size * scale, quality: 'best' }).toPNG());
    if (process.platform === 'darwin') execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'icon.icns')]);
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
    const header = Buffer.alloc(6 + sizes.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, i) => { const entry = 6 + i * 16; header[entry] = header[entry + 1] = size === 256 ? 0 : size; header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += images[i].length; });
    fs.writeFileSync(path.join(root, 'icon.ico'), Buffer.concat([header, ...images]));
    console.log('Platform icons generated: ICNS, ICO (7 sizes), PNG'); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
