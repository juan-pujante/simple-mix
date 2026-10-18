// Deterministic audio regressions. Optional MP3 paths are local diagnostic inputs;
// they are never copied into the repository or used as ground-truth key labels.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {registerNativeFiles}=require('../src/main/native-files.cjs');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-audio-test-'));app.setPath('userData',root);
 const checks=[],files=[],errors=[];let win;const timeout=setTimeout(()=>app.exit(1),180000);
 const check=(value,message)=>{assert.ok(value,message);checks.push(message);};
 try{
  registerNativeFiles({ipcMain,BrowserWindow,rendererUrl:pathToFileURL(path.join(__dirname, "../src/renderer/index.html")).href,dialog:{showOpenDialog:async()=>{throw Error('Unexpected dialog');},showSaveDialog:async()=>{throw Error('Unexpected dialog');}}});
  win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname, "../src/main/preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  const run=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()',true);
  await win.loadFile(path.join(__dirname, "../src/renderer/index.html"));await run('await I18n.ready;I18n.setLocale("es");');
  check(await run('return !keepPitch;'),'Startup defaults to continuous playback speed');
  check(await run('restoreStudioSettings({keepPitch:true},4);const preserved=keepPitch;projectDirty=false;await newProject();return preserved&&!keepPitch;'),'Saved key-preservation choice is respected; New resets to continuous speed');
  await run(`window.makeKeyFixture=(root,minor,drums=false)=>{const b=audio().createBuffer(1,44100*16,44100),out=b.getChannelData(0),chords=minor?[[0,3,7],[5,8,12],[7,10,14],[0,3,7]]:[[0,4,7],[5,9,12],[7,11,14],[0,4,7]];let seed=12345;for(let i=0;i<out.length;i++){const time=i/44100;for(const note of chords[Math.floor(time/4)])out[i]+=.14*Math.sin(2*Math.PI*440*2**((60+root+note-69)/12)*time);if(drums){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const beat=time%.4;out[i]+=.3*(seed/2**31-1)*Math.exp(-beat*60)+.4*Math.sin(2*Math.PI*(45*beat+2*(1-Math.exp(-beat*55))))*Math.exp(-beat*35);/* >Nyquist partials must not fold into a false bass/key. */out[i]+=.35*Math.sin(2*Math.PI*9000*time);}}return b;};`);
  for(const minor of [false,true])for(let rootNote=0;rootNote<12;rootNote++){
   const result=await run(`const t=tracks[0];t.buffer=makeKeyFixture(${rootNote},${minor});t.peaks=peaks(t.buffer);await detectKey(t);return t.key;`);
   check(result?.root===rootNote&&result?.mode===(minor?'minor':'major'),`Known ${rootNote} ${minor?'minor':'major'} progression is identified`);
  }
  for(const minor of [false,true]){
   const result=await run(`const t=tracks[0];t.buffer=makeKeyFixture(0,${minor},true);t.peaks=peaks(t.buffer);await detectKey(t);return t.key;`);
   check(result?.root===0&&result?.mode===(minor?'minor':'major'),`Percussion and high-frequency energy preserve the ${minor?'minor':'major'} estimate`);
  }
  for(const kind of ['silence','noise','tone','short'])check(await run(`const t=tracks[0],b=audio().createBuffer(1,44100*('${kind}'==='short'?.25:12),44100),out=b.getChannelData(0);let seed=42;for(let i=0;i<out.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;out[i]='${kind}'==='noise'?.2*(seed/2**31-1):'${kind}'==='tone'?.3*Math.sin(2*Math.PI*440*i/44100):0;}t.buffer=b;t.peaks=peaks(t.buffer);await detectKey(t);return !t.key;`),`${kind} does not receive an invented major/minor key`);
  check(await run(`const t=tracks[0];t.buffer=makeKeyFixture(0,false);t.peaks=peaks(t.buffer);const pending=detectKey(t);t.keyToken++;t.key=keyFromCamelot('5A');t.keyAnalyzing=false;await pending;return camelot(t.key)==='5A';`),'A manual correction survives an in-flight analysis');
  await run(`const t=tracks[0],b=audio().createBuffer(1,44100*16,44100),data=b.getChannelData(0);for(let beat=0;beat<38;beat++){const at=Math.round((.25+beat*.4)*44100);data[at]=.8;}Object.assign(t,{buffer:b,peaks:peaks(b),file:null,bpm:150,targetBpm:150,followGlobal:true,start:.123456789,volume:1,eq:[0,0,0],pitch:0,automation:[],trimIn:0,trimOut:null,muted:false,tempoAnchor:null});$('#master').value=1;$('#globalBpm').value=150;appliedGlobalBpm=150;$('#globalSync').checked=true;window.originalStart=t.start;window.tempoMetrics=[];`);
  for(const bpm of [139,161,150]){
   const metrics=await run(`$('#globalBpm').value=${bpm};await changeGlobalTempo();const t=tracks[0],rendered=await renderSession(),out=rendered.getChannelData(0),speed=${bpm}/150,errors=[];for(let beat=0;beat<38;beat++){const expected=(t.start+(.25+beat*.4)/speed)*44100;let peak=0,found=0;for(let i=Math.max(0,Math.floor(expected)-20);i<=Math.min(out.length-1,Math.ceil(expected)+20);i++)if(Math.abs(out[i])>peak){peak=Math.abs(out[i]);found=i;}if(peak<.1)throw Error('Missing beat '+beat);errors.push((found-expected)/44100);}await playSession();const live=session.nodes[0].source.playbackRate.value;stopSession();return {bpm:${bpm},maxErrorMs:Math.max(...errors.map(Math.abs))*1000,live,original:preparedBuffer(t)===t.buffer,start:t.start};`);
   check(metrics.original&&Math.abs(metrics.live-bpm/150)<1e-6&&metrics.maxErrorMs<.06,`Global ${bpm} BPM: live rate is constant and rendered beats stay within 0.06 ms`);files.push({tempo:metrics});
  }
  check(await run('return tracks[0].start===originalStart;'),'Returning to the original BPM restores exact fine placement');
  check(await run(`openSessionEditor();$('#keepPitch').checked=true;$('#applyRegion').click();$('#sessionDialog').close();checkpoint();const enabled=keepPitch;undoEdit();const undone=!keepPitch;undoEdit(true);return enabled&&undone&&keepPitch;`),'Optional key preservation can be applied, undone and redone');

  await run(`keepPitch=false;const t=tracks[0];t.start=0;t.followGlobal=false;t.targetEdited=false;t.tempoAnchor=null;`);
  for(const sourceBpm of [137.3,145.2,149.9,168.25]){
   const measured=await run(`const t=tracks[0],b=audio().createBuffer(1,44100*60,44100),out=b.getChannelData(0),period=60/${sourceBpm};for(let i=0;i<out.length;i++){const time=i/44100-.137;if(time>=0){const beat=time%period;out[i]=.7*Math.sin(2*Math.PI*70*beat)*Math.exp(-beat*55);}}t.buffer=b;t.peaks=peaks(b);await detectBpm(t);return {bpm:t.bpm,source:sourceTempo(t),phase:t.firstBeat,rate:rate(t)};`);
   check(measured.bpm===Math.round(sourceBpm)&&Math.abs(measured.source-sourceBpm)<.005&&Math.abs(measured.phase-.137)<.006&&Math.abs(measured.rate-Math.round(sourceBpm)/sourceBpm)<.00005,`${sourceBpm} BPM: accurate source, rounded target, adjusted speed and beat phase within 6 ms`);files.push({measurement:measured});
  }
  check(await run(`const t=tracks[0];t.file=new File([floatWav(t.buffer).blob],'precise-tempo.wav');const expected=sourceTempo(t),phase=t.firstBeat,json=await serializeProject();await openProject(new File([json],'precise.simplemix'));return sourceTempo(tracks[0])===expected&&tracks[0].firstBeat===phase;`),'Save/open preserves precise source BPM and beat origin');
  check(await run(`const t=tracks[0],input=trackEl(t).querySelector('.source-bpm');input.value=160;input.dispatchEvent(new Event('change'));return sourceTempo(t)===160&&t.sourceBpm===null;`),'Manual source BPM overrides the automatic fractional measurement');

  check(await run(`const mono=makeKeyFixture(0,false),b=audio().createBuffer(2,mono.length,44100);b.copyToChannel(mono.getChannelData(0),0);b.copyToChannel(Float32Array.from(mono.getChannelData(0),v=>-v),1);const t=tracks[0];t.buffer=b;t.peaks=peaks(b);await detectKey(t);return camelot(t.key)==='8B';`),'Antiphase stereo preserves the tonal estimate');
  check(await run(`const t=tracks[0],b=audio().createBuffer(1,44100*60,44100),data=b.getChannelData(0);let seed=42;for(let i=0;i<data.length;i++){const time=i/44100-.137;if(time<0)continue;const beat=time%.4,hat=(time+.2)%.4;seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=.7*Math.sin(2*Math.PI*70*beat)*Math.exp(-beat*55)+.5*(seed/2**31-1)*Math.exp(-hat*95);}t.buffer=b;t.peaks=peaks(b);await detectBpm(t);if(t.bpm!==150||Math.abs(t.firstBeat-.137)>.006)throw Error(JSON.stringify({bpm:t.bpm,phase:t.firstBeat}));return true;`),'Beat grid follows kicks rather than offbeat hi-hats');
  await run(`const t=tracks[0];Object.assign(t,{bpm:150,bpmMode:'manual',sourceBpm:null,targetBpm:150,followGlobal:false,start:2.3456789,automation:[]});selection.clear();const second=addTrack({...snapshot().tracks[0],start:3.456789});selectTrack(t);selection.add(t.id);selection.add(second.id);view.zoom=1;timeline();view.zoom=view.total/.5;view.start=20;timeline();window.pixelHash=canvas=>{const d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let hash=0,ink=0;for(let i=0;i<d.length;i+=4){hash=(Math.imul(hash,31)+d[i]+d[i+1]+d[i+2]+d[i+3])|0;if(d[i+3])ink++;}return {hash,ink};};`);
  check(await run('return !$("#snapBeats").checked;'),'Dragging is free by default; beat snapping is opt-in');
  for(const delta of [37,-53]){
   const before=await run(`const c=document.querySelector('.clip'),row=c.parentElement,r=row.getBoundingClientRect();window.draggedClip=c;return {x:Math.round(r.left+r.width*.55),y:Math.round(r.top+r.height*.5),width:r.width,start:tracks[0].start,other:tracks[1].start,view:view.start,span:timelineDuration,hash:pixelHash(c.querySelector('canvas')).hash};`);
   win.webContents.sendInputEvent({type:'mouseMove',x:before.x,y:before.y});win.webContents.sendInputEvent({type:'mouseDown',x:before.x,y:before.y,button:'left',clickCount:1});
   win.webContents.sendInputEvent({type:'mouseMove',x:before.x+delta,y:before.y,movementX:delta,movementY:0,button:'left'});await new Promise(r=>setTimeout(r,50));
   const during=await run(`const c=document.querySelector('.clip'),r=c.getBoundingClientRect(),row=c.parentElement.getBoundingClientRect();return {connected:c===draggedClip&&c.isConnected,visible:!c.hidden&&r.left>=row.left-1&&r.width>row.width*.95,...pixelHash(c.querySelector('canvas')),start:tracks[0].start,other:tracks[1].start,view:view.start,span:timelineDuration};`);
   check(during.connected&&during.visible&&during.ink>100&&during.hash!==before.hash,`Waveform redraws visibly while dragging ${delta>0?'right':'left'} inside a zoomed clip: ${JSON.stringify({during,beforeHash:before.hash})}`);
   check(Math.abs(during.start-(Math.round((before.start+delta/before.width*before.span)*44100)/44100))<1e-9&&Math.abs((during.other-during.start)-(before.other-before.start))<1e-12,'Free dragging preserves group offsets without snapping to the grid');
   win.webContents.sendInputEvent({type:'mouseUp',x:before.x+delta,y:before.y,button:'left',clickCount:1});await new Promise(r=>setTimeout(r,30));
   check(await run(`return view.start===${before.view}&&Math.abs(timelineDuration-${before.span})<1e-12;`),'Releasing a drag preserves viewport origin and time scale');
  }
  await run(`$('#nudgeStep').value='.001';document.querySelector('.clip').focus({preventScroll:true});window.beforeNudge={view:view.start,span:timelineDuration,start:tracks[0].start};`);
  for(const keyCode of ['Right','Right','Left']){win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});}
  await new Promise(r=>setTimeout(r,50));
  check(await run('return view.start===beforeNudge.view&&Math.abs(timelineDuration-beforeNudge.span)<1e-12&&Math.abs(tracks[0].start-beforeNudge.start-.001)<1e-12;'),'Arrow keys move the selected group without jumping to the clip start or changing zoom');
  await fs.mkdir(path.join(__dirname,'../artifacts'),{recursive:true});await fs.writeFile(path.join(__dirname,'../artifacts/drag-waveform.png'),(await win.webContents.capturePage()).toPNG());
  for(const file of process.argv.slice(2)){
   const bytes=await fs.readFile(file),name=path.basename(file);
   const result=await run(`const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0)),t=tracks[0];keepPitch=false;await load(t,new File([bytes],${JSON.stringify(name)},{type:'audio/mpeg'}));openHarmony(t);const result={name:t.name,bpm:t.bpm,sourceBpm:sourceTempo(t),firstBeat:t.firstBeat,key:t.key,camelot:camelot(t.key),label:$('#keyConfidence').textContent};$('#harmonyDialog').close();return result;`);
   files.push(result);check(!!result.key,`Local MP3 produces a key estimate: ${name}`);
  }
  check(!errors.length,'No renderer errors');console.log(JSON.stringify({checks,diagnostics:files},null,2));
 }catch(error){console.error(error);console.error({passed:checks,errors});process.exitCode=1;}
 finally{clearTimeout(timeout);win?.destroy();await fs.rm(root,{recursive:true,force:true,maxRetries:5}).catch(()=>{});app.exit(process.exitCode||0);}
});
