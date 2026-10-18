const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { registerNativeFiles, ffmpegBinary } = require('../src/main/native-files.cjs');
const { masteringOptions } = require('../src/main/mastering.cjs');
app.whenReady().then(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-master-test-'));
  app.setPath('userData',path.join(root,'profile'));await fs.mkdir(app.getPath('userData'),{recursive:true});
  const saves=[],opens=[],checks=[];
  const check=(ok,message,details)=>{if(!ok)throw Error(message+(details?" · "+JSON.stringify(details):""));checks.push(message);};
  registerNativeFiles({ipcMain,BrowserWindow,rendererUrl:pathToFileURL(path.join(__dirname, "../src/renderer/index.html")).href,dialog:{
    async showSaveDialog(){if(!saves.length)throw Error('Unexpected destination dialog');return saves.shift();},
    async showOpenDialog(){if(!opens.length)throw Error('Unexpected open dialog');return opens.shift();}
  }});
  const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{preload:path.join(__dirname, "../src/main/preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const run=async code=>{const result=await win.webContents.executeJavaScript(`(async()=>{${code}})().then(value=>({value})).catch(error=>({error:error.message,stack:error.stack}))`,true);if(result.error)throw Error(result.error+'\n'+result.stack);return result.value;};
  const timeout=setTimeout(()=>{console.error('Mastering test timeout');app.exit(1);},180000);
  const decode=async file=>(await execFile(ffmpegBinary(),['-hide_banner','-loglevel','error','-i',file,'-f','s16le','-c:a','pcm_s16le','-ar','44100','-ac','2','pipe:1'],{encoding:'buffer',maxBuffer:16*1024*1024})).stdout;
  const measure=async file=>{
    const {stderr}=await execFile(ffmpegBinary(),['-hide_banner','-nostdin','-i',file,'-af','ebur128=peak=true','-f','null','-'],{maxBuffer:2*1024*1024});
    const summary=stderr.slice(stderr.lastIndexOf('Summary:'));
    const integrated=summary.match(/I:\s*(-?[\d.]+) LUFS/),peak=summary.match(/Peak:\s*(-?[\d.]+) dBFS/);
    if(!integrated||!peak)throw Error('Independent EBU meter failed: '+summary);
    return {lufs:Number(integrated[1]),truePeak:Number(peak[1])};
  };
  try{
    await win.loadFile(path.join(__dirname, "../src/renderer/index.html"));
    check(await run('return document.querySelector("#normalize").value === "peak"'),'Existing default remains peak-only; mastering is explicitly opt-in');
    await run(`const buffer=audio().createBuffer(2,44100*12,44100);for(let c=0;c<2;c++){const data=buffer.getChannelData(c);for(let i=0;i<data.length;i++){const t=i/44100,section=t<4?.45:t<8?1:1.7,beat=t%(60/140);data[i]=section*(.14*Math.sin(2*Math.PI*(c?137:110)*t)+.06*Math.sin(2*Math.PI*330*t)+.4*Math.exp(-beat*50)*Math.sin(2*Math.PI*70*t));}} await load(tracks[0],new File([wav(buffer).blob],'Test session.wav',{type:'audio/wav'}));tracks[0].followGlobal=false;tracks[0].bpm=140;tracks[0].sourceBpm=null;tracks[0].bpmMode='manual';tracks[0].targetBpm=140;tracks[0].volume=1;document.querySelector('#master').value=1;document.querySelector('#normalize').value='master';document.querySelector('#normalize').onchange();window.masterFixture=tracks[0].buffer;window.masterFile=tracks[0].file;`);
    // This mastering fixture has unity speed; source/target resampling is tested separately.
    const floating=await run(`const rendered=await renderSession(),blob=floatWav(rendered).blob,bytes=await blob.arrayBuffer(),view=new DataView(bytes);return {format:view.getUint16(20,true),bits:view.getUint16(34,true),frames:(bytes.byteLength-44)/8};`);
    check(floating.format===3&&floating.bits===32&&floating.frames===12*44100,'Mastering passes a 32-bit float mix to the native engine before any PCM clipping');
    for(const [profile,target,ceiling] of [['balanced',-14,-1],['techno',-12,-1],['dynamic',-16,-1.5]]){
      const file=path.join(root,'master-'+profile+'.wav');saves.push({canceled:false,filePath:file});
      const report=await run(`document.querySelector('#masterReportDialog').close();document.querySelector('#masterProfile').value='${profile}';document.querySelector('#masterProfile').onchange();const ok=await exportMix({format:'wav'});if(!ok)throw Error(document.querySelector('#status').textContent);return lastMasterReport;`);
      const meter=await measure(file);
      check(Math.abs(meter.lufs-target)<.8&&meter.truePeak<=ceiling+.11,`${profile} WAV meets the loudness target and true-peak ceiling in the independent EBU meter`);
      check(Math.abs(report.after.lufs-meter.lufs)<.16&&Math.abs(report.after.truePeak-meter.truePeak)<.21&&report.compression&&report.before.lufs!==null,`${profile} report contains measured input/output values and applied compression`, {report,meter});
      check(Math.abs((await decode(file)).length/176400-12)<.03,`${profile} mastering preserves session duration`);
      if(profile==='balanced')await run('window.balancedMasterReport=lastMasterReport;');
    }
    for(const [format,bitrate] of [['flac',320],['mp3',128],['mp3',320]]){
      const file=path.join(root,`master-${format}-${bitrate}.${format}`);saves.push({canceled:false,filePath:file});
      const report=await run(`document.querySelector('#masterReportDialog').close();document.querySelector('#masterProfile').value='balanced';document.querySelector('#masterProfile').onchange();const ok=await exportMix({format:'${format}',bitrate:${bitrate},compression:5});if(!ok)throw Error(document.querySelector('#status').textContent);return lastMasterReport;`);
      const meter=await measure(file);
      check(meter.truePeak<=-1+.11&&Math.abs(report.after.truePeak-meter.truePeak)<.21,`${format.toUpperCase()} ${bitrate} final encoded file respects the measured true-peak ceiling`);
      check(Math.abs((await decode(file)).length/176400-12)<.03,`${format.toUpperCase()} ${bitrate} mastering preserves decoded duration`);
    }
    const hot=path.join(root,'hot-input.wav');saves.push({canceled:false,filePath:hot});
    const hotReport=await run(`document.querySelector('#masterReportDialog').close();const track=tracks[0];addTrack({buffer:track.buffer,file:track.file,name:'Second layer',peaks:track.peaks,bpm:track.bpm,targetBpm:track.bpm,followGlobal:false,volume:1});const ok=await exportMix({format:'wav'});if(!ok)throw Error(document.querySelector('#status').textContent);return lastMasterReport;`);
    check(hotReport.before.truePeak>0&&hotReport.after.truePeak<=-.97,'Overlapping audio above 0 dB is preserved as float and safely mastered instead of clipping before the limiter');
    await run('document.querySelector("#masterReportDialog").close();removeTrack(tracks[1]);document.querySelector("#masterCompressor").checked=false;');
    const transparent=path.join(root,'without-compressor.wav');saves.push({canceled:false,filePath:transparent});
    const noComp=await run(`const ok=await exportMix({format:'wav'});if(!ok)throw Error(document.querySelector('#status').textContent);return lastMasterReport;`);
    check(!noComp.compression&&noComp.after.truePeak<=-.97,'Disabling the gentle compressor retains loudness normalization and peak control');
    const project=path.join(root,'mastering.simplemix');saves.push({canceled:false,filePath:project});
    check(await run(`document.querySelector('#masterReportDialog').close();document.querySelector('#targetLufs').value=-13.5;document.querySelector('#targetTruePeak').value=-1.2;return saveProject();`),'Mastering settings save with the active project');
    opens.push({canceled:false,filePaths:[path.join(root,'mastering','mastering.simplemix')]});await run(`document.querySelector('#normalize').value='none';await document.querySelector('#openProject').onclick();`);
    check(await run(`return document.querySelector('#normalize').value==='master'&&masteringSettings().lufs===-13.5&&masteringSettings().truePeak===-1.2&&!masteringSettings().compression;`),'Project reload restores mastering mode, custom LUFS, peak ceiling and compressor choice');
    const silentFile=path.join(root,'silence.wav');saves.push({canceled:false,filePath:silentFile});
    const silent=await run(`const buffer=audio().createBuffer(2,44100*2,44100);tracks[0].buffer=buffer;tracks[0].peaks=peaks(buffer);tracks[0].offset=0;const ok=await exportMix({format:'wav'});if(!ok)throw Error(document.querySelector('#status').textContent);return lastMasterReport;`);
    check(silent.silent&&silent.after.lufs===null&&(await decode(silentFile)).every(value=>value===0),'Silence exports unchanged with no infinite gain and an honest non-measurable LUFS report');
    const shortFile=path.join(root,'short-click.wav');saves.push({canceled:false,filePath:shortFile});
    const short=await run(`document.querySelector('#masterReportDialog').close();const buffer=audio().createBuffer(2,4410,44100);for(let c=0;c<2;c++)for(let i=0;i<64;i++)buffer.getChannelData(c)[i]=1.8*(1-i/64);tracks[0].buffer=buffer;tracks[0].peaks=peaks(buffer);const ok=await exportMix({format:'wav'});if(!ok)throw Error(document.querySelector('#status').textContent);return lastMasterReport;`);
    check(short.after.truePeak===null||short.after.truePeak<=-1.17,'A short high-level transient remains exportable and respects the peak ceiling even without measurable LUFS');
    let invalid=false;try{masteringOptions({enabled:true,lufs:-3});}catch{invalid=true;}check(invalid,'Native engine rejects invalid loudness targets before processing');
    win.setContentSize(960,700);await new Promise(resolve=>setTimeout(resolve,120));
    await run(`document.querySelector('#masterReportDialog').close();tracks[0].buffer=window.masterFixture;tracks[0].peaks=peaks(window.masterFixture);update(tracks[0]);timeline();document.querySelector('#export').click();document.querySelector('#exportFormat').value='mp3';document.querySelector('#exportFormat').onchange();`);
    check(await run(`const d=document.querySelector('#exportDialog'),r=d.getBoundingClientRect();return d.open&&r.top>=0&&r.bottom<=innerHeight&&!document.querySelector('#masteringOptions').hidden;`),'Mastering and MP3 settings fit the compact single-screen layout');
    const artifacts=path.join(__dirname,'..','artifacts');await fs.mkdir(artifacts,{recursive:true});await new Promise(resolve=>setTimeout(resolve,200));await fs.writeFile(path.join(artifacts,'mastering-settings.png'),(await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('#exportDialog').close();lastMasterReport=window.balancedMasterReport;showMasterReport();`);
    check(await run(`const d=document.querySelector('#masterReportDialog'),r=d.getBoundingClientRect();return d.open&&r.top>=0&&r.bottom<=innerHeight&&document.querySelector('#reportAfterLufs').textContent.includes('LUFS');`),'Measured before/after report is visible and fits the compact window');
    await new Promise(resolve=>setTimeout(resolve,200));await fs.writeFile(path.join(artifacts,'mastering-report.png'),(await win.webContents.capturePage()).toPNG());
    clearTimeout(timeout);console.log(JSON.stringify({checks},null,2));await fs.rm(root,{recursive:true,force:true});app.exit(0);
  }catch(error){clearTimeout(timeout);console.error(error);await fs.rm(root,{recursive:true,force:true});app.exit(1);}
});
