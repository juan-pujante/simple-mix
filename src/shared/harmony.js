// Circle-of-fifths / Camelot mapping and local recommendations.
// Compatibility reference: https://mixedinkey.com/camelot-wheel/
'use strict';
const CAMELOT_MAJOR=[11,6,1,8,3,10,5,0,7,2,9,4],CAMELOT_MINOR=[8,3,10,5,0,7,2,9,4,11,6,1];
const NOTE_NAMES=['C','D♭','D','E♭','E','F','F♯','G','A♭','A','B♭','B'];
function camelot(key){if(!key||!Number.isInteger(key.root)||!['major','minor'].includes(key.mode))return '';return ((key.mode==='minor'?CAMELOT_MINOR:CAMELOT_MAJOR).indexOf(key.root)+1)+(key.mode==='minor'?'A':'B');}
function keyFromCamelot(value){const match=/^(1[0-2]|[1-9])([AB])$/.exec(value);return match?{root:(match[2]==='A'?CAMELOT_MINOR:CAMELOT_MAJOR)[Number(match[1])-1],mode:match[2]==='A'?'minor':'major',confidence:1,source:'manual'}:null;}
function effectiveKey(track){if(!track.key)return null;const semitones=(track.pitch||0)+(keepPitch?0:12*Math.log2(rate(track))),rounded=Math.round(semitones);return {...track.key,root:((track.key.root+rounded)%12+12)%12,cents:Math.round((semitones-rounded)*100)};}
function harmonicLabel(track){const key=effectiveKey(track);return key?camelot(key)+(Math.abs(key.cents)>15?' ≈':''):track.keyAnalyzing?'…':'—';}
function keyName(key){return key?NOTE_NAMES[key.root]+' '+I18n.t(key.mode==='minor'?'menor':'mayor'):I18n.t('Sin tonalidad fiable');}
function compatibleKeys(code){const key=keyFromCamelot(code);if(!key)return [];const n=Number(code.slice(0,-1)),mode=code.slice(-1);return [code,((n+10)%12+1)+mode,(n%12+1)+mode,n+(mode==='A'?'B':'A')];}
function harmonicRecommendations(track){const key=effectiveKey(track),code=camelot(key),compatible=compatibleKeys(code);if(!code)return [];
 return tracks.filter(t=>t!==track&&t.buffer&&effectiveKey(t)).map(t=>{const candidate=effectiveKey(t),other=camelot(candidate),delta=Math.abs(targetTempo(t)-targetTempo(track)),match=compatible.includes(other),tuning=Math.abs(candidate.cents-key.cents);return {track:t,key:candidate,code:other,match:match&&tuning<=25,delta,tuning,score:(other===code?100:match?85:20)-Math.min(30,delta)-tuning*.5};}).sort((a,b)=>b.score-a.score);
}
async function detectKey(track){
 if(!track.buffer)return;const token=(track.keyToken||0)+1;track.keyToken=token;track.keyAnalyzing=true;const buffer=track.buffer;
 let worker;
 try{
  // Six excerpts cover intros, breakdowns and the main body without analyzing a whole song.
  const sampleRate=11025,excerpt=Math.min(12,buffer.duration),starts=buffer.duration>72?[.1,.25,.4,.55,.7,.85].map(f=>Math.min(buffer.duration-excerpt,buffer.duration*f)):[0];
  const seconds=starts.length===1?buffer.duration:excerpt,sourceLength=Math.floor(seconds*buffer.sampleRate),segmentLength=Math.max(1,Math.floor(seconds*sampleRate));
  // Analyze both stereo channels independently: summing their spectra keeps
  // stereo musical detail without phase cancellation or favoring the louder side.
  const channels=Math.min(2,buffer.numberOfChannels),length=segmentLength*starts.length;
  // Web Audio filters above Nyquist before downsampling. Linear decimation
  // aliases cymbals into the pitch bands and obscures the key.
  const context=new OfflineAudioContext(channels,length,sampleRate),input=context.createBuffer(channels,Math.max(1,sourceLength*starts.length),buffer.sampleRate);
  for(let channel=0;channel<channels;channel++){
   const data=buffer.getChannelData(channel);
   starts.forEach((start,index)=>{const from=Math.floor(start*buffer.sampleRate);input.copyToChannel(data.subarray(from,from+sourceLength),channel,index*sourceLength);});
  }
  const source=context.createBufferSource();source.buffer=input;source.connect(context.destination);source.start();
  const rendered=await context.startRendering(),samples=new Float32Array(length*channels);
  for(let channel=0;channel<channels;channel++)samples.set(rendered.getChannelData(channel),channel*length);
  if(!tracks.includes(track)||track.keyToken!==token||track.buffer!==buffer)return;
  const result=await new Promise((resolve,reject)=>{worker=new Worker('../workers/key-worker.js');const timer=setTimeout(()=>{worker.terminate();reject(Error('Tiempo de análisis agotado'));},30000);worker.onmessage=e=>{clearTimeout(timer);e.data.error?reject(Error(e.data.error)):resolve(e.data.result);};worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};worker.postMessage({samples,sampleRate,segmentLength},[samples.buffer]);});
  if(!tracks.includes(track)||track.keyToken!==token||track.buffer!==buffer)return;track.key=result?{root:result.root,mode:result.mode,confidence:result.confidence,source:'auto'}:null;markDirty();
 }catch(error){if(track.keyToken===token)status(I18n.t('No se pudo analizar la tonalidad')+': '+error.message);}
 finally{worker?.terminate();if(track.keyToken===token){track.keyAnalyzing=false;update(track);timeline();}}
}
function wheelSvg(selected){
 const compatible=compatibleKeys(selected),point=(r,a)=>[160+r*Math.cos(a),160+r*Math.sin(a)];let body='';
 for(let n=1;n<=12;n++)for(const mode of ['A','B']){
  const code=n+mode,a=(n-1)*Math.PI/6-Math.PI/2,b=a+Math.PI/6,inner=mode==='A'?52:100,outer=mode==='A'?98:146,p1=point(inner,a+.015),p2=point(outer,a+.015),p3=point(outer,b-.015),p4=point(inner,b-.015),label=point((inner+outer)/2,(a+b)/2),active=code===selected,match=compatible.includes(code);
  const fill=active?'#ad7258':match?'#486963':'#303943',stroke=active?'#f1bc9e':match?'#81a89c':'#485564';
  body+=`<path d="M${p1}L${p2}A${outer},${outer} 0 0 1 ${p3}L${p4}A${inner},${inner} 0 0 0 ${p1}Z" fill="${fill}" stroke="${stroke}"/><text x="${label[0]}" y="${label[1]}" text-anchor="middle" dominant-baseline="middle" fill="${match?'#fff':'#aebcca'}" font-size="11">${code}</text>`;
 }
 return `<svg viewBox="0 0 320 320" role="img" aria-label="${I18n.t('Rueda de Camelot')}">${body}<text x="160" y="156" text-anchor="middle" fill="#eef1f5" font-size="20">${selected||'—'}</text><text x="160" y="177" text-anchor="middle" fill="#aebbc9" font-size="9">CAMELOT</text></svg>`;
}
function openHarmony(track=tracks.find(t=>t.id===selectedId)){
 if(!track||busy)return;const dialog=document.querySelector('#harmonyDialog');const redraw=()=>{
  const key=effectiveKey(track),code=camelot(key);dialog.innerHTML=`<div class="export-title"><h2>Mezcla armónica</h2><button class="close-dialog icon-button" data-icon="close" aria-label="Cerrar"></button></div><p class="harmony-track" translate="no"></p><div class="harmony-layout"><div class="camelot-wheel">${wheelSvg(code)}</div><div class="harmony-controls"><label>Tonalidad original<select id="sourceKey"><option value="">Sin tonalidad fiable</option>${Array.from({length:12},(_,i)=>['A','B'].map(mode=>{const value=(i+1)+mode;return `<option value="${value}">${value} · ${keyName(keyFromCamelot(value))}</option>`;}).join('')).join('')}</select></label><p id="keyConfidence"></p><button id="analyzeKey">Analizar tonalidad</button><p id="keyEffective"></p><p class="harmony-help">Misma casilla, número adyacente o A/B del mismo número. La recomendación orienta; escucha siempre la transición.</p></div></div><h3>Siguientes temas compatibles</h3><div id="harmonicMatches"></div>`;
  dialog.querySelector('.harmony-track').textContent=track.name;dialog.querySelector('.close-dialog').onclick=()=>dialog.close();document.querySelector('#sourceKey').value=camelot(track.key);
  document.querySelector('#keyConfidence').textContent=track.key?track.key.source==='manual'?I18n.t('Tonalidad manual'):I18n.t('Tonalidad estimada')+' · '+I18n.t(track.key.confidence>=.65?'Confianza alta':track.key.confidence>=.4?'Confianza media':'Confianza baja'):I18n.t('Sin tonalidad fiable');
  document.querySelector('#keyEffective').textContent=I18n.t('En reproducción')+': '+keyName(key)+(code?' · '+code:'')+(key?.cents?' · '+(key.cents>0?'+':'')+key.cents+' cents':'');
  document.querySelector('#sourceKey').onchange=event=>{checkpoint();track.keyToken=(track.keyToken||0)+1;track.key=keyFromCamelot(event.target.value);track.keyAnalyzing=false;markDirty();timeline();redraw();};
  document.querySelector('#analyzeKey').onclick=async()=>{document.querySelector('#analyzeKey').disabled=true;await detectKey(track);redraw();};
  const suggestions=harmonicRecommendations(track).filter(x=>x.match).slice(0,8),list=document.querySelector('#harmonicMatches');
  if(!suggestions.length){const p=document.createElement('p');p.textContent=I18n.t('No hay coincidencias fiables entre las pistas cargadas.');list.append(p);}
  for(const suggestion of suggestions){const row=document.createElement('div');row.className='harmonic-match';const name=document.createElement('strong');name.textContent=suggestion.track.name;name.setAttribute('translate','no');const info=document.createElement('span');info.textContent=`${suggestion.code} · ${targetTempo(suggestion.track)} BPM · Δ ${suggestion.delta.toFixed(1)}`;const listen=document.createElement('button');listen.textContent=I18n.t('Escuchar');listen.onclick=()=>play(suggestion.track).catch(reportError);const select=document.createElement('button');select.textContent=I18n.t('Seleccionar');select.onclick=()=>{selectTrack(suggestion.track);timelinePage=Math.floor(tracks.indexOf(suggestion.track)/PAGE_SIZE);timeline();dialog.close();};row.append(name,info,listen,select);list.append(row);}
  decorateIcons(dialog);I18n.render(dialog);
 };redraw();if(!dialog.open)dialog.showModal();
}
