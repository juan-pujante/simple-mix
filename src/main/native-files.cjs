const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { masteringOptions, masterAudio } = require('./mastering.cjs');
const { bundleDestination, writeProject, readProject } = require('./project-store.cjs');
async function dialogOptions(options){const prefs=await require('./studio-native.cjs').preferences();if(prefs.language!=='en')return options;const map=require("../shared/locales/en.json").messages;return {...options,title:map[options.title]||options.title,filters:options.filters?.map(f=>({...f,name:map[f.name]||f.name}))};}
const BITRATES = [128, 160, 192, 224, 256, 320];
const fileInfo = file => ({ name: path.basename(file), path: file });
const extension = (file, format) => file.toLowerCase().endsWith('.' + format) ? file : file.replace(/\.(wav|mp3|flac)$/i, '') + '.' + format;
async function atomicWrite(file, data) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try { await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
function ffmpegBinary() {
  if (require('electron').app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  }
  return process.env.SIMPLEMIX_FFMPEG || require('ffmpeg-static');
}
function runEncoder(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('La codificación ha superado el tiempo disponible.')); }, 30 * 60 * 1000);
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error(output.trim() || 'No se pudo codificar el audio.')); });
  });
}
function createFileService({ showOpenDialog, showSaveDialog, binary = ffmpegBinary }) {
  let activePath = null;
  const pending = new Map();
  return {
    newProject() { activePath=null;pending.clear();return true; },
    async adoptRecent(file) { if(!(await require('./studio-native.cjs').preferences()).recent?.includes(file))throw Error('Proyecto no disponible.'); await readProject(file);activePath=file;return fileInfo(file); },
    async openRecent(file) { if(!(await require('./studio-native.cjs').preferences()).recent?.includes(file))throw Error('Proyecto no disponible.');const content=await readProject(file),token=randomUUID();pending.clear();pending.set(token,file);return {...fileInfo(file),content,token}; },
    async openProject() {
      const result = await showOpenDialog({ title: 'Abrir proyecto', defaultPath: activePath || undefined, properties: ['openFile'], filters: [{ name: 'Proyecto Simple Mix', extensions: ['simplemix', 'json'] }] });
      if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
      const file = result.filePaths[0], content = await readProject(file), token = randomUUID();
      pending.clear(); pending.set(token, file);
      return { canceled: false, ...fileInfo(file), token, content };
    },
    acceptProject(token) {
      if (!pending.has(token)) throw Error('El archivo seleccionado ya no está disponible.');
      activePath = pending.get(token); pending.clear();
      return fileInfo(activePath);
    },
    async saveProject({ content, saveAs = false, portable = false, defaultName = 'Mi sesión.simplemix' }) {
      if (typeof content !== 'string') throw Error('El contenido del proyecto no es válido.');
      let file = activePath;
      if (!file || saveAs || portable) {
        const result = await showSaveDialog({ title: saveAs ? 'Guardar proyecto como…' : 'Guardar proyecto', defaultPath: activePath || path.join((await require('./studio-native.cjs').preferences()).projectFolder||'',path.basename(defaultName)), filters: [{ name: 'Proyecto Simple Mix', extensions: ['simplemix'] }] });
        if (result.canceled || !result.filePath) return { canceled: true };
        file = result.filePath;
        if (!file.toLowerCase().endsWith('.simplemix')) file += '.simplemix';
        if(JSON.parse(content).version===4 && !portable) file=await bundleDestination(file);
      }
      await writeProject(file, content, portable);
      if (!portable) activePath = file;
      await require('./studio-native.cjs').savePreferences({projectFolder:path.dirname(file)}).catch(()=>{});
      return { canceled: false, ...fileInfo(file) };
    },
    async exportAudio({ wav, format = 'wav', bitrate = 320, compression = 5, defaultName = 'Mi sesión', mastering = null }) {
      if (!['wav', 'flac', 'mp3'].includes(format)) throw Error('Formato de exportación no compatible.');
      if (format === 'mp3' && !BITRATES.includes(Number(bitrate))) throw Error('Bitrate MP3 no válido.');
      if (format === 'flac' && (!Number.isInteger(Number(compression)) || Number(compression) < 0 || Number(compression) > 8)) throw Error('Nivel de compresión FLAC no válido.');
      const master = masteringOptions(mastering);
      const bytes = Buffer.from(wav);
      if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(24) !== 44100 || bytes.readUInt16LE(22) !== 2) throw Error('La mezcla no es un WAV estéreo de 44,1 kHz.');
      const pcm16 = bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(34) === 16;
      const float32 = bytes.readUInt16LE(20) === 3 && bytes.readUInt16LE(34) === 32;
      if (!pcm16 && !(master && float32)) throw Error('Formato de muestras no compatible.');
      const result = await showSaveDialog({ title: `Exportar mezcla ${format.toUpperCase()}`, defaultPath: extension(path.basename(defaultName), format), filters: [{ name: format === 'flac' ? 'FLAC sin pérdida' : format.toUpperCase(), extensions: [format] }] });
      if (result.canceled || !result.filePath) return { canceled: true };
      const file = extension(result.filePath, format);
      let report = null;
      if (format === 'wav' && !master) await atomicWrite(file, bytes);
      else {
        const job = await fs.mkdtemp(path.join(os.tmpdir(), 'simplemix-'));
        const staged = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp.' + format);
        try {
          const input = path.join(job, 'input.wav'); await fs.writeFile(input, bytes);
          const codec = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${Number(bitrate)}k`, '-write_xing', '1'] : format === 'flac' ? ['-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', String(Number(compression))] : ['-c:a', 'pcm_s16le'];
          const encoder = typeof binary === 'function' ? binary() : binary;
          if (master) report = await masterAudio({ input, output: staged, workDir: job, run: runEncoder, binary: encoder, options: master, codec });
          else await runEncoder(encoder, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-vn', ...codec, '-ar', '44100', '-ac', '2', staged]);
          await fs.rename(staged, file);
        } finally { await fs.rm(staged, { force: true }); await fs.rm(job, { recursive: true, force: true }); }
      }
      return { canceled: false, ...fileInfo(file), format, mastering: report, bytes: (await fs.stat(file)).size };
    }
  };
}
function registerNativeFiles({ ipcMain, dialog, BrowserWindow, rendererUrl }) {
  require('./studio-native.cjs').registerStudio({ipcMain,dialog,BrowserWindow,rendererUrl,binary:ffmpegBinary});
  const services = new WeakMap();
  const service = event => {
    if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('#')[0] !== rendererUrl) throw Error('Solicitud de archivo no permitida.');
    if (!services.has(event.sender)) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      services.set(event.sender, createFileService({ showOpenDialog: async options => dialog.showOpenDialog(owner, await dialogOptions(options)), showSaveDialog: async options => dialog.showSaveDialog(owner, await dialogOptions(options)) }));
      event.sender.once('did-navigate', () => services.delete(event.sender));
    }
    return services.get(event.sender);
  };
  ipcMain.handle('simplemix:open-recent',(event,file)=>service(event).openRecent(file));
  ipcMain.handle('simplemix:new-project',event=>service(event).newProject());
  ipcMain.handle('simplemix:adopt-recent',(event,file)=>service(event).adoptRecent(file));
  ipcMain.handle('simplemix:open-project', event => service(event).openProject());
  ipcMain.handle('simplemix:accept-project', (event, token) => service(event).acceptProject(token));
  ipcMain.handle('simplemix:save-project', (event, options) => service(event).saveProject(options));
  ipcMain.handle('simplemix:export-audio', (event, options) => service(event).exportAudio(options));
}
module.exports = { createFileService, registerNativeFiles, atomicWrite, runEncoder, ffmpegBinary };
