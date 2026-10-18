const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {registerNativeFiles}=require('../src/main/native-files.cjs');
const store=require('../src/main/project-store.cjs');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-audit-'));app.setPath('userData',path.join(root,'profile'));await fs.mkdir(app.getPath('userData'),{recursive:true});
 const saves=[],opens=[],checks=[],errors=[];const check=(value,message)=>{assert.ok(value,message);checks.push(message);};
 registerNativeFiles({ipcMain,BrowserWindow,rendererUrl:pathToFileURL(path.join(__dirname, "../src/renderer/index.html")).href,dialog:{showSaveDialog:async()=>{assert(saves.length,'Unexpected save dialog');return saves.shift();},showOpenDialog:async()=>{assert(opens.length,'Unexpected open dialog');return opens.shift();}}});
 const studio=require('../src/main/desktop-window.cjs').createStudioWindows({showSplash:false}),win=studio.main;
 win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
 const run=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()',true),wait=()=>new Promise(r=>setTimeout(r,80));
 const timeout=setTimeout(()=>{console.error('Audit test timeout');app.exit(1);},150000);
 try{
  await studio.ready;await run('await I18n.ready;I18n.setLocale("es");');
  await run(`const b=audio().createBuffer(2,44100*12,44100);for(let c=0;c<2;c++)for(let i=0;i<b.length;i++){const t=i/44100;b.getChannelData(c)[i]=(c?-1:1)*.7*Math.sin(2*Math.PI*70*t)*Math.exp(-(t%(60/140))*55);}await load(tracks[0],new File([floatWav(b).blob],'test.wav',{type:'audio/wav'}));keepPitch=false;tracks[0].followGlobal=false;tracks[0].targetBpm=tracks[0].bpm;`);
  check(await run('return tracks[0].bpm===140&&tracks[0].bpmMode==="auto";'),'Anti-phase stereo preserves automatic BPM detection');
  check(await run(`const original=prepareTrack;try{prepareTrack=async()=>{await new Promise(r=>setTimeout(r,60));};const pending=play(tracks[0]);stop(tracks[0]);await pending;return !tracks[0].playing&&!tracks[0].pending&&!tracks[0].node;}finally{prepareTrack=original;}`),'Stop cancels an individual playback still preparing its audio');
  check(await run(`const original=prepareTrack;try{prepareTrack=async()=>{await new Promise(r=>setTimeout(r,60));};const pending=playSession();await playSession();await pending;return !session.playing&&!session.pending&&!session.nodes.length;}finally{prepareTrack=original;}`),'A second play/pause command cancels pending session playback');
  check(await run(`const original=prepareTrack;try{prepareTrack=async()=>{throw Error('Expected preparation failure');};await playSession();return !session.playing&&!session.pending;}finally{prepareTrack=original;}`),'Audio preparation failure leaves transport stopped and usable');
  check(await run(`loopRegion={enabled:true,start:20,end:30};await playSession();const ok=!session.playing&&!session.pending;loopRegion.enabled=false;return ok;`),'An A–B region beyond the audio cannot start an empty playback loop');
  await run('await play(tracks[0]);stopSession();');check(await run('return !tracks[0].playing&&!tracks[0].node;'),'Global stop also stops the individual audition');
  check(await run(`const original=encodedFile;try{encodedFile=async file=>{await new Promise(r=>setTimeout(r,50));return original(file);};$('#projectName').value='Before';$('#globalBpm').value=140;const pending=serializeProject();$('#projectName').value='After';$('#globalBpm').value=150;const doc=JSON.parse(await pending);$('#globalBpm').value=140;return doc.name==='Before'&&doc.settings.globalBpm===140;}finally{encodedFile=original;}`),'Project serialization captures name and settings before asynchronous audio encoding');
  saves.push({canceled:false,filePath:path.join(root,'Concurrent.simplemix')});
  check(await run(`const original=encodedFile;try{encodedFile=async file=>{await new Promise(r=>setTimeout(r,50));return original(file);};const pending=saveProject();$('#projectName').value='Newer change';markDirty();const result=await pending;return !result&&projectDirty&&activeProject?.path;}finally{encodedFile=original;}`),'Changes arriving during a save remain dirty instead of being silently discarded');
  await run('await saveProject();');
  check(await run(`$('#exportFormat').value='flac';$('#exportRate').value='48000';$('#exportDepth').value='24';$('#mp3Bitrate').value='192';$('#flacCompression').value='8';updateExportOptions();const text=$('#exportFormatHint').textContent;const content=await serializeProject();$('#exportRate').value='44100';await openProject(new File([content],'Roundtrip.simplemix'));return $('#exportFormat').value==='flac'&&$('#exportRate').value==='48000'&&$('#exportDepth').value==='24'&&$('#mp3Bitrate').value==='192'&&$('#flacCompression').value==='8'&&text.includes('48 kHz')&&text.includes('24 bits');`),'Export format, bitrate, sample rate and bit depth survive project round trip with accurate labels');
  check(await run(`checkpoint();tracks[0].start=1;markDirty();checkpoint();openTrackEditor(tracks[0]);const selected=tracks[0];undoEdit();const ok=tracks[0]===selected&&tracks[0].start===1;$('#trackDialog').close();undoEdit();return ok&&tracks[0].start===0;`),'Document undo cannot invalidate an open editing dialog and works again after closing it');
  await run(`customSelects.get($('#nudgeStep')).button.focus();`);const position=await run('return tracks[0].start;');
  for(const keyCode of ['Left','Right']){win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});}await wait();check(await run('return tracks[0].start;')===position,'Arrow keys in a custom selector do not accidentally move the selected track');
  check(await run(`const s=document.createElement('select');document.body.append(s);refreshCustomSelects();openCustomSelect(s);const ok=!activeSelect;s.remove();refreshCustomSelects();return ok;`),'An empty custom selector does not crash');
  for(const open of ['openTrackEditor(tracks[0])','openHarmony(tracks[0])','openSessionEditor()','await openPreferences()']){
   check(await run(`${open};const d=document.querySelector('dialog[open]'),title=document.getElementById(d.getAttribute('aria-labelledby'));const ok=!!title&&!!title.textContent.trim();d.close();return ok;`),'Accessible dialog name: '+open);
  }
  const beforeWindows=BrowserWindow.getAllWindows().length;await run(`window.open('about:blank');`);await wait();check(BrowserWindow.getAllWindows().length===beforeWindows,'App windows reject unexpected popups');
  const originalUrl=win.webContents.getURL();await run(`const a=document.createElement('a');a.href='https://example.invalid/';document.body.append(a);a.click();a.remove();`);await wait();check(win.webContents.getURL()===originalUrl,'Renderer navigation cannot replace the local editor');
  check(await run(`return document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("script-src 'self'");`),'Application has a local-script Content Security Policy');
  check(await run(`tracks[0].name='<img src=x onerror="window.injected=true">';update(tracks[0]);timeline();openHarmony(tracks[0]);const ok=!window.injected&&!document.querySelector('.harmony-track img')&&document.querySelector('.harmony-track').textContent===tracks[0].name;$('#harmonyDialog').close();return ok;`),'Imported track names stay plain text in timeline, inspector and harmony dialog');
  await run('projectDirty=false;await simpleMix.setDirty(false);busy=true;lock(true);await simpleMix.setBusy(true);');win.close();await wait();check(!win.isDestroyed(),'Closing a saved project during an active operation does not interrupt its output');await run('busy=false;lock(false);await simpleMix.setBusy(false);');
  const content=await run('return serializeProject();'),folder=path.join(root,'Managed');await fs.mkdir(folder);const project=path.join(folder,'test.simplemix');await store.writeProject(project,content);
  const doc=JSON.parse(await fs.readFile(project,'utf8')),asset=path.join(folder,doc.tracks[0].asset);await fs.writeFile(asset,'damaged');await assert.rejects(store.readProject(project),/dañado/);checks.push('Damaged managed audio is rejected by content hash');
  await store.writeProject(project,content);check(JSON.parse(await store.readProject(project)).tracks[0].audio.length>0,'Saving repairs a damaged managed copy from the imported source');
  doc.tracks[0].asset='../outside.audio';await fs.writeFile(project,JSON.stringify(doc));await assert.rejects(store.readProject(project),/Ruta de audio/);checks.push('Project asset traversal outside the project directory is rejected');
  if(process.platform!=='win32'){const linked=path.join(root,'Linked'),outside=path.join(root,'Outside');await fs.mkdir(linked);await fs.mkdir(outside);await fs.symlink(outside,path.join(linked,'Audio'));await assert.rejects(store.writeProject(path.join(linked,'test.simplemix'),content),/Ruta de audio/);check(!(await fs.readdir(outside)).length,'Saving refuses an Audio symlink pointing outside the project');}
  const cancelPath=path.join(root,'Cancel-existing.wav');await fs.writeFile(cancelPath,'Original destination');saves.push({canceled:false,filePath:cancelPath});
  check(await run(`const job=await simpleMix.beginExport({...exportOptions(),format:'wav',sampleRate:44100,bitDepth:16,defaultName:'Cancel'});const wav=await floatWav(tracks[0].buffer).blob.arrayBuffer();await Promise.allSettled([simpleMix.appendExport({id:job.id,wav}),simpleMix.cancelExport(job.id)]);return true;`),'Export cancellation waits for an in-flight audio write');
  check(await fs.readFile(cancelPath,'utf8')==='Original destination','Canceling export preserves an existing destination');

  await run(`tracks[0].start=0;loopRegion={enabled:false,start:0,end:3};$('#normalize').value='none';openSessionEditor();await prepareMasterPreview();`);
  check(await run(`const p=previewBuffers;return !!p&&Math.abs(p.original.duration-3)<.001&&Math.abs(p.mastered.duration-3)<.05&&Number.isFinite(p.compensation)&&p.compensation>0;`),'Master preview processes the A–B region with finite loudness compensation');
  await run(`await playMasterPreview(true);$('#sessionDialog').close();`);await wait();check(await run('return previewSource===null;'),'Closing A–B comparison stops its audition');
  const codecPath=path.join(root,'Cancel-codec.mp3');await fs.writeFile(codecPath,'Existing encoded file');saves.push({canceled:false,filePath:codecPath});
  check(await run(`const job=await simpleMix.beginExport({...exportOptions(),format:'mp3',sampleRate:44100,bitDepth:16,defaultName:'Cancel codec',mastering:masteringSettings()});await simpleMix.appendExport({id:job.id,wav:await floatWav(tracks[0].buffer).blob.arrayBuffer()});let canceled=false;const unsubscribe=simpleMix.onExportProgress(progress=>{if(progress.id===job.id&&!canceled){canceled=true;simpleMix.cancelExport(job.id).catch(()=>{});}});try{await simpleMix.finishExport(job.id);return false;}catch(error){return canceled&&error.message.includes('cancelada');}finally{unsubscribe();}`),'Cancel interrupts native mastering after processing starts');
  check(await fs.readFile(codecPath,'utf8')==='Existing encoded file','Cancel during encoding leaves the existing output unchanged');
  await run('await clearRecovery();');
  const recoveryDir=path.join(app.getPath('userData'),'Recovery'),seed=require('node:crypto').randomUUID()+'.simplemix';await fs.mkdir(recoveryDir,{recursive:true});await store.writeProject(path.join(recoveryDir,seed),content);
  const recoveryStudio=require('../src/main/desktop-window.cjs').createStudioWindows({showSplash:false});await recoveryStudio.ready;const recoveredWindow=recoveryStudio.main;
  const recoverRun=code=>recoveredWindow.webContents.executeJavaScript('(async()=>{'+code+'})()',true);
  for(let attempt=0;attempt<50&&!await recoverRun('return !!document.querySelector("[data-choice=recover]");');attempt++)await wait();
  await recoverRun('document.querySelector("[data-choice=recover]").click();');
  let recovered=false;for(let attempt=0;attempt<100;attempt++){recovered=await recoverRun('return !busy&&projectDirty&&!!tracks[0]?.buffer;');if(recovered)break;await wait();}
  check(recovered,'Restart offers recovery and restores audio as an unsaved session');await recoverRun('await recoveryTask;');
  for(let attempt=0;attempt<50&&await fs.stat(path.join(recoveryDir,seed)).catch(()=>null);attempt++)await wait();
  const recoveryFiles=(await fs.readdir(recoveryDir)).filter(name=>name.endsWith('.simplemix'));
  check(!recoveryFiles.includes(seed)&&recoveryFiles.length>0,'Recovery keeps a new durable copy before deleting the previous recovery file');recoveredWindow.destroy();
  const failures=errors.filter(e=>!e.includes('Expected preparation failure'));check(!failures.length,'Audit scenarios produce no unexpected renderer errors: '+failures.join('; '));
  clearTimeout(timeout);console.log(JSON.stringify({checks},null,2));win.destroy();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});app.exit(0);
 }catch(error){console.error(error);console.error(errors.join('\n'));clearTimeout(timeout);win.destroy();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});app.exit(1);}
});
