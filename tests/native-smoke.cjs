const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { once } = require('node:events');
const execFile = promisify(require('node:child_process').execFile);
const { registerNativeFiles, ffmpegBinary } = require('../src/main/native-files.cjs');
app.whenReady().then(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simplemix-native-test-'));
  app.setPath('userData',path.join(root,'profile'));await fs.mkdir(app.getPath('userData'),{recursive:true});
  const saveQueue = [], openQueue = [], saveCalls = [], checks = [];
  const check = (ok, message) => { if (!ok) throw Error(message); checks.push(message); };
  const dialog = {
    async showSaveDialog(_owner, options) { saveCalls.push(options); if (!saveQueue.length) throw Error('Unexpected Save As dialog: ' + options.title); return saveQueue.shift(); },
    async showOpenDialog() { if (!openQueue.length) throw Error('Unexpected Open dialog'); return openQueue.shift(); }
  };
  registerNativeFiles({ ipcMain, dialog, BrowserWindow, rendererUrl: pathToFileURL(path.join(__dirname, "../src/renderer/index.html")).href });
  const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { preload: path.join(__dirname, "../src/main/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const run = async code => {
    const result = await win.webContents.executeJavaScript(`(async()=>{${code}})().then(value=>({value})).catch(error=>({error:error.message,stack:error.stack}))`, true);
    if (result.error) throw Error(result.error + '\n' + result.stack);
    return result.value;
  };
  const timeout = setTimeout(() => { console.error('Native workflow timeout'); app.exit(1); }, 120000);
  const firstSelection=path.join(root,'first session.simplemix'),secondSelection=path.join(root,'second session.simplemix');
  const first=path.join(root,'first session','first session.simplemix'),second=path.join(root,'second session','second session.simplemix');
  try {
    await win.loadFile(path.join(__dirname, "../src/renderer/index.html"));
    check(await run('return typeof window.simpleMix.saveProject === "function" && typeof require === "undefined"'), 'Sandboxed renderer receives the native file bridge without Node access');
    await run(`const buffer=audio().createBuffer(2,44100*2,44100); for(let c=0;c<2;c++){const data=buffer.getChannelData(c);for(let i=0;i<data.length;i++)data[i]=.4*Math.sin(2*Math.PI*(c?330:220)*i/44100);} await load(tracks[0],new File([wav(buffer).blob],'Synthetic.wav',{type:'audio/wav'}));`);
    saveQueue.push({ canceled: false, filePath: firstSelection });
    check(await run('return saveProject()'), 'First save writes a native project after choosing a destination');
    check(saveCalls.length === 1 && JSON.parse(await fs.readFile(first, 'utf8')).tracks[0].asset, 'First save includes the managed audio and shows one destination dialog');
    check(await run('return document.querySelector("#activeFile").textContent === "first session.simplemix" && document.querySelector("#activeFile").title.endsWith("first session.simplemix")'), 'Header displays the active project filename and full path');
    await run('document.querySelector("#projectName").value="Updated session";document.querySelector("#projectName").oninput();');
    check(await run('return saveProject()'), 'Second save succeeds without requesting another filename');
    check(saveCalls.length === 1 && JSON.parse(await fs.readFile(first, 'utf8')).name === 'Updated session', 'Save overwrites the same active file without a Save As dialog');
    saveQueue.push({ canceled: false, filePath: secondSelection });
    check(await run('return saveProject(true)'), 'Save As creates a second project file');
    await run('document.querySelector("#projectName").value="Only second file";document.querySelector("#projectName").oninput();return saveProject();');
    check(JSON.parse(await fs.readFile(second, 'utf8')).name === 'Only second file' && JSON.parse(await fs.readFile(first, 'utf8')).name === 'Updated session' && saveCalls.length === 2, 'After Save As, subsequent saves update the new file and leave the original intact');
    saveQueue.push({ canceled: true });
    check(!await run('return saveProject(true)') && await run('return activeProject.name === "second session.simplemix"'), 'Canceling Save As preserves the current project file');
    openQueue.push({ canceled: false, filePaths: [first] });
    await run('await document.querySelector("#openProject").onclick();');
    await run('document.querySelector("#projectName").value="Saved after open";document.querySelector("#projectName").oninput();return saveProject();');
    check(JSON.parse(await fs.readFile(first, 'utf8')).name === 'Saved after open' && saveCalls.length === 3, 'Opening an existing project makes Save update that exact file without another dialog');
    const invalid = path.join(root, 'invalid.simplemix'); await fs.writeFile(invalid, '{"version":99}');
    openQueue.push({ canceled: false, filePaths: [invalid] }); await run('await document.querySelector("#openProject").onclick();');
    check(await run('return activeProject.name === "first session.simplemix" && tracks[0].buffer.duration === 2'), 'An invalid opened file does not replace the active project or its audio');
    await run('document.querySelector("#projectName").value="After invalid file";document.querySelector("#projectName").oninput();return saveProject();');
    check(JSON.parse(await fs.readFile(first, 'utf8')).name === 'After invalid file' && await fs.readFile(invalid, 'utf8') === '{"version":99}', 'Save after an invalid open still writes only the previously active project');
    saveQueue.push({ canceled: false, filePath: path.join(root, 'missing directory', 'failure.simplemix') });
    check(!await run('return saveProject(true)') && await run('return activeProject.name === "first session.simplemix"'), 'A failed Save As leaves the previous active file selected');
    const countAfterFailure = saveCalls.length;
    check(await run('return saveProject()') && saveCalls.length === countAfterFailure, 'Normal saving still overwrites the active file after a failed Save As');
    const wavPath = path.join(root, 'mix.wav'); saveQueue.push({ canceled: false, filePath: wavPath });
    check(await run('return exportMix({format:"wav"})'), 'Native WAV export writes the rendered session');
    const wavData = await fs.readFile(wavPath);let pcm;
    check(wavData.toString('ascii',0,4) === 'RIFF' && wavData.readUInt32LE(24) === 44100, 'Native WAV output has the expected PCM header');
    const decode = async file => (await execFile(ffmpegBinary(), ['-hide_banner','-loglevel','error','-i',file,'-f','s16le','-c:a','pcm_s16le','-ar','44100','-ac','2','pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })).stdout;
    pcm=await decode(wavPath);
    for (const compression of [0,5,8]) {
      const file = path.join(root, `mix-level-${compression}.flac`); saveQueue.push({ canceled: false, filePath: file });
      check(await run(`return exportMix({format:'flac',compression:${compression}})`), `FLAC compression level ${compression} exports successfully`);
      const encoded = await fs.readFile(file);
      check(encoded.toString('ascii',0,4) === 'fLaC' && (await decode(file)).equals(pcm), `FLAC level ${compression} decodes to exactly the original PCM samples`);
    }
    function mp3Bitrate(bytes) {
      let start = 0;
      if(bytes.toString('ascii',0,3)==='ID3')start=10+((bytes[6]&127)<<21)+((bytes[7]&127)<<14)+((bytes[8]&127)<<7)+(bytes[9]&127);
      for(let i=start;i<Math.min(bytes.length-4,start+8192);i++)if(bytes[i]===255&&(bytes[i+1]&224)===224&&((bytes[i+1]>>3)&3)===3&&((bytes[i+1]>>1)&3)===1)return [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320][bytes[i+2]>>4];
      return 0;
    }
    for (const bitrate of [128,160,192,224,256,320]) {
      const file = path.join(root, `mix-${bitrate}.mp3`); saveQueue.push({ canceled: false, filePath: file });
      check(await run(`return exportMix({format:'mp3',bitrate:${bitrate}})`), `MP3 ${bitrate} kbps exports successfully`);
      const encoded = await fs.readFile(file), decoded = await decode(file);
      check(mp3Bitrate(encoded) === bitrate && Math.abs(decoded.length - pcm.length) <= 4608, `MP3 frame headers confirm ${bitrate} kbps and decoded duration matches the session`);
    }
    saveQueue.push({ canceled: true });
    check(!await run('return exportMix({format:"mp3",bitrate:320})'), 'Canceling the export destination does not report a successful export');
    check(await run('return activeProject.name === "first session.simplemix"'), 'Audio exports never replace the active project filename');
    const beforeFinalSave = saveCalls.length;
    check(await run('return saveProject()') && saveCalls.length === beforeFinalSave && JSON.parse(await fs.readFile(first, 'utf8')).name === 'After invalid file', 'Saving after all exports still updates the same active project without a dialog');
    const leftovers = (await fs.readdir(root)).filter(name => name.includes('.tmp'));
    check(!leftovers.length, 'Completed and failed writes leave no partial temporary output files');
    win.setContentSize(960,700); await new Promise(resolve=>setTimeout(resolve,120));
    check(await run('const file=document.querySelector("#activeFile").getBoundingClientRect(),button=document.querySelector("#export").getBoundingClientRect();return file.width>0 && file.right<=innerWidth && button.right<=innerWidth;'), 'Active filename and export controls remain visible in the compact window');
    await run('document.querySelector("#export").click();document.querySelector("#exportFormat").value="mp3";document.querySelector("#exportFormat").dispatchEvent(new Event("change"));');
    check(await run('const dialog=document.querySelector("#exportDialog"),box=dialog.getBoundingClientRect();return dialog.open && box.width>300 && box.top>=0 && box.bottom<=innerHeight && !document.querySelector("#mp3Options").hidden;'), 'MP3 export settings fit the compact window');
    await new Promise(resolve=>setTimeout(resolve,250));
    const artifactDir=path.join(__dirname,'..','artifacts');await fs.mkdir(artifactDir,{recursive:true});await fs.writeFile(path.join(artifactDir,'export-settings.png'),(await win.webContents.capturePage()).toPNG());
    clearTimeout(timeout); console.log(JSON.stringify({ checks }, null, 2));
    await finish(0);
  } catch (error) { clearTimeout(timeout); console.error(error); await finish(1); }

  async function finish(code) {
    clearTimeout(timeout);
    if (!win.isDestroyed()) win.destroy();
    const quitting = once(app, 'will-quit');
    app.quit();
    await quitting;
    // Chromium keeps profile files open briefly on Windows after its windows close.
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); break; }
      catch (error) { if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 7) { console.warn('Temporary profile cleanup deferred:', error.message); break; } await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    process.exitCode = code;
  }
});
