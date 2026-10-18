// Fixed, non-destructive track gain. Measurements never alter source audio.
'use strict';
let gainMatchSettings={target:-18,mode:'auto'};
const gainMeasurements=new WeakMap();
let gainDialogState=null;
const gainRangeKey=t=>JSON.stringify([sourceStart(t),sourceEnd(t),t.buffer.numberOfChannels]);
function gainProposal(entries,target,mode){
  const valid=entries.filter(e=>Number.isFinite(e.measurement?.lufs)&&Number.isFinite(e.measurement?.truePeak));
  const effective=mode==='reduce'&&valid.length?Math.min(target,...valid.map(e=>e.measurement.lufs+e.previous)):target;
  return {target:effective,rows:entries.map(entry=>{
    if(!valid.includes(entry))return {...entry,gain:null,after:null,limited:false};
    const {lufs,truePeak}=entry.measurement,wanted=effective-lufs;
    const limit=Math.min(wanted,-3.1-truePeak,12,mode==='reduce'?entry.previous:Infinity);
    const gain=Math.floor(clamp(limit,-24,24)*100+1e-8)/100;
    return {...entry,gain,after:lufs+gain,limited:Math.abs(lufs+gain-effective)>.11};
  })};
}
function overlapRegions(items){
  const points=[...new Set(items.flatMap(i=>[i.start,i.end]))].sort((a,b)=>a-b),regions=[];
  for(let i=1;i<points.length;i++){
    const start=points[i-1],end=points[i],count=items.filter(item=>item.start<end&&item.end>start).length;
    if(count>=2&&end>start){const previous=regions.at(-1);if(previous&&Math.abs(previous.end-start)<1e-9){previous.end=end;previous.count=Math.max(previous.count,count);}else regions.push({start,end,count,peak:null});}
  }
  return regions;
}
function gainJobCheck(job){if(job.canceled)throw Error('Operación cancelada.');}
async function gainMeasure(bytes,job,options={}){
  gainJobCheck(job);const id=crypto.randomUUID();job.measurementId=id;
  try{const result=await window.simpleMix.processAudio({audio:bytes,measure:true,measurementId:id,...options});gainJobCheck(job);return result.measurement;}
  finally{job.measurementId=null;}
}
async function measureGainTrack(track,job){
  gainJobCheck(job);let cache=gainMeasurements.get(track.buffer);if(!cache){cache=new Map();gainMeasurements.set(track.buffer,cache);}
  const key=gainRangeKey(track);if(cache.has(key))return cache.get(key);
  const bytes=track.file?await track.file.arrayBuffer():await floatWav(track.buffer).blob.arrayBuffer();
  const measurement=await gainMeasure(bytes,job,{analysisRange:[sourceStart(track),sourceEnd(track)],analysisMono:track.buffer.numberOfChannels===1});
  cache.set(key,measurement);while(cache.size>4)cache.delete(cache.keys().next().value);return measurement;
}
async function measureGainOverlaps(rows,job,progress=()=>{}){
  const gains=new Map(rows.filter(r=>r.gain!==null).map(r=>[r.track,r.gain]));
  const originals=plan(),regions=overlapRegions(originals);if(!regions.length)return regions;
  await prepareTracks(originals.filter(i=>regions.some(r=>i.start<r.end&&i.end>r.start)).map(i=>i.track));gainJobCheck(job);
  const items=originals.map(item=>({...item,track:{...item.track,trimGain:gains.has(item.track)?gains.get(item.track):item.track.trimGain}}));
  const total=regions.reduce((n,r)=>n+r.end-r.start,0);let done=0;
  for(const region of regions){
    const first=Math.floor(region.start*44100),last=Math.ceil(region.end*44100);
    for(let frame=first;frame<last;frame+=441000){
      gainJobCheck(job);const count=Math.min(441000,last-frame),warmup=Math.min(frame,44100),offline=new OfflineAudioContext(2,count+warmup,44100);
      schedule(offline,items,(frame-warmup)/44100,0,(frame+count)/44100);
      const rendered=await offline.startRendering();gainJobCheck(job);
      const clipped=new AudioBuffer({numberOfChannels:2,length:count,sampleRate:44100});for(let c=0;c<2;c++)clipped.copyToChannel(rendered.getChannelData(c).subarray(warmup),c);
      const measurement=await gainMeasure(await floatWav(clipped).blob.arrayBuffer(),job);
      if(Number.isFinite(measurement.truePeak))region.peak=region.peak===null?measurement.truePeak:Math.max(region.peak,measurement.truePeak);
      done+=count/44100;progress(Math.min(100,Math.round(done/total*100)));
    }
  }
  return regions;
}
function gainSelection(scope){return tracks.filter(t=>t.buffer&&(scope==='all'||selection.has(t.id)||!selection.size&&t.id===selectedId));}
function gainReportCurrent(state){return state.report&&state.report.revision===documentRevision&&state.report.rows.every(r=>tracks.includes(r.track)&&r.track.buffer===r.buffer&&gainRangeKey(r.track)===r.range);}
function renderGainReport(){
  const state=gainDialogState,d=document.querySelector('#gainDialog');if(!state||!d)return;
  const report=state.report,rows=report?.rows||[],pages=Math.max(1,Math.ceil(rows.length/5));state.page=Math.min(state.page,pages-1);
  d.querySelector('#gainRows').replaceChildren();
  if(!rows.length){const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.textContent='Analiza las pistas para revisar la ganancia propuesta.';row.append(cell);d.querySelector('#gainRows').append(row);}
  for(const row of rows.slice(state.page*5,state.page*5+5)){
    const tr=document.createElement('tr'),name=document.createElement('td');name.textContent=row.track.name||I18n.t('Sin audio');name.title=name.textContent;name.setAttribute('translate','no');tr.append(name);
    for(const value of [row.measurement.lufs===null?'—':row.measurement.lufs.toFixed(1),row.gain===null?'—':row.previous.toFixed(1)+' → '+row.gain.toFixed(1),row.after===null?'No medible':row.after.toFixed(1)+(row.limited?' *':'')]){const cell=document.createElement('td');cell.textContent=value;tr.append(cell);}d.querySelector('#gainRows').append(tr);
  }
  d.querySelector('#gainPage').textContent=(state.page+1)+' / '+pages;d.querySelector('#gainPrevious').disabled=state.running||!state.page;d.querySelector('#gainNext').disabled=state.running||state.page>=pages-1;
  d.querySelector('#applyGain').disabled=state.running||!gainReportCurrent(state)||!rows.some(r=>r.gain!==null);
  d.querySelector('#gainSummary').textContent=report?I18n.t('Objetivo efectivo')+': '+report.target.toFixed(1)+' LUFS · '+rows.filter(r=>r.gain!==null).length+' '+I18n.t('pistas medibles')+(rows.some(r=>r.limited)?' · '+I18n.t('* Limitado por picos o rango de ganancia.'):''):'';
  const overlap=d.querySelector('#gainOverlap');overlap.replaceChildren();
  if(report){
    const p=document.createElement('p');
    if(report.regions===null)p.textContent='Solapes sin comprobar.';
    else if(!report.regions.length)p.textContent='Sin solapes audibles.';
    else{const peaks=report.regions.map(r=>r.peak).filter(Number.isFinite),peak=peaks.length?Math.max(...peaks):null,risks=report.regions.filter(r=>r.peak!==null&&r.peak>-1);p.textContent=I18n.t('Solapes con el ajuste propuesto')+': '+(peak===null?'—':peak.toFixed(1)+' dBTP')+' · '+(risks.length?risks.length+' '+I18n.t('zonas por encima de −1 dBTP'):I18n.t('Margen comprobado hasta −1 dBTP'));p.classList.toggle('gain-warning',!!risks.length);
      if(risks.length){const button=document.createElement('button');button.textContent='Ver primer solape';button.onclick=()=>{const r=risks[0];pauseSession();session.offset=r.start;view.zoom=view.total/Math.max(.05,r.end-r.start+2);view.start=Math.max(0,r.start-1);timeline();d.close();};overlap.append(button);}
    }overlap.prepend(p);
  }
  I18n.render(d);
}
async function analyzeGainDialog(){
  const state=gainDialogState,d=document.querySelector('#gainDialog');if(!state||state.running||busy)return false;
  const target=Number(d.querySelector('#gainTarget').value),mode=d.querySelector('#gainMode').value,chosen=gainSelection(d.querySelector('#gainScope').value);
  if(!Number.isFinite(target)||target< -30||target> -9){d.querySelector('#gainStatus').textContent='El objetivo debe estar entre −30 y −9 LUFS.';return false;}
  if(!chosen.length){d.querySelector('#gainStatus').textContent='Carga o selecciona al menos una pista.';return false;}
  const revision=documentRevision,job={canceled:false,measurementId:null};state.job=job;state.running=true;state.report=null;
  pauseSession();tracks.forEach(stop);busy=true;lock(true);d.querySelector('#closeGain').disabled=false;d.querySelector('#analyzeGain').disabled=false;d.querySelector('#analyzeGain').textContent='Cancelar análisis';renderGainReport();
  try{
    const entries=[];
    for(let i=0;i<chosen.length;i++){
      const track=chosen[i];d.querySelector('#gainStatus').textContent=I18n.t('Analizando pista')+' '+(i+1)+' / '+chosen.length;
      const measurement=await measureGainTrack(track,job);gainJobCheck(job);entries.push({track,buffer:track.buffer,range:gainRangeKey(track),previous:track.trimGain||0,measurement});
    }
    const proposed=gainProposal(entries,target,mode);let regions=null;
    if(d.querySelector('#gainCheckOverlaps').checked){d.querySelector('#gainStatus').textContent='Comprobando solapes…';regions=await measureGainOverlaps(proposed.rows,job,percent=>d.querySelector('#gainStatus').textContent=I18n.t('Comprobando solapes…')+' '+percent+'%');}
    gainJobCheck(job);state.report={...proposed,regions,revision,settings:{target,mode}};
    if(!gainReportCurrent(state)){state.report=null;throw Error('La sesión ha cambiado. Vuelve a analizar.');}
    d.querySelector('#gainStatus').textContent='Análisis terminado. Revisa y aplica el ajuste.';return true;
  }catch(error){state.report=null;d.querySelector('#gainStatus').textContent=job.canceled?'Análisis cancelado. No se ha cambiado ninguna ganancia.':error.message;return false;}
  finally{state.running=false;state.job=null;busy=false;lock(false);d.querySelector('#analyzeGain').textContent='Analizar';renderGainReport();}
}
function cancelGainAnalysis(){const state=gainDialogState;if(!state?.job)return;state.job.canceled=true;if(state.job.measurementId)window.simpleMix.cancelAudio?.(state.job.measurementId).catch(reportError);document.querySelector('#gainStatus').textContent='Cancelando…';}
function applyGainReport(){
  const state=gainDialogState;if(!state||busy||!gainReportCurrent(state)){if(state){state.report=null;renderGainReport();document.querySelector('#gainStatus').textContent='La sesión ha cambiado. Vuelve a analizar.';}return false;}
  checkpoint();for(const row of state.report.rows)if(row.gain!==null)row.track.trimGain=row.gain;
  gainMatchSettings={...state.report.settings};edited();syncLiveMix();checkpoint();timeline(true);document.querySelector('#gainDialog').close();status('Ganancias igualadas. Puedes ajustar cada pista o deshacer.');return true;
}
function openGainDialog(){
  if(busy)return;document.querySelector('#sessionDialog')?.close();
  let d=document.querySelector('#gainDialog');if(!d){d=document.createElement('dialog');d.id='gainDialog';document.body.append(d);}
  gainDialogState={page:0,report:null,running:false,job:null};
  d.innerHTML=`<div class="export-title"><div><span class="dialog-eyebrow">AUTO GAIN</span><h2>Igualar pistas</h2></div><button id="closeGain" class="icon-button" data-icon="close" aria-label="Cerrar"></button></div><p class="gain-description">Ganancia fija por tema. Conserva la dinámica, los fades y los archivos originales.</p><div class="gain-options"><label>Pistas<select id="gainScope"><option value="all">Toda la sesión</option><option value="selected">Selección</option></select></label><label>Modo<select id="gainMode"><option value="auto">Objetivo común</option><option value="reduce">Solo reducir</option></select></label><label>Objetivo · LUFS<input id="gainTarget" type="number" min="-30" max="-9" step=".5"></label></div><p class="gain-help">Medición del tramo original utilizado. Margen por pista: −3 dBTP; aumento máximo: 12 dB. Ganancia manual disponible en Editar pista.</p><label class="check-control"><input id="gainCheckOverlaps" type="checkbox" checked> Comprobar solapes con tempo, EQ, fades y máster actuales</label><table class="gain-table"><thead><tr><th>Pista</th><th>Original · LUFS</th><th>Ganancia · dB</th><th>Resultado · LUFS</th></tr></thead><tbody id="gainRows"></tbody></table><div class="gain-pagination"><span id="gainSummary"></span><button id="gainPrevious" class="icon-button" data-icon="left" aria-label="Página anterior"></button><span id="gainPage"></span><button id="gainNext" class="icon-button" data-icon="right" aria-label="Página siguiente"></button></div><div id="gainOverlap" aria-live="polite"></div><div class="gain-bottom"><p id="gainStatus" role="status"></p><button id="analyzeGain">Analizar</button><button id="applyGain" class="primary" disabled>Aplicar ganancias</button></div>`;
  d.querySelector('#gainTarget').value=gainMatchSettings.target;d.querySelector('#gainMode').value=gainMatchSettings.mode;d.querySelector('#gainScope').value=selection.size>1?'selected':'all';
  d.querySelector('#closeGain').onclick=()=>gainDialogState.running?cancelGainAnalysis():d.close();d.oncancel=e=>{if(gainDialogState.running){e.preventDefault();cancelGainAnalysis();}};
  d.querySelector('#analyzeGain').onclick=()=>gainDialogState.running?cancelGainAnalysis():analyzeGainDialog();d.querySelector('#applyGain').onclick=applyGainReport;
  for(const id of ['gainTarget','gainMode','gainScope','gainCheckOverlaps'])d.querySelector('#'+id).onchange=()=>{gainDialogState.report=null;d.querySelector('#gainStatus').textContent='';renderGainReport();};
  d.querySelector('#gainPrevious').onclick=()=>{gainDialogState.page--;renderGainReport();};d.querySelector('#gainNext').onclick=()=>{gainDialogState.page++;renderGainReport();};
  if(!window.simpleMix?.processAudio){d.querySelector('#analyzeGain').disabled=true;d.querySelector('#gainStatus').textContent='Abre la aplicación de escritorio para analizar la sonoridad.';}
  decorateIcons(d);renderGainReport();d.showModal();
}
