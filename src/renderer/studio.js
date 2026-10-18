// Studio document operations, history, audio preparation and desktop workflows.
'use strict';
const selection=new Set();
let loopRegion={enabled:false,start:0,end:16},markers=[],keepPitch=false;
let studioReady=false,historyApplying=false,historyTimer=null,autosaveTimer=null,recoveryWriting=false,recoveryTask=Promise.resolve();
let studioHistory={past:[],future:[],present:null,gesture:false};
let exportJob=null,exportCanceled=false,previewSource=null,previewBuffers=null,previewToken=0;
const fileEncodings=new WeakMap(),preparedAudio=new WeakMap();
let masterMeter=null,masterBus=null,clipHold=0;
const sourceStart=track=>Math.max(0,track.trimIn||0);
const sourceEnd=track=>Math.min(track.buffer?.duration||0,track.trimOut??track.buffer?.duration??0);
const audible=track=>!track.muted&&(!tracks.some(t=>t.solo)||track.solo);
const levelFactor=track=>(audible(track)?1:0)*track.volume*Number($('#master').value)*10**((track.trimGain||0)/20);
const loopEnabled=()=>loopRegion.enabled&&loopRegion.end>loopRegion.start;
const preparedKey=track=>[rate(track),track.pitch||0,keepPitch].join(':');
function preparedBuffer(track){const value=preparedAudio.get(track.buffer)?.get(preparedKey(track));return value||track.buffer;}
function sourcePlaybackRate(track){return preparedBuffer(track)!==track.buffer?1:rate(track);}
function preparedOffset(track,time){return preparedBuffer(track)!==track.buffer?time/rate(track):time;}
function reportError(error){status(I18n.t(error.message||String(error)));}
async function encodedFile(file){if(!fileEncodings.has(file))fileEncodings.set(file,file.arrayBuffer().then(b=>base64(new Uint8Array(b))));return fileEncodings.get(file);}
async function prepareTrack(track){
  if(!track.buffer||!window.simpleMix?.processAudio||(!keepPitch&&!track.pitch)||rate(track)===1&&!track.pitch)return;
  const buffer=track.buffer,key=preparedKey(track),options={rate:rate(track),pitch:track.pitch||0,keepPitch};
  let cache=preparedAudio.get(buffer);if(!cache){cache=new Map();preparedAudio.set(buffer,cache);}if(cache.has(key))return;
  status('Preparando tempo y tonalidad…');
  const result=await window.simpleMix.processAudio({audio:track.file?await track.file.arrayBuffer():await floatWav(buffer).blob.arrayBuffer(),...options});
  const processed=await audio().decodeAudioData(new Uint8Array(result.audio).buffer);
  cache.set(key,processed);while(cache.size>2)cache.delete(cache.keys().next().value);
  if(track.buffer===buffer&&key!==preparedKey(track))await prepareTrack(track);
}
async function prepareTracks(list){for(const track of [...new Set(list)])await prepareTrack(track);}
function outputTarget(context){
  if(context!==ctx)return context.destination;
  if(!masterBus){masterBus=ctx.createGain();masterMeter=ctx.createAnalyser();masterMeter.fftSize=2048;masterBus.connect(masterMeter);masterMeter.connect(ctx.destination);}
  return masterBus;
}
function curveValue(a,b,x,curve){x=clamp(x,0,1);if(curve==='smooth')x=x*x*(3-2*x);if(curve==='exponential')x=x*x; if(curve==='equal')return Math.sqrt((1-x)*a*a+x*b*b);return a+(b-a)*x;}
function scheduleValues(param,points,from,to,when,speed,fallback=1,curve='linear'){
  const value=t=>{
    if(!points.length)return fallback;if(t<=points[0].time)return points[0].value;
    for(let i=1;i<points.length;i++)if(t<=points[i].time){const a=points[i-1],b=points[i];return curveValue(a.value,b.value,(t-a.time)/(b.time-a.time),a.curve||curve);}
    return points.at(-1).value;
  };
  param.cancelScheduledValues(when);param.setValueAtTime(value(from),when);
  const times=[from,...points.filter(p=>p.time>from&&p.time<to).map(p=>p.time),to];
  for(let i=1;i<times.length;i++){
    const a=times[i-1],b=times[i],steps=curve==='linear'&&!points.some(p=>p.curve&&p.curve!=='linear')?1:32;
    for(let n=1;n<=steps;n++){const t=a+(b-a)*n/steps;param.linearRampToValueAtTime(value(t),when+(t-from)/speed);}
  }
}
function scheduleEnvelope(param,track,from,to,when,speed){scheduleValues(param,track.automation,from,to,when,speed,1,track.fadeCurve||'linear');}
function scheduleTone(node,track,from,to,when,speed){
  node.filters.forEach((filter,i)=>scheduleValues(filter.gain,track.eqAutomation?.[i]||[],from,to,when,speed,track.eq[i]));
  scheduleValues(node.tone.frequency,track.filterAutomation||[],from,to,when,speed,track.filterHz||20000);
}
function syncLiveMix(){
  if(!ctx)return;
  for(const node of [...session.nodes,...tracks.map(t=>t.node).filter(Boolean)]){
    const track=node.track;if(!tracks.includes(track))continue;
    node.level.gain.setTargetAtTime(levelFactor(track),ctx.currentTime,.008);
    const now=Math.max(ctx.currentTime,node.scheduledStart||ctx.currentTime);
    const from=node===track.node?position(track):sourceStart(track)+(Math.max(track.start,sessionPosition())-track.start)*rate(track);
    scheduleTone(node,track,from,sourceEnd(track),now,rate(track));
    scheduleEnvelope(node.gain.gain,track,from,sourceEnd(track),now,rate(track));
  }
}
function extraTrackData(t){return {sourceBpm:Number.isFinite(t.sourceBpm)?t.sourceBpm:null,key:t.key?{...t.key}:null,name:t.name,trimIn:sourceStart(t),trimOut:t.trimOut==null?null:sourceEnd(t),solo:!!t.solo,locked:!!t.locked,group:t.group||'',color:t.color,firstBeat:t.firstBeat||0,pitch:t.pitch||0,trimGain:t.trimGain||0,fadeCurve:t.fadeCurve||'linear',eqAutomation:t.eqAutomation||[[],[],[]],filterAutomation:t.filterAutomation||[],filterHz:t.filterHz||20000};}
function validateExtraTrack(t,buffer){
  const length=buffer?.duration||0,from=t.trimIn??0,to=t.trimOut??length;
  const finite=(v,a,b)=>Number.isFinite(v)&&v>=a&&v<=b;
  if(!finite(from,0,length)||!finite(to,from,length)||(buffer&&from===to))throw Error('Recorte de audio no válido.');
  const eq=t.eqAutomation||[[],[],[]],filter=t.filterAutomation||[];
  const valid=(p,min,max)=>Array.isArray(p)&&p.every((v,i)=>finite(v.time,0,length)&&finite(v.value,min,max)&&(!i||v.time>p[i-1].time));
  if(eq.length!==3||!eq.every(p=>valid(p,-24,12))||!valid(filter,20,20000))throw Error('Automatización inválida.');
  for(const [key,min,max] of [['pitch',-12,12],['trimGain',-24,24],['firstBeat',0,Math.max(0,length)],['filterHz',20,20000]])if(t[key]!==undefined&&!finite(t[key],min,max))throw Error('Configuración de pista inválida');
  const key=t.key&&Number.isInteger(t.key.root)&&t.key.root>=0&&t.key.root<12&&['major','minor'].includes(t.key.mode)?{root:t.key.root,mode:t.key.mode,confidence:clamp(t.key.confidence,0,1),source:t.key.source==='manual'?'manual':'auto'}:null;
  const sourceBpm=t.sourceBpm==null?null:t.sourceBpm;if(sourceBpm!==null&&!finite(sourceBpm,40,240))throw Error('Configuración de pista inválida');
  return {sourceBpm,key,trimIn:from,trimOut:buffer?to:null,solo:!!t.solo,locked:!!t.locked,group:typeof t.group==='string'?t.group:'',name:typeof t.name==='string'?t.name:'',color:/^#[a-f0-9]{6}$/i.test(t.color)?t.color:undefined,firstBeat:t.firstBeat||0,pitch:t.pitch||0,trimGain:t.trimGain||0,fadeCurve:['linear','equal','smooth','exponential'].includes(t.fadeCurve)?t.fadeCurve:'linear',eqAutomation:eq,filterAutomation:filter,filterHz:t.filterHz||20000};
}
function studioSettings(){return {gainMatching:{...gainMatchSettings},keepPitch,loop:{...loopRegion},markers:markers.map(m=>({...m})),export:{format:$('#exportFormat').value,bitrate:Number($('#mp3Bitrate').value),compression:Number($('#flacCompression').value),sampleRate:Number($('#exportRate').value),bitDepth:Number($('#exportDepth').value),region:$('#exportRegion').checked,cue:$('#exportCue').checked}};}
function restoreStudioSettings(value,version){
  keepPitch=version>=4?!!value.keepPitch:false;
  gainMatchSettings={target:Number.isFinite(value.gainMatching?.target)&&value.gainMatching.target>=-30&&value.gainMatching.target<=-9?value.gainMatching.target:-18,mode:value.gainMatching?.mode==='reduce'?'reduce':'auto'};
  const l=value.loop;loopRegion=l&&Number.isFinite(l.start)&&Number.isFinite(l.end)&&l.start>=0&&l.end>l.start&&l.end<=10800?{start:l.start,end:l.end,enabled:!!l.enabled}:{start:0,end:16,enabled:false};
  markers=Array.isArray(value.markers)?value.markers.filter(m=>Number.isFinite(m.time)&&m.time>=0&&m.time<=10800&&typeof m.name==='string').map(m=>({...m})):[];
  const output=value.export||{};for(const [id,key,allowed,fallback]of [['exportFormat','format',['wav','flac','mp3'],'wav'],['mp3Bitrate','bitrate',[128,160,192,224,256,320],320],['flacCompression','compression',[0,5,8],5],['exportRate','sampleRate',[44100,48000],44100],['exportDepth','bitDepth',[16,24],16]])$('#'+id).value=allowed.includes(output[key])?output[key]:fallback;$('#exportRegion').checked=!!output.region;$('#exportCue').checked=!!output.cue;updateExportOptions();
  selection.clear();
}
function snapshot(){return {name:$('#projectName').value,settings:{...settings(),...studioSettings()},selected:tracks.findIndex(t=>t.id===selectedId),view:{...view},tracks:tracks.map(t=>({file:t.file,buffer:t.buffer,peaks:t.peaks,name:t.name,bpm:t.bpm,targetBpm:t.targetBpm,targetEdited:t.targetEdited,followGlobal:t.followGlobal,volume:t.volume,eq:[...t.eq],start:t.start,bars:t.bars,muted:t.muted,bpmMode:t.bpmMode,bpmConfidence:t.bpmConfidence,...JSON.parse(JSON.stringify(extraTrackData(t))),automation:t.automation.map(p=>({...p}))}))};}
function snapshotKey(s){return JSON.stringify({...s,view:null,selected:null,tracks:s.tracks.map(t=>({...t,file:t.file?{name:t.file.name,size:t.file.size,lastModified:t.file.lastModified}:null,buffer:null,peaks:null}))},(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);}
function checkpoint(){
  if(!studioReady||historyApplying)return;
  const current=snapshot();if(studioHistory.present&&snapshotKey(current)!==snapshotKey(studioHistory.present)){
    studioHistory.past.push(studioHistory.present);if(studioHistory.past.length>60)studioHistory.past.shift();studioHistory.future=[];
  }
  studioHistory.present=current;updateHistoryButtons();
}
function updateHistoryButtons(){if(!$('#undo'))return;$('#undo').disabled=!studioHistory.past.length||busy;$('#redo').disabled=!studioHistory.future.length||busy;}
function restoreSnapshot(saved){
  historyApplying=true;stopSession();tracks.forEach(stop);tracks.splice(0);$('#decks').replaceChildren();
  $('#projectName').value=saved.name;$('#globalBpm').value=saved.settings.globalBpm;appliedGlobalBpm=saved.settings.globalBpm;$('#globalSync').checked=saved.settings.globalSync;$('#master').value=saved.settings.master;$('#curve').value=saved.settings.curve;$('#normalize').value=saved.settings.normalize;$('#nudgeStep').value=saved.settings.nudgeStep;applyMasteringSettings(saved.settings.mastering);restoreStudioSettings(saved.settings,4);
  saved.tracks.forEach(t=>addTrack({...t,eq:[...t.eq],automation:t.automation.map(p=>({...p})),eqAutomation:t.eqAutomation.map(p=>p.map(v=>({...v}))),filterAutomation:t.filterAutomation.map(p=>({...p}))}));
  Object.assign(view,saved.view);if(tracks[saved.selected])selectTrack(tracks[saved.selected]);timeline();historyApplying=false;markDirty();updateHistoryButtons();
}
function undoEdit(redo=false){if(busy||document.querySelector('dialog[open]'))return;clearTimeout(historyTimer);checkpoint();const from=redo?studioHistory.future:studioHistory.past,to=redo?studioHistory.past:studioHistory.future;if(!from.length)return;to.push(studioHistory.present);studioHistory.present=from.pop();restoreSnapshot(studioHistory.present);status(redo?'Cambio rehecho.':'Cambio deshecho.');}
function studioDirty(){
  if(!studioReady)return;window.simpleMix?.setDirty(true).catch(reportError);previewToken++;previewBuffers=null;
  if(!historyApplying){clearTimeout(historyTimer);historyTimer=setTimeout(checkpoint,studioHistory.gesture?350:0);}
  clearTimeout(autosaveTimer);autosaveTimer=setTimeout(autosave,12000);
}
async function autosave(){
  if(!window.simpleMix?.recovery||!projectDirty||busy||recoveryWriting)return false;
  recoveryWriting=true;
  recoveryTask=recoveryTask.catch(()=>{}).then(async()=>{await window.simpleMix.recovery({action:'write',content:await serializeProject()});return true;}).catch(error=>{status('No se pudo guardar la recuperación: '+error.message);return false;}).finally(()=>{recoveryWriting=false;});
  return await recoveryTask;
}
function clearRecovery(){
  clearTimeout(autosaveTimer);
  recoveryTask=recoveryTask.catch(()=>{}).then(()=>window.simpleMix?.recovery({action:'clear'}));
  return recoveryTask;
}
function studioSaved(info){clearTimeout(autosaveTimer);window.simpleMix?.setDirty(false).catch(reportError);clearRecovery().catch(reportError);if(info?.path)window.simpleMix?.recent(info.path).catch(reportError);checkpoint();}
function studioOpened(){studioHistory={past:[],future:[],present:snapshot(),gesture:false};studioSaved(activeProject);updateHistoryButtons();}
function choiceDialog(title,message,choices){return new Promise(resolve=>{
  const dialog=document.createElement('dialog');dialog.className='choice-dialog';const h=document.createElement('h2');h.textContent=I18n.t(title);const p=document.createElement('p');p.textContent=I18n.t(message);const actions=document.createElement('div');actions.className='dialog-actions';
  const finish=value=>{dialog.close();dialog.remove();resolve(value);};
  choices.forEach(([value,label])=>{const button=document.createElement('button');button.textContent=I18n.t(label);button.dataset.choice=value;button.onclick=()=>finish(value);actions.append(button);});
  h.id='choice-title-'+Date.now();dialog.setAttribute('aria-labelledby',h.id);dialog.append(h,p,actions);dialog.oncancel=e=>{e.preventDefault();finish('cancel');};document.body.append(dialog);dialog.showModal();
});}
async function confirmUnsaved(){
  if(busy)return false;if(!projectDirty)return true;
  const answer=await choiceDialog('Cambios sin guardar','Guarda los cambios antes de continuar.',[['save','Guardar'],['discard','Descartar'],['cancel','Cancelar']]);
  if(answer==='save')return saveProject();return answer==='discard';
}
async function newProject(){
  if(busy||document.querySelector('dialog[open]')||!await confirmUnsaved())return;
  if(window.simpleMix?.newProject)await window.simpleMix.newProject();
  stopSession();tracks.forEach(stop);tracks.splice(0);$('#decks').replaceChildren();activeProject=null;resetMasterReport();
  $('#projectName').value=I18n.t('Mi sesión');$('#globalBpm').value=140;appliedGlobalBpm=140;$('#globalSync').checked=true;$('#master').value=.85;$('#normalize').value='peak';applyMasteringSettings(MASTER_PROFILES.balanced);
  restoreStudioSettings({keepPitch:false},4);$('#snapBeats').checked=false;view.zoom=1;view.start=0;addTrack();projectDirty=false;updateProjectFile(null);studioOpened();status('Nueva sesión.');
}
function selectionGesture(track,event){
  if(event.shiftKey){const anchor=tracks.findIndex(t=>t.id===selectedId),end=tracks.indexOf(track);if(anchor>=0)for(let i=Math.min(anchor,end);i<=Math.max(anchor,end);i++)selection.add(tracks[i].id);}
  else if(event.ctrlKey||event.metaKey){if(!selection.size&&selectedId!==track.id)selection.add(selectedId);selection.has(track.id)?selection.delete(track.id):selection.add(track.id);}
  else if(!selection.has(track.id)){selection.clear();selection.add(track.id);}
  document.querySelectorAll('.clip').forEach(c=>c.classList.toggle('multi-selected',selection.has(Number(c.dataset.trackId))));
}
function moveSelection(track,delta){
  const group=tracks.filter(t=>!t.locked&&(t===track||selection.has(track.id)&&selection.has(t.id)||track.group&&track.group===t.group));
  delta=clamp(delta,-Math.min(...group.map(t=>t.start)),10800-Math.max(...group.map(t=>t.start)));
  group.forEach(t=>{t.start+=delta;t.tempoAnchor=null;const input=trackEl(t)?.querySelector('.track-start');if(input)input.value=t.start;});
}
function estimateFirstBeat(track){
  if(!track.buffer)return 0;const data=track.buffer.getChannelData(0),sr=track.buffer.sampleRate,period=60/sourceTempo(track),frames=Math.floor(period*sr),limit=Math.min(data.length,Math.round(sr*20));
  const buckets=new Float64Array(256);for(let i=0;i<limit;i+=Math.max(1,Math.floor(sr/4000))){buckets[Math.floor((i%frames)/frames*256)]+=data[i]*data[i];}
  let best=0;for(let i=1;i<buckets.length;i++)if(buckets[i]>buckets[best])best=i;return best/256*period;
}
function drawBeatGrid(g,track,width,height,from,to){
  const step=60/sourceTempo(track);if((to-from)/step>256)return;const first=track.firstBeat||0;
  g.save();g.strokeStyle='#dbe3ec55';g.lineWidth=1;
  for(let beat=Math.ceil((from-first)/step);first+beat*step<=to;beat++){const x=(first+beat*step-from)/(to-from)*width;g.beginPath();g.moveTo(x,0);g.lineTo(x,beat%4===0?height:height*.24);g.stroke();}g.restore();
}
function extendRail(track,rail,head,mute){
  const peak=document.createElement('span');peak.className='track-peak';peak.dataset.peakTrack=track.id;peak.setAttribute('aria-hidden','true');rail.append(peak);
  const solo=document.createElement('button');solo.className='rail-solo icon-button';solo.dataset.soloTrack=track.id;solo.textContent='S';solo.title=I18n.t('Solo');solo.setAttribute('aria-label',I18n.t('Solo')+' · '+(track.name||tracks.indexOf(track)+1));solo.setAttribute('aria-pressed',String(!!track.solo));solo.onclick=()=>{const focused=document.activeElement===solo;track.solo=!track.solo;markDirty();syncLiveMix();timeline();if(focused)document.querySelector('[data-solo-track="'+track.id+'"]')?.focus({preventScroll:true});};rail.append(solo);
  head.onclick=e=>{selectionGesture(track,e);selectTrack(track);};head.ondblclick=()=>openTrackEditor(track);
}
function decorateArrangement(){
  if(!$('#timeline'))return;document.querySelectorAll('.clip').forEach(c=>c.classList.toggle('multi-selected',selection.has(Number(c.dataset.trackId))));
  const width=$('#timeline').clientWidth-timelineRailWidth();
  const add=(time,name,cls)=>{if(time<view.start||time>view.start+timelineDuration)return;const mark=document.createElement('span');mark.className='session-marker '+cls;mark.style.left=timelineRailWidth()+(time-view.start)/timelineDuration*width+'px';mark.title=name;mark.setAttribute('aria-label',name);$('#timeline').append(mark);};
  markers.forEach(m=>add(m.time,m.name,'marker-user'));if(loopEnabled()){add(loopRegion.start,'A','marker-loop');add(loopRegion.end,'B','marker-loop');}
}
function extendTrack(track,el){
  const defaults={trimIn:0,trimOut:null,solo:false,locked:false,group:'',firstBeat:0,pitch:0,trimGain:0,fadeCurve:'linear',eqAutomation:[[],[],[]],filterAutomation:[],filterHz:20000};for(const [k,v]of Object.entries(defaults))if(track[k]===undefined)track[k]=v;
  if(!track.color)track.color='#d89b75';el.style.setProperty('--track-color',track.color);
  const button=document.createElement('button');button.className='edit-clip';button.textContent='Editar';button.onclick=()=>openTrackEditor(track);el.querySelector('.load').before(button);const harmony=document.createElement('button');harmony.className='key-button';harmony.textContent='Armonía';harmony.onclick=()=>openHarmony(track);button.before(harmony);
  el.querySelector('.track-name').setAttribute('translate','no');
}
function field(label,id,value,type='number',attrs=''){return `<label>${label}<input id="${id}" type="${type}" ${attrs}></label>`;}
function openTrackEditor(track){
  if(busy)return;const d=$('#trackDialog');d.innerHTML=`<div class="export-title"><h2>Editar pista</h2><button class="close-dialog icon-button" data-icon="close" aria-label="Cerrar"></button></div><div class="form-grid">
  ${field('Nombre','clipName','','text')}${field('Color','clipColor','','color')}${field('Recorte inicial · s','trimIn',0,'number','min="0" step="any"')}${field('Recorte final · s','trimOut',0,'number','min="0" step="any"')}
  ${field('Primer beat · s','firstBeat',0,'number','min="0" step="any"')}${field('Tonalidad · semitonos','clipPitch',0,'number','min="-12" max="12" step="1"')}${field('Ganancia previa · dB','trimGain',0,'number','min="-24" max="24" step=".1"')}${field('Grupo','clipGroup','','text')}
  <label>Curva de fades<select id="fadeCurve"><option value="linear">Lineal</option><option value="equal">Potencia constante</option><option value="smooth">Suave</option><option value="exponential">Exponencial</option></select></label><label class="check-control"><input id="clipLocked" type="checkbox"> Bloquear posición</label></div>
  <div class="dialog-actions"><button id="halfTempo">BPM ÷ 2</button><button id="doubleTempo">BPM × 2</button><button id="alignBeat">Alinear beat al cursor</button><button id="phrase8">8 compases</button><button id="phrase16">16 compases</button><button id="phrase32">32 compases</button></div>
  <div class="dialog-actions"><button id="duplicateClip">Duplicar</button><button id="splitClip">Dividir en el cursor</button><button id="moveUp">Subir</button><button id="moveDown">Bajar</button><button id="matchLoudness">Igualar a −18 LUFS</button></div>
  <div class="dialog-actions"><button id="beatPrevious">Beat anterior</button><button id="beatNext">Beat siguiente</button><button id="beatAtCursor">Primer beat en cursor</button><button id="alignPrevious">Alinear con pista anterior</button><button id="reanalyzeBeats">Analizar beats</button></div><details><summary>Automatización de EQ y filtro</summary><div class="form-grid"><label>Parámetro<select id="eqLane"><option value="0">Graves</option><option value="1">Medios</option><option value="2">Agudos</option><option value="filter">Filtro paso bajo</option></select></label>${field('Tiempo original · s','eqTime',0,'number','min="0" step=".001"')}${field('Valor · dB / Hz','eqValue',0,'number','step=".1"')}</div><div class="dialog-actions"><button id="addEqPoint">Añadir punto</button><button id="clearEqPoints">Restablecer parámetro</button></div><div id="eqPoints"></div></details><p id="clipAnalysis" role="status"></p><div class="dialog-actions"><button class="primary" id="applyClip">Aplicar</button></div>`;
  for(const [id,value]of Object.entries({clipName:track.name,clipColor:track.color,trimIn:sourceStart(track),trimOut:sourceEnd(track),firstBeat:track.firstBeat,clipPitch:track.pitch,trimGain:track.trimGain,clipGroup:track.group,fadeCurve:track.fadeCurve}))$('#'+id).value=value;
  $('#clipLocked').checked=track.locked;$('#clipAnalysis').textContent=track.bpmConfidence!==null?I18n.t('Confianza del tempo')+': '+Math.round(track.bpmConfidence*100)+'%':'';
  const apply=()=>{
    const from=Number($('#trimIn').value),to=Number($('#trimOut').value);if(track.buffer&&(!(to>from)||from<0||to>track.buffer.duration)){status('Recorte de audio no válido.');return false;}
    checkpoint();stop(track);edited();Object.assign(track,{name:$('#clipName').value,trimIn:from,trimOut:track.buffer?to:null,firstBeat:clamp($('#firstBeat').value,0,track.buffer?.duration||0),pitch:clamp($('#clipPitch').value,-12,12),trimGain:clamp($('#trimGain').value,-24,24),group:$('#clipGroup').value,locked:$('#clipLocked').checked,color:$('#clipColor').value,fadeCurve:$('#fadeCurve').value});
    // Curve applies explicitly to existing volume segments as well as new ones.
    track.automation.forEach(p=>p.curve=track.fadeCurve);trackEl(track).style.setProperty('--track-color',track.color);track.offset=sourceStart(track);update(track);timeline();markDirty();return true;
  };
  d.querySelector('.close-dialog').onclick=()=>d.close();$('#applyClip').onclick=()=>{if(apply())d.close();};
  for(const [id,factor]of [['halfTempo',.5],['doubleTempo',2]])$('#'+id).onclick=()=>{const next=track.bpm*factor;if(next<40||next>240)return;checkpoint();stop(track);track.detectToken++;track.bpm=next;track.bpmMode='manual';track.sourceBpm=null;edited();update(track);};
  for(const [id,direction]of [['beatPrevious',-1],['beatNext',1]])$('#'+id).onclick=()=>{
    const period=60/sourceTempo(track),current=sourceStart(track)+(sessionPosition()-track.start)*rate(track),relative=(current-track.firstBeat)/period;
    const index=direction>0?Math.floor(relative+1e-6)+1:Math.ceil(relative-1e-6)-1;
    pauseSession();session.offset=Math.max(0,track.start+(track.firstBeat+index*period-sourceStart(track))/rate(track));updateClock();
    view.zoom=view.total/(4*60/targetTempo(track));view.start=Math.max(0,session.offset-60/targetTempo(track));timeline();
  };
  $('#beatAtCursor').onclick=()=>{$('#firstBeat').value=clamp(sourceStart(track)+(sessionPosition()-track.start)*rate(track),0,track.buffer?.duration||0);};
  $('#alignPrevious').onclick=()=>{
    if(track.locked)return;const previous=tracks.slice(0,tracks.indexOf(track)).filter(t=>t.buffer).at(-1);if(!previous)return;
    const reference=previous.start+(previous.firstBeat-sourceStart(previous))/rate(previous),period=60/targetTempo(previous);
    const anchor=track.start+(track.firstBeat-sourceStart(track))/rate(track),target=reference+Math.round((anchor-reference)/period)*period;
    checkpoint();moveSelection(track,target-anchor);edited();
  };
  $('#reanalyzeBeats').onclick=async()=>{await detectBpm(track);$('#firstBeat').value=track.firstBeat;$('#clipAnalysis').textContent=I18n.t('Confianza del tempo')+': '+Math.round((track.bpmConfidence||0)*100)+'%';};
  $('#alignBeat').onclick=()=>{if(track.locked)return;checkpoint();const next=sessionPosition()-(track.firstBeat-sourceStart(track))/rate(track);moveSelection(track,Math.max(0,next)-track.start);edited();};
  for(const bars of [8,16,32])$('#phrase'+bars).onclick=()=>{if(track.locked)return;checkpoint();const quantum=bars*4*60/Number($('#globalBpm').value);const beatPosition=track.start+(track.firstBeat-sourceStart(track))/rate(track);moveSelection(track,Math.round(beatPosition/quantum)*quantum-beatPosition);edited();};
  $('#duplicateClip').onclick=()=>{if(!apply())return;checkpoint();const copy=snapshot().tracks[tracks.indexOf(track)];const duplicate=addTrack({...copy,start:Math.min(10800,track.start+duration(track)),name:track.name+' '+I18n.t('(copia)')});markDirty();selectTrack(duplicate);d.close();};
  $('#splitClip').onclick=()=>{if(track.locked||!track.buffer)return;const at=sourceStart(track)+(sessionPosition()-track.start)*rate(track);if(at<=sourceStart(track)||at>=sourceEnd(track)){status('Sitúa el cursor dentro de la pista.');return;}checkpoint();edited();const copy=snapshot().tracks[tracks.indexOf(track)],end=sourceEnd(track);track.trimOut=at;addTrack({...copy,trimIn:at,trimOut:end,start:sessionPosition()});markDirty();timeline();d.close();};
  for(const [id,delta]of [['moveUp',-1],['moveDown',1]])$('#'+id).onclick=()=>{const i=tracks.indexOf(track),j=i+delta;if(j<0||j>=tracks.length)return;checkpoint();tracks.splice(i,1);tracks.splice(j,0,track);tracks.forEach(t=>$('#decks').append(trackEl(t)));timelinePage=Math.floor(j/PAGE_SIZE);renumber();timeline();markDirty();};
  $('#matchLoudness').onclick=async()=>{if(!track.buffer||!window.simpleMix?.processAudio)return;const b=$('#matchLoudness');b.disabled=true;try{const from=Number($('#trimIn').value),to=Number($('#trimOut').value);if(!(to>from)||from<0||to>track.buffer.duration)throw Error('Recorte de audio no válido.');const measurement=await measureGainTrack({...track,trimIn:from,trimOut:to},{canceled:false}),row=gainProposal([{measurement,previous:track.trimGain||0}],-18,'auto').rows[0];if(row.gain===null){$('#clipAnalysis').textContent='No medible';return;}$('#trimGain').value=row.gain.toFixed(2);$('#clipAnalysis').textContent=`${measurement.lufs.toFixed(2)} LUFS · ${row.gain.toFixed(2)} dB`;}catch(e){reportError(e);}finally{b.disabled=false;}};
  const lane=()=>$('#eqLane').value==='filter'?track.filterAutomation:track.eqAutomation[Number($('#eqLane').value)];
  const list=()=>{$('#eqPoints').replaceChildren(...lane().map((p,i)=>{const row=document.createElement('div');row.className='automation-point';row.textContent=`${p.time.toFixed(3)} s · ${p.value} `;const del=document.createElement('button');del.textContent='×';del.setAttribute('aria-label',I18n.t('Eliminar punto')+' '+(i+1));del.onclick=()=>{checkpoint();lane().splice(i,1);markDirty();syncLiveMix();list();};row.append(del);return row;}));};
  $('#eqLane').onchange=()=>{$('#eqValue').value=$('#eqLane').value==='filter'?20000:0;list();};$('#eqTime').value=clamp(sourceStart(track)+(sessionPosition()-track.start)*rate(track),0,track.buffer?.duration||0);
  $('#addEqPoint').onclick=()=>{if(!track.buffer)return;checkpoint();const values=lane(),time=clamp($('#eqTime').value,0,track.buffer.duration),isFilter=$('#eqLane').value==='filter',value=clamp($('#eqValue').value,isFilter?20:-24,isFilter?20000:12);const index=values.findIndex(p=>p.time===time);if(index>=0)values.splice(index,1);values.push({time,value});values.sort((a,b)=>a.time-b.time);markDirty();syncLiveMix();list();};
  $('#clearEqPoints').onclick=()=>{checkpoint();lane().splice(0);markDirty();syncLiveMix();list();};list();decorateIcons(d);I18n.render(d);d.showModal();
}
function openSessionEditor(){
  if(busy)return;const d=$('#sessionDialog');d.innerHTML=`<div class="export-title"><h2>Sesión</h2><button class="close-dialog icon-button" data-icon="close" aria-label="Cerrar"></button></div><div class="form-grid"><label class="check-control"><input id="loopEnabled" type="checkbox"> Repetir región A–B</label><label class="check-control"><input id="keepPitch" type="checkbox"> Conservar tonalidad</label>${field('Inicio A · s','loopStart',0,'number','min="0" step="any"')}${field('Final B · s','loopEnd',16,'number','min="0" step="any"')}</div><p class="harmony-help">Sin conservar tonalidad: velocidad continua, como en la 1.3.x; el tono cambia con los BPM. Al conservarla, el estiramiento puede alterar los golpes de percusión.</p><div class="dialog-actions"><button id="setLoopStart">A en cursor</button><button id="setLoopEnd">B en cursor</button><button id="applyRegion">Aplicar</button><button id="previewMaster">Comparar máster A/B</button></div><p id="previewStatus" role="status"></p><div id="previewActions" hidden><button id="previewA">A · Original</button><button id="previewB">B · Máster</button><button id="previewStop">Detener</button></div><div class="dialog-actions"><button id="addMarker">Marcador en cursor</button><button id="portableProject">Copia portátil…</button><button id="matchSessionGain">Igualar pistas…</button></div><div id="markerList"></div>`;
  $('#loopStart').value=loopRegion.start;$('#loopEnd').value=loopRegion.end;$('#loopEnabled').checked=loopRegion.enabled;$('#keepPitch').checked=keepPitch;$('#keepPitch').disabled=!window.simpleMix?.processAudio;
  d.querySelector('.close-dialog').onclick=()=>d.close();d.onclose=()=>{previewToken++;previewSource?.stop();previewSource=null;};
  $('#setLoopStart').onclick=()=>$('#loopStart').value=sessionPosition();$('#setLoopEnd').onclick=()=>$('#loopEnd').value=sessionPosition();
  $('#applyRegion').onclick=()=>{const start=Number($('#loopStart').value),end=Number($('#loopEnd').value);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>10800)return status('Región no válida.');checkpoint();loopRegion={start,end,enabled:$('#loopEnabled').checked};keepPitch=$('#keepPitch').checked;edited();timeline();status('Región actualizada.');};
  const list=()=>{$('#markerList').replaceChildren(...markers.map((m,i)=>{const row=document.createElement('div');row.className='marker-row';const time=document.createElement('button');time.textContent=format(m.time);time.onclick=()=>{pauseSession();session.offset=m.time;updateClock();};const name=document.createElement('input');name.value=m.name;name.setAttribute('aria-label',I18n.t('Nombre del marcador'));name.onchange=()=>{m.name=name.value;markDirty();timeline();};const del=document.createElement('button');del.textContent='×';del.setAttribute('aria-label',I18n.t('Eliminar marcador'));del.onclick=()=>{checkpoint();markers.splice(i,1);markDirty();list();timeline();};row.append(time,name,del);return row;}));};
  $('#addMarker').onclick=()=>{checkpoint();markers.push({time:sessionPosition(),name:I18n.t('Marcador')+' '+(markers.length+1)});markers.sort((a,b)=>a.time-b.time);markDirty();list();timeline();};
  $('#portableProject').onclick=async()=>{if(busy)return;busy=true;lock(true);try{const content=await serializeProject();const result=window.simpleMix?await window.simpleMix.saveProject({content,portable:true,defaultName:safeName()+' portable.simplemix'}):(download(new Blob([content],{type:'application/json'}),safeName()+'.simplemix'),{});if(!result.canceled)status('Copia portátil guardada.');}catch(e){reportError(e);}finally{busy=false;lock(false);}};
  $('#matchSessionGain').onclick=openGainDialog;
  $('#previewMaster').onclick=prepareMasterPreview;
  $('#previewA').onclick=()=>playMasterPreview(false);$('#previewB').onclick=()=>playMasterPreview(true);$('#previewStop').onclick=()=>{previewSource?.stop();previewSource=null;};
  list();decorateIcons(d);I18n.render(d);d.showModal();
}
async function prepareMasterPreview(){
  if(!window.simpleMix?.previewMaster)return;const button=$('#previewMaster');button.disabled=true;const token=++previewToken;
  try{
    const from=loopRegion.start,to=Math.min(loopRegion.end,from+30,Math.max(0,...plan().map(i=>i.end)));if(to<=from)throw Error('Región no válida.');
    $('#previewStatus').textContent=I18n.t('Preparando comparación de hasta 30 segundos…');await prepareTracks(plan().map(i=>i.track));
    const offline=new OfflineAudioContext(2,Math.ceil((to-from)*44100),44100);schedule(offline,plan(),from,0,to);const original=await offline.startRendering();
    const result=await window.simpleMix.previewMaster({wav:await floatWav(original).blob.arrayBuffer(),mastering:masteringSettings()});if(token!==previewToken)return;
    const mastered=await audio().decodeAudioData(new Uint8Array(result.audio).buffer);previewBuffers={original,mastered,compensation:result.compensation};$('#previewActions').hidden=false;$('#previewStatus').textContent=I18n.t('Comparación con sonoridad compensada.');
  }catch(error){reportError(error);$('#previewStatus').textContent=I18n.t(error.message);}finally{button.disabled=false;}
}
async function playMasterPreview(mastered){if(!previewBuffers)return;const token=previewToken;pauseSession();tracks.forEach(stop);previewSource?.stop();await audio().resume();if(token!==previewToken||!$('#sessionDialog').open)return;const node=ctx.createBufferSource(),gain=ctx.createGain();node.buffer=mastered?previewBuffers.mastered:previewBuffers.original;gain.gain.value=mastered?previewBuffers.compensation:1;node.connect(gain);gain.connect(ctx.destination);node.onended=()=>{node.disconnect();gain.disconnect();};node.start();previewSource=node;}
async function exportInBlocks(options){
  if(busy)return false;busy=true;lock(true);exportCanceled=false;
  const cancel=$('#cancelExport');cancel.disabled=false;cancel.setAttribute('aria-label',I18n.t('Cancelar exportación'));cancel.onclick=()=>{exportCanceled=true;if(exportJob)window.simpleMix.cancelExport(exportJob).catch(()=>{});};
  try{
    const items=plan();if(!items.length)throw Error('Carga al menos una pista sin silenciar.');
    const allEnd=Math.max(...items.map(i=>i.end)),region=$('#exportRegion').checked;
    const from=region?loopRegion.start:0,to=region?Math.min(loopRegion.end,allEnd):allEnd;if(to<=from||to>10800)throw Error('Región no válida.');
    const opts={...exportOptions(),...options,normalize:$('#normalize').value,sampleRate:Number($('#exportRate').value),bitDepth:Number($('#exportDepth').value),defaultName:safeName(),cue:$('#exportCue').checked,markers:markers.filter(m=>m.time>=from&&m.time<to).map(m=>({...m,time:m.time-from}))};
    const job=await window.simpleMix.beginExport(opts);if(job.canceled)return false;exportJob=job.id;
    await prepareTracks(items.map(i=>i.track));
    const first=Math.round(from*44100),last=Math.ceil(to*44100),block=44100*10;
    for(let frame=first;frame<last;frame+=block){
      if(exportCanceled)throw Error('Operación cancelada.');const count=Math.min(block,last-frame),offset=frame/44100;
      const warmup=Math.min(frame,44100),warmFrom=(frame-warmup)/44100;
      const offline=new OfflineAudioContext(2,count+warmup,44100);schedule(offline,items,warmFrom,0,(frame+count)/44100);const full=await offline.startRendering();
      const rendered=new AudioBuffer({numberOfChannels:2,length:count,sampleRate:44100});for(let channel=0;channel<2;channel++)rendered.copyToChannel(full.getChannelData(channel).subarray(warmup),channel);
      if(exportCanceled)throw Error('Operación cancelada.');await window.simpleMix.appendExport({id:exportJob,wav:await floatWav(rendered).blob.arrayBuffer()});
      $('#exportProgress').textContent=I18n.t('Renderizando')+' · '+Math.round((frame+count-first)/(last-first)*100)+'%';await new Promise(r=>setTimeout(r,0));
    }
    const result=await window.simpleMix.finishExport(exportJob);exportJob=null;if(result.mastering)lastMasterReport={...result.mastering,name:result.name};
    $('#exportDialog').close();status(I18n.t('Exportado')+': '+result.name+(result.cueWarning?' · CUE: '+result.cueWarning:''));if(result.mastering)showMasterReport();return true;
  }catch(error){status(I18n.t(error.message));$('#exportProgress').textContent=I18n.t(error.message);if(exportJob)await window.simpleMix.cancelExport(exportJob).catch(()=>{});return false;}
  finally{exportJob=null;busy=false;lock(false);cancel.onclick=()=>$('#exportDialog').close();updateHistoryButtons();}
}
async function openPreferences(){
  if(busy)return;const prefs=await window.simpleMix?.preferences()||{language:I18n.locale()};const d=$('#preferencesDialog');d.innerHTML=`<div class="export-title"><h2>Preferencias</h2><button class="close-dialog icon-button" data-icon="close" aria-label="Cerrar"></button></div><div class="form-grid"><label>Idioma<select id="language"><option value="es">Español</option><option value="en">English</option></select></label><label>Salida de audio<select id="audioOutput"><option value="">Sistema</option></select></label></div><p>Ctrl/Cmd+N · Nuevo<br>Ctrl/Cmd+O · Abrir<br>Ctrl/Cmd+S · Guardar<br>Ctrl/Cmd+Z · Deshacer<br>Ctrl/Cmd+Shift+Z · Rehacer<br>Espacio · Reproducir / pausar<br>Ctrl/Cmd + clic · Selección múltiple</p><h2>Proyectos recientes</h2><div id="recentProjects"></div>`;
  $('#language').value=I18n.locale();$('#language').onchange=async()=>{I18n.setLocale($('#language').value);await window.simpleMix?.preferences({language:I18n.locale()});I18n.render();updateProjectFile();};
  try{const devices=await navigator.mediaDevices.enumerateDevices();for(const item of devices.filter(x=>x.kind==='audiooutput')){const option=document.createElement('option');option.value=item.deviceId;option.textContent=item.label||I18n.t('Salida de audio');$('#audioOutput').append(option);}$('#audioOutput').value=prefs.output||'';}catch{}
  $('#audioOutput').disabled=typeof AudioContext.prototype.setSinkId!=='function';$('#audioOutput').onchange=async()=>{try{await audio().setSinkId($('#audioOutput').value);await window.simpleMix?.preferences({output:$('#audioOutput').value});}catch(error){reportError(error);}};
  for(const file of prefs.recent||[]){const button=document.createElement('button');button.textContent=file.split(/[\\/]/).at(-1);button.title=file;button.setAttribute('translate','no');button.onclick=async()=>{if(!await confirmUnsaved())return;try{const result=await window.simpleMix.openRecent(file);d.close();await openProject(new File([result.content],result.name),result);}catch(e){reportError(e);}};$('#recentProjects').append(button);}
  d.querySelector('.close-dialog').onclick=()=>d.close();decorateIcons(d);I18n.render(d);d.showModal();
}
function mountStudio(){
  const nav=document.querySelector('.file-actions');nav.insertAdjacentHTML('afterbegin','<button id="newProject" data-icon="plus" title="Nuevo proyecto (Ctrl/Cmd+N)">Nuevo</button><button id="undo" class="icon-button" title="Deshacer (Ctrl/Cmd+Z)" aria-label="Deshacer" data-icon="undo"></button><button id="redo" class="icon-button" title="Rehacer (Ctrl/Cmd+Shift+Z)" aria-label="Rehacer" data-icon="redo"></button>');
  document.querySelector('.app-header').insertAdjacentHTML('beforeend','<button id="preferences" class="icon-button" title="Preferencias" aria-label="Preferencias" data-icon="settings"></button>');
  document.querySelector('.intro').insertAdjacentHTML('beforeend','<button id="sessionTools">Sesión…</button><div class="peak-meter" role="meter" aria-label="Nivel de pico máster" aria-valuemin="-60" aria-valuemax="6" aria-valuenow="-60"><span id="peakFill"></span><output id="peakLabel">−∞</output></div>');
  document.body.insertAdjacentHTML('beforeend','<dialog id="trackDialog"></dialog><dialog id="harmonyDialog"></dialog><dialog id="sessionDialog"></dialog><dialog id="preferencesDialog"></dialog>');
  document.querySelector('#exportFormatHint').insertAdjacentHTML('beforebegin','<div class="form-grid export-extra"><label>Frecuencia<select id="exportRate"><option value="44100">44,1 kHz</option><option value="48000">48 kHz</option></select></label><label>Profundidad<select id="exportDepth"><option value="16">16 bit</option><option value="24">24 bit</option></select></label><label class="check-control"><input id="exportRegion" type="checkbox"> Región A–B</label><label class="check-control"><input id="exportCue" type="checkbox"> Índices CD (CUE)</label></div>');
}
async function initializeStudio(){
  studioReady=true;keepPitch=false;studioHistory.present=snapshot();updateHistoryButtons();
  $('#newProject').onclick=newProject;$('#undo').onclick=()=>undoEdit();$('#redo').onclick=()=>undoEdit(true);$('#preferences').onclick=openPreferences;$('#sessionTools').onclick=openSessionEditor;
  document.addEventListener('pointerdown',()=>{if(!busy){checkpoint();studioHistory.gesture=true;}},true);
  document.addEventListener('pointerup',()=>{studioHistory.gesture=false;clearTimeout(historyTimer);queueMicrotask(checkpoint);},true);
  document.addEventListener('change',()=>{queueMicrotask(checkpoint);},true);
  document.addEventListener('keydown',event=>{
    if(!(event.metaKey||event.ctrlKey)||event.altKey||busy||document.querySelector('dialog[open]'))return;const key=event.key.toLowerCase();
    if(key==='z'&&!event.target.closest('input,textarea,[contenteditable]')){event.preventDefault();event.stopImmediatePropagation();undoEdit(event.shiftKey);}
    if(key==='n'){event.preventDefault();newProject();}
  },true);
  window.simpleMix?.onAction(action=>{if(busy)return;const editable=document.activeElement?.closest('input,textarea,[contenteditable]');if(action==='undo'||action==='redo'){if(editable)document.execCommand(action);else undoEdit(action==='redo');}else if(document.querySelector('dialog[open]'))return;else if(action==='new')newProject();else if(action==='preferences')openPreferences();else if(action==='export')$('#export').click();else if(action==='open')$('#openProject').click();else if(action==='save')saveProject();else if(action==='saveAs')saveProject(true);});
  window.simpleMix?.onClose(async()=>{if(busy){status('Espera a que termine la operación o cancela la exportación.');return;}if(document.querySelector('.choice-dialog[open]'))return;if(await confirmUnsaved()){await clearRecovery();await window.simpleMix.closeApproved();}});
  window.simpleMix?.onExportProgress(({id,phase})=>{if(id===exportJob)$('#exportProgress').textContent=I18n.t(phase);});
  decorateIcons();setupExportDesign();
  try{
    const prefs=await window.simpleMix?.preferences();if(prefs?.language)I18n.setLocale(prefs.language);else I18n.render();await I18n.ready;if(!projectDirty&&!tracks.some(t=>t.buffer))$('#projectName').value=I18n.t('Mi sesión');
    if(prefs?.output&&typeof AudioContext.prototype.setSinkId==='function')await audio().setSinkId(prefs.output).catch(()=>{});
    const recovery=await window.simpleMix?.recovery({action:'list'});
    if(recovery?.length){const entry=recovery[0];const answer=await choiceDialog('Recuperar sesión','Hay una sesión sin guardar de una ejecución anterior.',[['recover','Recuperar'],['discard','Descartar'],['cancel','Más tarde']]);if(answer==='recover'){if(await openProject(new File([entry.content],'Recovered.simplemix'))){activeProject=null;projectDirty=true;updateProjectFile(null);studioDirty();if(await autosave())await window.simpleMix.recovery({action:'remove',id:entry.id});}}else if(answer==='discard')await window.simpleMix.recovery({action:'remove',id:entry.id});}
    await window.simpleMix?.setDirty(projectDirty);
  }catch(error){reportError(error);}
  setInterval(()=>{for(const node of session.nodes){const indicator=document.querySelector('[data-peak-track="'+node.track.id+'"]');if(!indicator)continue;const samples=new Float32Array(node.meter.fftSize);node.meter.getFloatTimeDomainData(samples);let level=0;for(const sample of samples)level=Math.max(level,Math.abs(sample));indicator.style.width=clamp(level*100,0,100)+'%';indicator.style.background=level>=1?'#d47a61':'#6d9d91';}if(!session.playing)document.querySelectorAll('.track-peak').forEach(el=>el.style.width='0');if(!masterMeter)return;const data=new Float32Array(masterMeter.fftSize);masterMeter.getFloatTimeDomainData(data);let peak=0;for(const x of data)peak=Math.max(peak,Math.abs(x));const db=peak?20*Math.log10(peak):-60;if(db>=0)clipHold=Date.now()+2000;$('#peakFill').style.width=clamp((db+60)/66*100,0,100)+'%';$('#peakFill').classList.toggle('clipping',Date.now()<clipHold);$('#peakLabel').textContent=peak?db.toFixed(1)+' dBFS':'−∞';$('#peakFill').parentElement.setAttribute('aria-valuenow',String(Math.max(-60,db)));},100);
  setInterval(()=>{if(projectDirty)autosave();},60000);
}
mountStudio();
