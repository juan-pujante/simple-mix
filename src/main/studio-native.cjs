const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { atomic, writeProject, readProject } = require('./project-store.cjs');
const { masteringOptions, masterAudio, measureEbu } = require('./mastering.cjs');
const jobs = new Map();
const audioMeasurements = new Map();
const prefsFile=()=>path.join(app.getPath('userData'),'preferences.json');
async function preferences() { try{return JSON.parse(await fs.readFile(prefsFile(),'utf8'));}catch{return {language:app.getLocale().startsWith('es')?'es':'en',recent:[]};} }
let preferenceWrite=Promise.resolve();
function savePreferences(value) {const write=preferenceWrite.then(async()=>{const previous=await preferences(),next={...previous,...value};await fs.mkdir(app.getPath('userData'),{recursive:true});await atomic(prefsFile(),JSON.stringify(next));return next;});preferenceWrite=write.catch(()=>{});return write;}
async function recent(file) { const p=await preferences(); await savePreferences({recent:[file,...(p.recent||[]).filter(x=>x!==file)].slice(0,12)}); }
function run(binary,args,job) {
  if(job?.aborted)return Promise.reject(Error('Operación cancelada.'));
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});
    if(job)job.child=child;
    let output='';const timer=setTimeout(()=>{child.kill();},30*60*1000);
    child.stderr.on('data',chunk=>{output=(output+chunk).slice(-24000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(job)job.child=null;job?.aborted?reject(Error('Operación cancelada.')):code===0?resolve(output):reject(Error(output.trim()||'Error de audio.'));});
  });
}
function tempos(ratio) { const out=[];while(ratio<.5){out.push('atempo=0.5');ratio/=.5;}while(ratio>2){out.push('atempo=2');ratio/=2;}out.push('atempo='+ratio);return out; }
async function audioJob(options,binary,job=null) {
  const bytes=Buffer.from(options.audio);if(!bytes.length)throw Error('Audio vacío.');
  const rate=Number(options.rate??1),pitch=Number(options.pitch??0);
  if(!Number.isFinite(rate)||rate<1/6||rate>6||!Number.isFinite(pitch)||Math.abs(pitch)>12)throw Error('Tempo de pista inválido');
  const key=createHash('sha256').update(bytes).update(JSON.stringify([rate,pitch,!!options.keepPitch])).digest('hex');
  const cache=path.join(app.getPath('userData'),'AudioCache');await fs.mkdir(cache,{recursive:true});
  const output=path.join(cache,key+'.wav');
  if(!options.measure)try{return {audio:new Uint8Array(await fs.readFile(output))};}catch{}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-audio-'));
  try {
    const input=path.join(dir,'input');await fs.writeFile(input,bytes);
    if(options.measure){
      let prefix='';
      if(options.analysisRange!==undefined){
        const range=options.analysisRange;
        if(!Array.isArray(range)||range.length!==2||!range.every(Number.isFinite)||range[0]<0||range[1]<=range[0]||range[1]>86400)throw Error('Recorte de audio no válido.');
        prefix=`atrim=start=${range[0]}:end=${range[1]},asetpts=PTS-STARTPTS,`;
      }
      // Web Audio duplicates mono into both output channels at unity gain.
      if(options.analysisMono===true)prefix+='pan=stereo|c0=c0|c1=c0,';
      const measurement=await measureEbu({run:(bin,args)=>run(bin,args,job),binary,file:input,prefix});
      if(job?.aborted)throw Error('Operación cancelada.');
      return {measurement};
    }
    const factor=2**(pitch/12);
    const filters=options.keepPitch?['aresample=44100',...(pitch?['asetrate='+44100*factor,'aresample=44100']:[]),...tempos(rate/factor)]:['aresample=44100','asetrate='+44100*rate*factor,'aresample=44100',...tempos(1/factor)];
    const staged=path.join(dir,'processed.wav');
    await run(binary,['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-af',filters.join(','),'-ac','2','-ar','44100','-c:a','pcm_f32le',staged]);
    const data=await fs.readFile(staged);await atomic(output,data);
    // Cache is disposable, bounded independently of projects. Never delete project media.
    const entries=await Promise.all((await fs.readdir(cache)).filter(n=>n.endsWith('.wav')).map(async name=>{try{return {name,...await fs.stat(path.join(cache,name))};}catch(error){if(error.code==='ENOENT')return {name,size:0,mtimeMs:0};throw error;}}));
    let total=entries.reduce((n,x)=>n+x.size,0);
    for(const entry of entries.sort((a,b)=>a.mtimeMs-b.mtimeMs))if(total>512*1024*1024&&entry.name!==key+'.wav'){await fs.rm(path.join(cache,entry.name),{force:true});total-=entry.size;}
    return {audio:new Uint8Array(data)};
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
async function discardExport(job){await job.write.catch(()=>{});jobs.delete(job.id);await fs.rm(job.staged,{force:true});await fs.rm(job.dir,{recursive:true,force:true});}
function registerStudio({ipcMain,dialog,BrowserWindow,rendererUrl,binary}) {
  const recoveryIds=new WeakMap(), dirty=new WeakMap(), busyState=new WeakMap();
  const trusted=event=>{if(event.senderFrame!==event.sender.mainFrame||event.senderFrame.url.split('#')[0]!==rendererUrl)throw Error('Solicitud no permitida.');return event.sender;};
  const root=()=>path.join(app.getPath('userData'),'Recovery');
  const recoveryFile=sender=>{if(!recoveryIds.has(sender))recoveryIds.set(sender,randomUUID());return path.join(root(),recoveryIds.get(sender)+'.simplemix');};
  const owned=(event,id)=>{trusted(event);const job=jobs.get(id);if(!job||job.sender!==event.sender)throw Error('Operación no disponible.');return job;};
  ipcMain.handle('studio:preferences',async(event,value)=>{trusted(event);if(!value)return preferences();const clean={};if(['es','en'].includes(value.language))clean.language=value.language;if(typeof value.output==='string')clean.output=value.output;if(value.window&&Number.isFinite(value.window.width)&&Number.isFinite(value.window.height))clean.window=value.window;const saved=await savePreferences(clean);if(clean.language)app.emit('studio-language',clean.language);return saved;});
  ipcMain.handle('studio:recent',async(event,file)=>{trusted(event);if(file)await recent(file);return (await preferences()).recent||[];});
  ipcMain.handle('studio:open-recent',async(event,file)=>{trusted(event);if(!(await preferences()).recent?.includes(file))throw Error('Proyecto no disponible.');return {name:path.basename(file),content:await readProject(file)};});
  const watchClose=sender=>{
    if(sender.__studioClose)return;sender.__studioClose=true;
    const win=BrowserWindow.fromWebContents(sender);
    win.on('close',e=>{if(dirty.get(sender)||busyState.get(sender)){e.preventDefault();sender.send('studio:close-request');}});
    sender.once('destroyed',()=>{for(const job of jobs.values())if(job.sender===sender){job.aborted=true;job.child?.kill();if(!job.finishing)discardExport(job).catch(()=>{});}});
  };
  ipcMain.handle('studio:dirty',(event,value)=>{const sender=trusted(event);dirty.set(sender,!!value);watchClose(sender);});
  ipcMain.handle('studio:busy',(event,value)=>{const sender=trusted(event);busyState.set(sender,!!value);watchClose(sender);});
  ipcMain.handle('studio:close',event=>{const sender=trusted(event);if(busyState.get(sender))return false;dirty.set(sender,false);BrowserWindow.fromWebContents(sender)?.close();});
  ipcMain.handle('studio:recovery',async(event,{action,content,id}={})=>{
    const sender=trusted(event);await fs.mkdir(root(),{recursive:true});
    if(action==='write'){const file=recoveryFile(sender);await writeProject(file,content);return {id:path.basename(file)};}
    if(action==='clear'){await fs.rm(recoveryFile(sender),{force:true});return;}
    if(action==='remove'){if(!/^[a-f0-9-]+\.simplemix$/.test(id))throw Error('Recuperación no válida.');await fs.rm(path.join(root(),id),{force:true});return;}
    const entries=[];for(const name of await fs.readdir(root()))if(name.endsWith('.simplemix')&&name!==path.basename(recoveryFile(sender))){try{const file=path.join(root(),name),stat=await fs.stat(file);entries.push({id:name,modified:stat.mtimeMs,content:await readProject(file)});}catch{}}
    return entries.sort((a,b)=>b.modified-a.modified);
  });
  ipcMain.handle('studio:preview',async(event,{wav,mastering})=>{
    trusted(event);const bytes=Buffer.from(wav);if(bytes.length>44100*8*31+44)throw Error('Vista previa demasiado larga.');
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-preview-'));
    try{const input=path.join(dir,'input.wav'),output=path.join(dir,'master.wav');await fs.writeFile(input,bytes);const report=await masterAudio({input,output,workDir:dir,run,binary:binary(),options:masteringOptions(mastering),codec:['-c:a','pcm_f32le']});return {audio:new Uint8Array(await fs.readFile(output)),compensation:report.before.lufs!==null&&report.after.lufs!==null?10**((report.before.lufs-report.after.lufs)/20):1};}finally{await fs.rm(dir,{recursive:true,force:true});}
  });
  ipcMain.handle('studio:audio',async(event,options)=>{
    const sender=trusted(event);
    if(!options.measure||!options.measurementId)return audioJob(options,binary());
    const id=options.measurementId;
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||audioMeasurements.has(id))throw Error('Operación no disponible.');
    const job={sender,aborted:false,child:null};audioMeasurements.set(id,job);
    const destroyed=()=>{job.aborted=true;job.child?.kill();};sender.once('destroyed',destroyed);
    try{return await audioJob(options,binary(),job);}
    finally{audioMeasurements.delete(id);sender.removeListener('destroyed',destroyed);}
  });
  ipcMain.handle('studio:audio-cancel',(event,id)=>{
    const sender=trusted(event),job=audioMeasurements.get(id);if(!job)return false;
    if(job.sender!==sender)throw Error('Operación no disponible.');job.aborted=true;job.child?.kill();return true;
  });
  ipcMain.handle('studio:export-begin',async(event,options)=>{
    trusted(event);const format=options.format||'wav';if(!['wav','flac','mp3'].includes(format))throw Error('Formato de exportación no compatible.');
    if(![44100,48000].includes(options.sampleRate)||![16,24].includes(options.bitDepth))throw Error('Formato de muestras no compatible.');
    if(format==='mp3'&&![128,160,192,224,256,320].includes(options.bitrate))throw Error('Bitrate MP3 no válido.');
    if(!Number.isInteger(options.compression)||options.compression<0||options.compression>8)throw Error('Nivel de compresión FLAC no válido.');
    masteringOptions(options.mastering);
    const result=await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender),{title:(await preferences()).language==='en'?'Export mix':'Exportar mezcla',defaultPath:path.join((await preferences()).exportFolder||'',path.basename(options.defaultName||'Mi sesión')+'.'+format),filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(result.canceled||!result.filePath)return {canceled:true};
    const file=result.filePath.toLowerCase().endsWith('.'+format)?result.filePath:result.filePath+'.'+format;
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-render-')),id=randomUUID();
    const job={id,sender:event.sender,options,file,dir,input:path.join(dir,'mix.wav'),staged:path.join(path.dirname(file),'.'+path.basename(file)+'.'+id+'.tmp.'+format),size:0,header:null,aborted:false,write:Promise.resolve()};
    jobs.set(id,job);return {id,canceled:false};
  });
  ipcMain.handle('studio:export-append',async(event,{id,wav})=>{
    const job=owned(event,id);if(job.aborted)throw Error('Operación cancelada.');
    const bytes=Buffer.from(wav);if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.readUInt16LE(20)!==3||bytes.readUInt32LE(24)!==44100||bytes.readUInt16LE(22)!==2)throw Error('Formato de muestras no compatible.');
    job.write=job.write.then(async()=>{
      if(job.aborted)throw Error('Operación cancelada.');
      if(!job.header){job.header=Buffer.from(bytes.subarray(0,44));await fs.writeFile(job.input,job.header);}
      await fs.appendFile(job.input,bytes.subarray(44));job.size+=bytes.length-44;return true;
    });return job.write;
  });
  ipcMain.handle('studio:export-cancel',async(event,id)=>{const job=owned(event,id);job.aborted=true;job.child?.kill();if(!job.finishing)await discardExport(job);return true;});
  ipcMain.handle('studio:export-finish',async(event,id)=>{
    const job=owned(event,id);job.finishing=true;
    const progress=phase=>{if(!event.sender.isDestroyed())event.sender.send('studio:export-progress',{id,phase});};
    let pass=0;const runner=(bin,args)=>{progress('Procesando audio · '+(++pass));return run(bin,args,job);};
    try {
      await job.write;
      if(!job.header||job.aborted)throw Error('Operación cancelada.');
      job.header.writeUInt32LE(36+job.size,4);job.header.writeUInt32LE(job.size,40);
      const handle=await fs.open(job.input,'r+');try{await handle.write(job.header,0,44,0);}finally{await handle.close();}
      const o=job.options,encoder=binary(),master=masteringOptions(o.mastering),codec=o.format==='mp3'?['-c:a','libmp3lame','-b:a',o.bitrate+'k','-write_xing','1']:o.format==='flac'?['-c:a','flac','-sample_fmt',o.bitDepth===24?'s32':'s16','-compression_level',String(o.compression)]:['-c:a',o.bitDepth===24?'pcm_s24le':'pcm_s16le'];
      let report=null;
      if(master)report=await masterAudio({input:job.input,output:job.staged,workDir:job.dir,run:runner,binary:encoder,options:master,codec,sampleRate:o.sampleRate});
      else {
        let filter='anull';
        if(o.normalize==='peak'){
          progress('Analizando picos…');
          const log=await runner(encoder,['-hide_banner','-nostdin','-i',job.input,'-af','astats=metadata=0:reset=0','-f','null','-']);
          const value=[...log.matchAll(/Peak level dB:\s*([-\d.inf]+)/g)].at(-1)?.[1],peak=Number(value);
          if(Number.isFinite(peak))filter='volume='+(-1-peak)+'dB';
        }
        await runner(encoder,['-hide_banner','-loglevel','error','-nostdin','-y','-i',job.input,'-af',filter,'-vn',...codec,'-ar',String(o.sampleRate),'-ac','2',job.staged]);
      }
      if(job.aborted)throw Error('Operación cancelada.');
      await fs.rename(job.staged,job.file);
      await savePreferences({exportFolder:path.dirname(job.file)}).catch(()=>{});
      let cueWarning=null;
      if(o.cue && o.format==='wav' && o.sampleRate===44100 && o.bitDepth===16){
        const quote=s=>String(s).replace(/["\r\n]/g,' ').slice(0,180);
        const markers=(o.markers||[]).filter(m=>Number.isFinite(m.time)&&m.time>=0&&m.time<job.size/8/44100).sort((a,b)=>a.time-b.time).slice(0,99);
        if(!markers.length||markers[0].time>0)markers.unshift({time:0,name:o.defaultName});
        const seen=new Set();const entries=markers.filter(m=>{const frame=Math.floor(m.time*75);if(seen.has(frame))return false;seen.add(frame);return true;}).slice(0,99);
        const lines=['FILE "'+quote(path.basename(job.file))+'" WAVE'];
        entries.forEach((m,i)=>{const frame=Math.floor(m.time*75);lines.push('  TRACK '+String(i+1).padStart(2,'0')+' AUDIO','    TITLE "'+quote(m.name)+'"','    INDEX 01 '+[Math.floor(frame/4500),Math.floor(frame/75)%60,frame%75].map(x=>String(x).padStart(2,'0')).join(':'));});
        try{await atomic(job.file.replace(/\.wav$/i,'.cue'),lines.join('\n')+'\n');}catch(error){cueWarning=error.message;}
      }
      return {name:path.basename(job.file),path:job.file,mastering:report,cueWarning};
    }finally{jobs.delete(id);await fs.rm(job.staged,{force:true});await fs.rm(job.dir,{recursive:true,force:true});}
  });
}
module.exports={registerStudio,preferences,savePreferences,audioJob,tempos};
