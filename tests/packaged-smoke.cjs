const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const execFile=require('node:util').promisify(require('node:child_process').execFile);
const archive=path.resolve(process.argv[2]||`dist/${require('../package.json').version}/mac-arm64/Simple Mix.app/Contents/Resources/app.asar`);
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-packaged-'));app.setPath('userData',profile);
 const timeout=setTimeout(()=>app.exit(1),45000);let win;
 try{
  const pkg=require(path.join(archive,'package.json'));assert.equal(pkg.version,require('../package.json').version);
  const native=require(path.join(archive, "src/main/native-files.cjs"));
  native.registerNativeFiles({ipcMain,BrowserWindow,dialog,rendererUrl:pathToFileURL(path.join(archive, "src/renderer/index.html")).href});
  const ffmpeg=await execFile(native.ffmpegBinary(),['-version']);assert.match(ffmpeg.stdout,/ffmpeg version/);
  const studio=require(path.join(archive,'src/main/desktop-window.cjs')).createStudioWindows();win=studio.main;
  const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await studio.ready;
  const run=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()',true);
  assert(await run(`await I18n.ready;I18n.setLocale('es');return document.title.includes('${pkg.version}')&&!!simpleMix.processAudio&&!!$('#newProject')&&!!document.querySelector('.key-button');`));
  assert(await run(`const b=audio().createBuffer(1,44100*16,44100),data=b.getChannelData(0),chords=[[60,64,67],[65,69,72],[67,71,74],[60,64,67]];for(let i=0;i<data.length;i++){const time=i/44100;for(const midi of chords[Math.floor(time/4)])data[i]+=.15*Math.sin(2*Math.PI*440*2**((midi-69)/12)*time);}await load(tracks[0],new File([floatWav(b).blob],"C-major.wav",{type:"audio/wav"}));return camelot(tracks[0].key)==='8B';`));
  assert(await run(`openSessionEditor();$('#matchSessionGain').click();$('#gainCheckOverlaps').checked=false;const result=await analyzeGainDialog(),valid=result&&gainDialogState.report.rows.some(r=>Number.isFinite(r.gain));$('#gainDialog').close();return valid&&typeof simpleMix.cancelAudio==='function';`));
  assert(await run(`$('#export').click();return $('#exportDialog').open&&$('#mp3Bitrate').hidden&&!!customSelects.get($('#mp3Bitrate'));`));
  assert.equal(errors.length,0,errors.join('\n'));
  await fs.mkdir(path.join(__dirname,'../artifacts'),{recursive:true});await fs.writeFile(path.join(__dirname,`../artifacts/packaged-${pkg.version}.png`),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({version:pkg.version,archive,checks:['Packaged splash and editor boot','Native IPC bridge','Packaged FFmpeg executes','Packaged key worker detects C major / 8B','Packaged Auto Gain measurement and cancellation bridge','Custom export controls','No renderer errors']},null,2));
  win.destroy();clearTimeout(timeout);await fs.rm(profile,{recursive:true,force:true,maxRetries:5}).catch(()=>{});app.exit(0);
 }catch(error){console.error(error);win?.destroy();clearTimeout(timeout);await fs.rm(profile,{recursive:true,force:true,maxRetries:5}).catch(()=>{});app.exit(1);}
});
