 'use strict';
const $ = selector => document.querySelector(selector);
const APP_VERSION = window.simpleMixVersion;
$('#appVersion').textContent = 'v' + APP_VERSION;
const tracks = [];
let ctx, nextId = 0, busy = false, selectedId = null, timelinePage = 0;
let activeProject = null, projectDirty = false, lastMasterReport = null, documentRevision = 0;
const PAGE_SIZE = 5;
let appliedGlobalBpm = Number($('#globalBpm').value);
const PROJECT_SAMPLE_RATE = 44100; // Placement grid follows the exported session sample rate.
const session = { pending: false, request: 0, playing: false, offset: 0, started: 0, end: 0, nodes: [], timer: null };
const status = message => { $('#status').textContent = message; };
const clamp = (value, min, max, fallback = min) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback));
const format = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const audio = () => ctx || (ctx = new AudioContext());
const targetTempo = track => $('#globalSync').checked && track.followGlobal ? Number($('#globalBpm').value) : track.targetBpm;
const sourceTempo = track => track.bpmMode!=='manual'&&Number.isFinite(track.sourceBpm)&&Math.round(track.sourceBpm)===track.bpm?track.sourceBpm:track.bpm;
const rate = track => targetTempo(track) / sourceTempo(track);
const view = { zoom: 1, start: 0, total: 60 };
const precisionTime = value => { const microseconds = Math.round(Math.max(0, value) * 1000000); return `${format(Math.floor(microseconds / 1000000))}.${(microseconds % 1000000).toString().padStart(6, '0')}`; };
function rulerTime(value, span) {
  const digits = span >= 60 ? 0 : span >= 1 ? 2 : span >= .02 ? 3 : 6;
  const units = 10 ** digits, ticks = Math.round(Math.max(0, value) * units);
  return format(Math.floor(ticks / units)) + (digits ? '.' + (ticks % units).toString().padStart(digits, '0') : '');
}
const duration = track => track.buffer ? (sourceEnd(track) - sourceStart(track)) / rate(track) : 0;
const fadeSeconds = track => track.bars * 4 * 60 / Number($('#globalBpm').value);
const trackEl = track => document.getElementById(`track${track.id}`);
function position(track) {
  return track.playing ? Math.min(track.buffer.duration, track.offset + (ctx.currentTime - track.started) * track.playRate) : track.offset;
}
function sessionPosition() {
  return session.playing ? Math.min(session.end, session.offset + ctx.currentTime - session.started) : session.offset;
}
function stopNodes() {
  clearTimeout(session.timer);
  session.nodes.forEach(node => { try { node.source.stop(); } catch {} node.source.disconnect(); node.filters.forEach(f => f.disconnect()); node.gain.disconnect(); node.level?.disconnect(); node.meter?.disconnect(); node.tone?.disconnect(); });
  session.nodes = [];
}
function pauseSession() {
  session.pending = false; session.request++;
  if (session.playing) session.offset = sessionPosition();
  session.playing = false;
  stopNodes();
  playbackButton($('#playSession'), false);
}
function stopSession() { pauseSession(); tracks.forEach(stop); session.offset = 0; updateClock(); }
function edited(live = false) {
  markDirty();
  if (!live && (session.playing || session.pending)) { pauseSession(); status('Escucha pausada para aplicar los cambios. Pulsa Escuchar sesión para continuar.'); }
  timeline();
}
function pause(track) {
  track.playRequest=(track.playRequest||0)+1;track.pending=false;
  if (!track.playing) return;
  track.offset = position(track);
  track.playing = false;
  track.token++;
  track.node.source.stop();
  track.node.source.disconnect();
  track.node.filters.forEach(f => f.disconnect());
  track.node.gain.disconnect(); track.node.level?.disconnect(); track.node.meter?.disconnect(); track.node.tone?.disconnect();
  track.node = null;
  update(track);
}
function stop(track) { pause(track); track.offset = 0; update(track); }
function graph(context, track, target) {
  const source = context.createBufferSource();
  source.buffer = preparedBuffer(track);
  source.playbackRate.value = sourcePlaybackRate(track);
  let last = source;
  const filters = track.eq.map((gain, i) => {
    const filter = context.createBiquadFilter();
    filter.type = ['lowshelf', 'peaking', 'highshelf'][i];
    filter.frequency.value = [180, 1000, 6000][i];
    filter.Q.value = .7;
    filter.gain.value = gain;
    last.connect(filter);
    last = filter;
    return filter;
  });
  const gain = context.createGain();
  const tone = context.createBiquadFilter(); tone.type='lowpass';tone.frequency.value=track.filterHz||20000; tone.Q.value=.707;
  const level = context.createGain();level.gain.value=levelFactor(track);
  const meter = context.createAnalyser();meter.fftSize=1024;
  last.connect(tone);tone.connect(gain);gain.connect(level);level.connect(meter);meter.connect(target);
  return { source, filters, gain, level, meter, tone, track };
}
async function play(track) {
  if (!track.buffer) return status('Carga un archivo de audio en esta pista.');
  pauseSession();
  const request=track.playRequest=(track.playRequest||0)+1;track.pending=true;
  try { await audio().resume();await prepareTrack(track); }
  catch(error){if(request===track.playRequest){track.pending=false;reportError(error);}return;}
  if (!tracks.includes(track) || request!==track.playRequest || track.playing) return;
  track.pending=false;
  if (track.offset >= sourceEnd(track) || track.offset < sourceStart(track)) track.offset = sourceStart(track);
  const node = graph(ctx, track, outputTarget(ctx));
  node.gain.gain.value = automationValue(track, track.offset);
  track.node = node;
  track.playRate = rate(track);
  track.started = ctx.currentTime;
  track.playing = true;
  scheduleIndividualGain(track, node);
  const token = ++track.token;
  node.source.onended = () => { if (track.token === token) { track.playing = false; track.offset = 0; node.source.disconnect(); node.filters.forEach(f => f.disconnect()); node.gain.disconnect(); node.level?.disconnect(); node.meter?.disconnect(); node.tone?.disconnect(); track.node = null; update(track); } };
  node.source.start(0, preparedOffset(track, track.offset));
  node.source.stop(ctx.currentTime+(sourceEnd(track)-track.offset)/rate(track));
  update(track);
}
// Overlapping clips keep their complete audio. Only user points change volume.
function plan(includeMuted = false) {
  return tracks.filter(track => track.buffer && (includeMuted || audible(track)))
    .map(track => ({ track, start: track.start, end: track.start + duration(track) }))
    .sort((a, b) => a.start - b.start || a.track.id - b.track.id);
}
function automationValue(track, sourceTime) {
  const points = track.automation;
  if (!points.length) return 1;
  if (sourceTime <= points[0].time) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    if (sourceTime <= points[i].time) {
      const a = points[i - 1], b = points[i];
      return curveValue(a.value,b.value,(sourceTime-a.time)/(b.time-a.time),a.curve||track.fadeCurve||'linear');
    }
  }
  return points.at(-1).value;
}
function envelope(item, time) {
  return automationValue(item.track, sourceStart(item.track)+(time-item.start)*rate(item.track))*levelFactor(item.track);
}
function schedule(context, items, offset, when, until = Infinity) {
  return items.filter(item => item.end > offset && item.start < until).map(item => {
    const node = graph(context, item.track, outputTarget(context));
    const from = Math.max(offset, item.start), finish=Math.min(until,item.end), start = when + from - offset, end = when + finish - offset;
    const sourceFrom=sourceStart(item.track)+(from-item.start)*rate(item.track),sourceTo=sourceStart(item.track)+(finish-item.start)*rate(item.track);
    scheduleEnvelope(node.gain.gain,item.track,sourceFrom,sourceTo,start,rate(item.track));
    scheduleTone(node,item.track,sourceFrom,sourceTo,start,rate(item.track));
    node.source.start(start, preparedOffset(item.track,sourceFrom));
    node.source.stop(end);
    node.sessionFrom=from;node.scheduledStart=start;
    return node;
  });
}
async function playSession() {
  if (session.playing || session.pending) { pauseSession(); updateClock(); return; }
  if (!plan().length) return status('Carga al menos un tema sin silenciar para escuchar la sesión.');
  const request = ++session.request; session.pending = true;
  tracks.forEach(stop);
  try { await audio().resume();await prepareTracks(tracks.filter(t=>t.buffer)); }
  catch(error){if(request===session.request){session.pending=false;reportError(error);}return;}
  if (request !== session.request) return;
  session.pending = false;
  const items = plan(true);
  if (!items.length) return;
  session.end = loopEnabled() ? Math.min(loopRegion.end,Math.max(...items.map(item=>item.end))) : Math.max(...items.map(item => item.end));
  if(loopEnabled()&&loopRegion.start>=session.end){status('La región A–B está fuera del audio.');return;}
  if (session.offset >= session.end) session.offset = loopEnabled()?loopRegion.start:0;
  if(loopEnabled()&&session.offset<loopRegion.start)session.offset=loopRegion.start;
  session.started = ctx.currentTime + .04;
  session.nodes = schedule(ctx, items, session.offset, session.started,session.end);
  session.playing = true;
  session.timer = setTimeout(()=>{if(loopEnabled()){pauseSession();session.offset=loopRegion.start;playSession().catch(reportError);}else stopSession();}, (session.end - session.offset + .06) * 1000);
  playbackButton($('#playSession'), true);
  status('Reproduciendo la sesión con sus posiciones, EQ y envolventes de volumen.');
}
function peaks(buffer) {
  const count = 2200, result = new Float32Array(count);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < count; i++) {
      const end = Math.min(data.length, Math.ceil((i + 1) * data.length / count));
      for (let j = Math.floor(i * data.length / count); j < end; j++) result[i] = Math.max(result[i], Math.abs(data[j]));
    }
  }
  return result;
}
function sourceView(track) {
  const length = track.buffer?.duration || 60;
  const span = Math.min(length, timelineDuration * rate(track));
  const from = clamp(sourceStart(track)+(view.start - track.start) * rate(track), 0, Math.max(0, length - span));
  return { from, to: from + span, span };
}
function paintWave(g, track, width, height, from, to) {
  if (!track.buffer || to <= from) return;
  const buffer = track.buffer, sampleRate = buffer.sampleRate;
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  g.fillStyle = track.color;
  if ((to - from) * sampleRate < width / 2) {
    g.strokeStyle = track.color; g.lineWidth = 1;
    for (const data of channels) {
      const first = Math.max(0, Math.floor(from * sampleRate)), last = Math.min(buffer.length - 1, Math.ceil(to * sampleRate));
      g.beginPath();
      for (let i = first; i <= last; i++) {
        const x = (i / sampleRate - from) / (to - from) * width, y = height / 2 - data[i] * height * .45;
        if (i === first) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      if (last - first < width / 5) for (let i = first; i <= last; i++) {
        const x = (i / sampleRate - from) / (to - from) * width, y = height / 2 - data[i] * height * .45;
        g.beginPath(); g.arc(x, y, 1.8, 0, Math.PI * 2); g.fill();
      }
    }
    return;
  }
  for (let x = 0; x < width; x += 2) {
    const a = clamp(Math.floor((from + x / width * (to - from)) * sampleRate), 0, buffer.length - 1);
    const b = clamp(Math.ceil((from + (x + 2) / width * (to - from)) * sampleRate), a + 1, buffer.length);
    let peak = 0;
    if (b - a > buffer.length / track.peaks.length * 2) {
      for (let i = Math.floor(a / buffer.length * track.peaks.length); i <= Math.min(track.peaks.length - 1, Math.ceil(b / buffer.length * track.peaks.length)); i++) peak = Math.max(peak, track.peaks[i]);
    } else {
      const step = Math.max(1, Math.floor((b - a) / 128));
      for (const data of channels) for (let i = a; i < b; i += step) peak = Math.max(peak, Math.abs(data[i]));
    }
    const h = Math.max(1, peak * height * .9); g.fillRect(x, (height - h) / 2, 1, h);
  }
}
function draw(track) {
  const canvas = trackEl(track)?.querySelector('canvas');
  if (!canvas || !trackEl(track).classList.contains('is-selected')) return;
  const rect = canvas.getBoundingClientRect(), scale = devicePixelRatio || 1;
  const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const g = canvas.getContext('2d'); g.clearRect(0, 0, width, height);
  g.fillStyle = '#29313c'; g.fillRect(0, height / 2, width, 1);
  if (!track.buffer) return;
  const window = sourceView(track);
  paintWave(g, track, width, height, window.from, window.to);
  let pos = position(track);
  if (session.playing) pos = Math.max(0, Math.min(track.buffer.duration, sourceStart(track)+(sessionPosition() - track.start) * rate(track)));
  const x = (pos - window.from) / window.span * width;
  if (x >= 0 && x <= width) { g.fillStyle = '#ffffff0b'; g.fillRect(0, 0, x, height); g.fillStyle = '#fff'; g.fillRect(x, 0, 1.5 * scale, height); }
  g.font = `${9 * scale}px monospace`; g.fillStyle = '#c1d0e7';
  g.fillText(`${rulerTime(window.from, window.span)} — ${rulerTime(window.to, window.span)}`, 6 * scale, 12 * scale);
}
function update(track) {
  const el = trackEl(track);
  if (!el) return;
  playbackButton(el.querySelector('.play'), track.playing, true);
  refreshRanges(el);
  el.querySelector('.track-name').textContent = track.name || 'Carga un tema';
  el.querySelector('.track-meta').textContent = track.buffer ? `${format(track.buffer.duration)} · ${track.buffer.sampleRate / 1000} kHz · ${track.bpmMode === 'auto' ? 'BPM estimados' : track.bpmMode === 'detecting' ? 'Analizando BPM…' : 'BPM manual'}` : 'MP3, WAV y otros formatos compatibles';
  el.querySelector('.empty-wave').hidden = !!track.buffer;
  el.querySelector('.time').textContent = `${format(position(track))} / ${format(track.buffer?.duration || 0)}`;
  el.querySelector('.mute').textContent = track.muted ? 'Activar pista' : 'Silenciar';
  el.querySelector('.mute').setAttribute('aria-pressed', String(track.muted));
  el.classList.toggle('muted-track', track.muted);
  if (document.activeElement !== el.querySelector('.bpm')) el.querySelector('.bpm').value = targetTempo(track);
  if (document.activeElement !== el.querySelector('.source-bpm')) el.querySelector('.source-bpm').value = track.bpm;
  el.querySelector('.source-bpm').title=I18n.t(`Tempo original medido: ${sourceTempo(track).toFixed(3)} BPM. La velocidad se ajusta al BPM objetivo.`);
  el.querySelector('.follow-global').checked = track.followGlobal;
  draw(track); drawAutomation(track);
}
async function decodeFile(file, cachedPeaks = null) {
  const bytes=await file.arrayBuffer();
  const owned=new File([bytes],file.name,{type:file.type,lastModified:file.lastModified});
  const buffer = await audio().decodeAudioData(bytes);
  const valid=Array.isArray(cachedPeaks)&&cachedPeaks.length===2200&&cachedPeaks.every(v=>Number.isFinite(v)&&v>=0&&v<=1e6);
  return { buffer, file:owned, name: file.name, peaks: valid?Float32Array.from(cachedPeaks):peaks(buffer) };
}
async function load(track, file) {
  const token = ++track.loadToken;
  try {
    status(`Decodificando ${file.name}…`);
    const data = await decodeFile(file);
    if (!tracks.includes(track) || token !== track.loadToken) return false;
    edited(); stop(track); track.trimIn=0;track.trimOut=null;track.eqAutomation=[[],[],[]];track.filterAutomation=[];track.firstBeat=0; track.automation = []; track.bpmMode = 'manual'; track.sourceBpm=null; Object.assign(track, data); update(track); timeline();
    await detectBpm(track);
    if(!tracks.includes(track)||token!==track.loadToken)return false;
    await detectKey(track);
    if(!tracks.includes(track)||token!==track.loadToken)return false;
    status(`${file.name} cargado. Ajusta los BPM de reproducción y su inicio en la sesión.`);
    return true;
  } catch (error) { status(`No se pudo abrir el audio: ${error.message}`); return false; }
}
function chain(track) {
  if(track.locked)return status('Posición bloqueada.');
  const previous = tracks.slice(0, tracks.indexOf(track)).filter(t => t.buffer).at(-1);
  track.start = previous ? Math.max(previous.start, previous.start + duration(previous) - Math.min(fadeSeconds(track), duration(previous), duration(track) || Infinity)) : 0;
  track.start = Math.round(track.start * 1000) / 1000;
  trackEl(track).querySelector('.track-start').value = track.start;
  edited();
}
function removeTrack(track) {
  edited(); stop(track); track.loadToken++; track.detectToken++;
  tracks.splice(tracks.indexOf(track), 1); trackEl(track).remove();
  if (selectedId === track.id) selectedId = tracks.at(-1)?.id ?? null;
  renumber(); timeline(); status('Pista eliminada.');
}
function toggleTrackMute(track) {
  if (busy || !tracks.includes(track)) return;
  edited(true);
  track.muted = !track.muted;
  syncLiveMix();
  if (track.node) scheduleIndividualGain(track, track.node);
  update(track); timeline();
  status(`Pista ${tracks.indexOf(track) + 1} ${track.muted ? 'silenciada' : 'activada'}.`);
}
function selectTrack(track) {
  selectedId = track.id;
  updateFinePosition();
  tracks.forEach(item => trackEl(item).classList.toggle('is-selected', item.id === selectedId));
  draw(track); drawAutomation(track);
  document.querySelectorAll('.track-rail').forEach((head, i) => { const selected = tracks[timelinePage * PAGE_SIZE + i]?.id === selectedId; head.classList.toggle('is-selected', selected); head.setAttribute('aria-pressed', String(selected)); });
  document.querySelectorAll('.clip').forEach((clip, i) => clip.classList.toggle('selected-clip', tracks[timelinePage * PAGE_SIZE + i]?.id === selectedId));
}
function renumber() {
  tracks.forEach((track, i) => { trackEl(track).querySelector('.deck-letter').textContent = String(i + 1).padStart(2, '0'); trackEl(track).classList.toggle('is-selected', track.id === selectedId); });
  $('#trackCount').textContent = String(tracks.length);
  $('#trackCount').setAttribute('aria-label', `${tracks.length} pistas`);
  const selected = tracks.find(track => track.id === selectedId); if (selected) { draw(selected); drawAutomation(selected); }
}
function addTrack(data = {}) {
  const id = nextId++;
  const track = Object.assign({ id, name: '', file: null, buffer: null, peaks: null, bpm: 140, targetBpm: 140, targetEdited: false, followGlobal: true, volume: .85, eq: [0, 0, 0], start: 0, bars: 0, muted: false, automation: [], bpmMode: 'manual', bpmConfidence: null, detectToken: 0, offset: 0, playing: false, token: 0, loadToken: 0, node: null, color: ['#d89b75', '#8faaaa', '#aaa0bd', '#b4b48a'][tracks.length % 4] }, data, { id });
  tracks.push(track); selectedId = track.id; timelinePage = Math.floor((tracks.length - 1) / PAGE_SIZE);
  const el = document.createElement('article');
  el.id = `track${id}`; el.className = 'deck'; el.style.setProperty('--track-color', track.color);
  el.innerHTML = `<div class="deck-top"><span class="deck-letter"></span><div class="track-info"><div class="track-name"></div><div class="track-meta"></div></div><button class="load" data-icon="folder">Cargar audio</button><button class="remove icon-button" data-icon="close" aria-label="Eliminar pista" title="Eliminar pista"></button><input class="file" type="file" accept="audio/*,.mp3,.wav,.flac,.ogg" hidden></div><div class="wave-wrap"><canvas tabindex="0" aria-label="Forma de onda: clic para buscar, flechas para avanzar o retroceder"></canvas><span class="empty-wave">Arrastra un archivo de audio aquí</span></div><div class="automation-head"><span>Envolvente de volumen</span><div><button class="point-start" title="Crear punto en el inicio del audio">Inicio</button><button class="point-end" title="Crear punto en el final del audio">Fin</button><button class="toggle-points">Puntos</button><button class="clear-fades">Restablecer</button></div></div><canvas class="automation" tabindex="0" aria-label="Editor de fades. Doble clic para añadir puntos de volumen"></canvas><div class="fade-tools"><label>Desde · s<input class="fade-start" type="number" min="0" step=".1" value="0"></label><label>Duración · s<input class="fade-duration" type="number" min=".1" step=".1" value="8"></label><label>Tipo<select class="fade-kind"><option value="in">Entrada 0 → 100%</option><option value="out">Salida 100 → 0%</option></select></label><button class="add-fade" data-icon="plus">Fade</button></div><div class="automation-points"></div><div class="transport"><button class="play" data-icon="play">Escuchar</button><button class="stop icon-button" data-icon="stop" aria-label="Volver al inicio" title="Volver al inicio"></button><button class="mute" aria-pressed="false">Silenciar</button><span class="time"></span></div><div class="deck-controls"><div><label class="control-label" for="bpm${id}">Tempo de pista</label><div class="bpm-row"><input id="bpm${id}" class="bpm" type="number" min="40" max="240" step=".1"><span>BPM</span><label class="follow-label"><input class="follow-global" type="checkbox"> Global</label></div><div class="source-tempo"><label>Original <input class="source-bpm" type="number" min="40" max="240" step=".1" aria-label="BPM originales del archivo, calibración"></label><button class="tap" title="Medir el tempo original con TAP">TAP</button><button class="detect" title="Detectar el tempo original del archivo">AUTO</button></div></div><div><label class="control-label" for="vol${id}">Nivel <output class="vol-value"></output></label><input id="vol${id}" class="volume" type="range" min="0" max="1" step=".01"></div></div><div class="placement"><label>Posición · segundos<input class="track-start" type="number" min="0" max="10800" step="any"></label><label>Solape · compases<input class="track-bars" type="number" min="0" max="128" step="1"></label><div class="placement-actions"><button class="chain" data-icon="link">Encadenar</button><button class="nudge-left" aria-label="Adelantar la pista con ajuste fino" title="Mover antes (←)" data-icon="left"></button><button class="nudge-right" aria-label="Retrasar la pista con ajuste fino" title="Mover después (→)" data-icon="right"></button></div></div><div class="eq">${['Graves', 'Medios', 'Agudos'].map((name, i) => `<label>${name}<output>0 dB</output><input aria-label="${name}" data-eq="${i}" type="range" min="-24" max="12" step="1"></label>`).join('')}</div>`;
  $('#decks').append(el);
  decorateIcons(el);
  el.querySelector('.automation-head').title = 'Doble clic: añadir un punto. Arrastrar: ajustar. Clic derecho: eliminar.';
  el.querySelector('.track-start').setAttribute('aria-label', 'Inicio de la pista en la sesión, en segundos');
  el.querySelector('.track-bars').setAttribute('aria-label', 'Solapamiento al encadenar, en compases');
  const gainControl = el.querySelector('.deck-controls > div:last-child'); gainControl.classList.add('track-gain'); el.querySelector('.transport').append(gainControl);
  if (document.activeElement !== el.querySelector('.bpm')) el.querySelector('.bpm').value = targetTempo(track);
  if (document.activeElement !== el.querySelector('.source-bpm')) el.querySelector('.source-bpm').value = track.bpm;
  el.querySelector('.source-bpm').title=I18n.t(`Tempo original medido: ${sourceTempo(track).toFixed(3)} BPM. La velocidad se ajusta al BPM objetivo.`);
  el.querySelector('.follow-global').checked = track.followGlobal;
  el.querySelector('.volume').value = track.volume;
  el.querySelector('.vol-value').value = `${Math.round(track.volume * 100)}%`;
  el.querySelector('.track-start').value = track.start;
  el.querySelector('.track-bars').value = track.bars;
  el.querySelector('.load').onclick = () => el.querySelector('.file').click();
  el.querySelector('.file').onchange = event => { if (!busy && event.target.files[0]) load(track, event.target.files[0]); event.target.value = ''; };
  el.ondragover = event => event.preventDefault();
  el.ondrop = event => { event.preventDefault(); if (!busy && event.dataTransfer.files[0]) load(track, event.dataTransfer.files[0]); };
  el.querySelector('.remove').onclick = () => removeTrack(track);
  el.querySelector('.play').onclick = () => track.playing || track.pending ? pause(track) : play(track);
  el.querySelector('.stop').onclick = () => stop(track);
  el.querySelector('.mute').onclick = () => toggleTrackMute(track);
  const seek = offset => { if (!track.buffer) return; const resume = track.playing; pause(track); track.offset = clamp(offset, 0, track.buffer.duration); if (resume) play(track); update(track); };
  el.querySelector('canvas').onclick = event => seek(sourceView(track).from + (event.clientX - event.target.getBoundingClientRect().left) / event.target.getBoundingClientRect().width * sourceView(track).span);
  el.querySelector('.detect').onclick = () => detectBpm(track);
  el.querySelector('.bpm').onchange = event => {
    const resume = track.playing; pause(track);
    track.targetBpm = clamp(event.target.value, 40, 240, 140); event.target.value = track.targetBpm;
    track.targetEdited = true; track.followGlobal = false;
    edited(); update(track); if (resume) play(track);
  };
  el.querySelector('.source-bpm').onchange = event => {
    const resume = track.playing; pause(track); track.detectToken++; track.bpmMode = 'manual'; track.sourceBpm=null;
    track.bpm = clamp(event.target.value, 40, 240, 140); event.target.value = track.bpm;
    edited(); update(track); if (resume) play(track);
  };
  el.querySelector('.follow-global').onchange = event => {
    const resume = track.playing; pause(track); track.followGlobal = event.target.checked;
    edited(); update(track); if (resume) play(track);
  };

  el.querySelector('.volume').oninput = event => { edited(true); track.volume = Number(event.target.value); syncLiveMix(); el.querySelector('.vol-value').value = `${Math.round(track.volume * 100)}%`; if (track.node) scheduleIndividualGain(track, track.node); };
  el.querySelectorAll('[data-eq]').forEach((input, i) => {
    input.value = track.eq[i]; input.previousElementSibling.value = `${track.eq[i]} dB`;
    input.oninput = () => { edited(true); track.eq[i] = Number(input.value); syncLiveMix(); input.previousElementSibling.value = `${input.value} dB`; if (track.node) track.node.filters[i].gain.setTargetAtTime(track.eq[i], ctx.currentTime, .015); };
  });
  el.querySelector('.track-start').onchange = event => { if(track.locked){event.target.value=track.start;return;} track.start = clamp(event.target.value, 0, 10800); event.target.value = track.start; edited(); };
  el.querySelector('.track-bars').onchange = event => { track.bars = Math.round(clamp(event.target.value, 0, 128, 0)); event.target.value = track.bars; edited(); };
  el.querySelector('.chain').onclick = () => chain(track);
  el.querySelector('.nudge-left').onclick = event => nudgeTrack(track, -1, event);
  el.querySelector('.nudge-right').onclick = event => nudgeTrack(track, 1, event);
  let taps = [];
  el.querySelector('.tap').onclick = () => { const now = performance.now(); if (taps.length && now - taps.at(-1) > 2000) taps = []; taps.push(now); taps = taps.slice(-8); if (taps.length > 1) { el.querySelector('.source-bpm').value = Math.round(60000 * (taps.length - 1) / (now - taps[0]) * 10) / 10; el.querySelector('.source-bpm').dispatchEvent(new Event('change')); } };
  setupAutomationEditor(track);
  extendTrack(track,el);
  renumber(); update(track); timeline(); renderAutomation(track);
  return track;
}
let timelineDuration = 60;
function timelineRailWidth() { return parseFloat(getComputedStyle($('#timeline')).getPropertyValue('--track-rail')) || 152; }
function drawClip(track, clip) {
  const canvas = clip.querySelector('canvas'); if (!canvas || !track.buffer) return;
  const left = Math.max(view.start, track.start), right = Math.min(view.start + timelineDuration, track.start + duration(track));
  const from = sourceStart(track)+(left-track.start)*rate(track), to = sourceStart(track)+(right-track.start)*rate(track);
  const scale = devicePixelRatio || 1;
  const width = Math.max(1, Math.round(clip.clientWidth * scale)), height = Math.max(1, Math.round(clip.clientHeight * scale));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, width, height); g.globalAlpha = .8;
  paintWave(g, track, width, height, from, to); g.globalAlpha = 1;
  drawBeatGrid(g,track,width,height,from,to);
  if (!track.automation.length) return;
  g.strokeStyle = '#e2e8f0'; g.lineWidth = scale;
  const x = time => (time - from) / Math.max(.001, to - from) * width;
  const y = value => 4 * scale + (1 - value) * (height - 8 * scale);
  g.beginPath(); g.moveTo(0, y(automationValue(track, from)));
  for(let pixel=1;pixel<=width;pixel+=2){const time=from+pixel/width*(to-from);g.lineTo(pixel,y(automationValue(track,time)));}
  g.lineTo(width, y(automationValue(track, to))); g.stroke();
  track.automation.filter(point => point.time >= from && point.time <= to).forEach(point => { g.beginPath(); g.arc(x(point.time), y(point.value), 2.5 * scale, 0, Math.PI * 2); g.fillStyle = '#f6eee7'; g.fill(); });
}
// Keep the captured clip node in place while dragging, and redraw just the
// visible source interval (the full clip may begin far outside a zoomed view).
function placeClip(track,clip){
  const from=Math.max(view.start,track.start),to=Math.min(view.start+timelineDuration,track.start+duration(track));
  clip.hidden=!!track.buffer&&to<=from;
  clip.style.left=`${track.buffer?(from-view.start)/timelineDuration*100:0}%`;
  clip.style.width=`${track.buffer?Math.max(.03,(to-from)/timelineDuration*100):100}%`;
}
function refreshMovingClips(){
  $('#timeline').querySelectorAll('.clip').forEach(clip=>{
    const track=tracks.find(t=>t.id===Number(clip.dataset.trackId));
    placeClip(track,clip);if(!clip.hidden)drawClip(track,clip);
  });
  const selected=tracks.find(t=>t.id===selectedId);if(selected){draw(selected);drawAutomation(selected);}updateFinePosition();
}
function timeline(preserveViewport=false) {
  const visibleDuration=timelineDuration,visibleStart=view.start;
  const total = Math.max(1, ...tracks.filter(track => track.buffer).map(track => track.start + duration(track)));
  view.total = tracks.some(track => track.buffer) ? Math.max(total, 10) : 60;
  if(preserveViewport&&view.zoom>1){view.total=Math.max(view.total,visibleStart+visibleDuration);view.zoom=view.total/visibleDuration;}
  view.zoom = clamp(view.zoom, 1, Math.min(16777216, view.total / .001));
  timelineDuration = view.total / view.zoom;
  view.start = clamp(view.start, 0, view.total - timelineDuration);
  $('#zoomLabel').textContent = view.zoom >= 1000000 ? `${(view.zoom / 1000000).toFixed(1)}M×` : view.zoom >= 1000 ? `${(view.zoom / 1000).toFixed(1)}k×` : `${view.zoom.toFixed(view.zoom < 10 ? 1 : 0)}×`;
  $('#panView').value = view.total > timelineDuration ? view.start / (view.total - timelineDuration) * 1000 : 0;
  $('#panView').disabled = view.zoom === 1;
  refreshRanges();
  $('#ruler').replaceChildren(...Array.from({ length: 7 }, (_, i) => { const span = document.createElement('span'); const time = view.start + timelineDuration * i / 6; span.textContent = rulerTime(time, timelineDuration); span.title = precisionTime(time); return span; }));
  const beat = 60 / Number($('#globalBpm').value), pixelsPerBeat = beat / timelineDuration * ($('#timeline').clientWidth - timelineRailWidth());
  // Thin beat lines are suppressed at low zoom; bar groups remain readable.
  let gridBeats = 1; while (pixelsPerBeat * gridBeats < 22) gridBeats *= 4;
  const gridWidth = pixelsPerBeat * gridBeats;
  $('#timeline').style.setProperty('--beat-width', `${gridWidth}px`);
  $('#timeline').style.setProperty('--grid-offset', `${-(view.start / beat * pixelsPerBeat) % gridWidth}px`);
  const pageCount = Math.max(1, Math.ceil(tracks.length / PAGE_SIZE)); timelinePage = Math.min(timelinePage, pageCount - 1);
  $('#pageLabel').textContent = `${timelinePage + 1} / ${pageCount}`;
  $('#prevPage').disabled = timelinePage === 0; $('#nextPage').disabled = timelinePage === pageCount - 1;
  $('#timeline').replaceChildren(...tracks.slice(timelinePage * PAGE_SIZE, (timelinePage + 1) * PAGE_SIZE).map((track, index) => {
    const i = timelinePage * PAGE_SIZE + index, row = document.createElement('div'); row.className = 'timeline-row';
    const clip = document.createElement('button'); clip.className = 'clip' + (track.id === selectedId ? ' selected-clip' : '');
    placeClip(track,clip);
    clip.dataset.trackId = track.id; clip.setAttribute('aria-label', `Pista ${i + 1}: ${track.name || 'Sin audio'}. Flechas: mover. Doble clic: punto de volumen.`);
    clip.style.setProperty('--clip-color', track.color); clip.style.background = track.color + '12'; clip.style.borderColor = track.color + '65'; clip.style.color = track.color;
    const label = document.createElement('span'); label.className = 'clip-label'; label.textContent = track.name || 'Sin audio';
    clip.append(label); clip.title = `${track.name || 'Pista vacía'} · inicio ${precisionTime(track.start)}`;
    setupClipDrag(clip, row, track); if (!audible(track)) clip.style.opacity = '.35';
    if (track.buffer) { const mini = document.createElement('canvas'); mini.className = 'mini-wave'; mini.width = 1200; mini.height = 50; clip.append(mini); }
    row.append(clip);
    if (clip.hidden) { const off = document.createElement('button'); off.className = 'offscreen-track'; off.textContent = `${i + 1} / ${track.name} · fuera de vista ↗`; off.onclick = () => { selectTrack(track); view.start = clamp(track.start, 0, view.total - timelineDuration); timeline(); }; row.append(off); }
    const strip = document.createElement('div'); strip.className = 'track-strip';
    const head = document.createElement('button'); head.className = 'track-rail'; head.classList.toggle('is-selected', track.id === selectedId); head.style.setProperty('--track-color', track.color);
    const number = document.createElement('span'); number.className = 'rail-number'; number.textContent = String(i + 1).padStart(2, '0');
    const info = document.createElement('span'); info.className = 'rail-info';
    const name = document.createElement('strong'); name.textContent = track.name || 'Pista vacía';
    const meta = document.createElement('small'); meta.textContent = track.buffer ? `${targetTempo(track)} BPM · ${harmonicLabel(track)}${track.muted ? ' · MUTE' : ''}` : 'Cargar audio';
    info.append(name, meta); head.append(number, info); head.title = track.name || 'Seleccionar pista'; head.setAttribute('aria-pressed', String(track.id === selectedId)); head.onclick = () => selectTrack(track);
    const rail = document.createElement('div'); rail.className = 'track-header';
    const mute = document.createElement('button'); mute.className = 'rail-mute icon-button'; mute.dataset.muteTrackId = track.id;
    mute.innerHTML = uiIcon(track.muted ? 'volumeOff' : 'volume');
    mute.setAttribute('aria-label', `Silenciar pista ${i + 1}: ${track.name || 'Sin audio'}`);
    mute.setAttribute('aria-pressed', String(track.muted));
    mute.title = `${track.muted ? 'Activar audio' : 'Silenciar'} · ${track.name || 'Pista ' + (i + 1)}`;
    mute.disabled = busy;
    mute.onclick = () => {
      const restoreFocus = document.activeElement === mute;
      toggleTrackMute(track);
      if (restoreFocus) document.querySelector(`[data-mute-track-id="${track.id}"]`)?.focus({ preventScroll: true });
    };
    extendRail(track,rail,head,mute);
    rail.append(head, mute); strip.append(rail, row); return strip;
  }));
  if (tracks.length <= 1 && !tracks.some(track => track.buffer)) {
    const empty = document.createElement('div'); empty.className = 'timeline-empty';
    empty.innerHTML = '<h2>Empieza con tu primer tema</h2><p>Importa uno o varios archivos para montar la sesión.</p><button data-icon="import">Importar audio</button><small>MP3 · WAV · FLAC · OGG</small>';
    empty.querySelector('button').onclick = () => $('#multiFiles').click();
    $('#timeline').append(empty); decorateIcons(empty);
  }
  decorateArrangement();
  $('#timeline').querySelectorAll('.clip').forEach(clip => { const track = tracks.find(item => item.id === Number(clip.dataset.trackId)); if (!clip.hidden) drawClip(track, clip); });
  const cursor = document.createElement('div'); cursor.id = 'sessionCursor'; $('#timeline').append(cursor);
  updateClock(); updateFinePosition();
  const selected = tracks.find(track => track.id === selectedId); if (selected) { draw(selected); drawAutomation(selected); }
}
function zoomTimeline(factor, anchor = null, fraction = .5) {
  if (anchor === null) { const selected = tracks.find(track => track.id === selectedId); anchor = session.playing ? sessionPosition() : selected ? selected.start + (Math.max(sourceStart(selected),position(selected))-sourceStart(selected)) / rate(selected) : view.start + timelineDuration / 2; if (anchor < view.start || anchor > view.start + timelineDuration) anchor = view.start + timelineDuration / 2; }
  view.zoom = clamp(view.zoom * factor, 1, Math.min(16777216, view.total / .001));
  view.start = clamp(anchor - view.total / view.zoom * fraction, 0, view.total - view.total / view.zoom);
  timeline();
}
$('#zoomIn').onclick = () => zoomTimeline(2);
$('#zoomOut').onclick = () => zoomTimeline(.5);
$('#zoomDetail').onclick = () => {
  const selected = tracks.find(track => track.id === selectedId);
  const anchor = session.playing || session.offset > 0 ? sessionPosition() : selected ? selected.start + (Math.max(sourceStart(selected),position(selected))-sourceStart(selected)) / rate(selected) : view.start;
  view.zoom = view.total / .05;
  view.start = clamp(anchor - .025, 0, Math.max(0, view.total - .05)); timeline();
};
$('#zoomFit').onclick = () => { view.zoom = 1; view.start = 0; timeline(); };
$('#panView').oninput = event => { view.start = Number(event.target.value) / 1000 * Math.max(0, view.total - timelineDuration); timeline(); };
$('#timeline').addEventListener('wheel', event => {
  event.preventDefault();
  const rect = $('#timeline').getBoundingClientRect(), fraction = clamp((event.clientX - rect.left - timelineRailWidth()) / (rect.width - timelineRailWidth()), 0, 1);
  if (event.ctrlKey || event.metaKey) zoomTimeline(event.deltaY < 0 ? 1.4 : 1 / 1.4, view.start + fraction * timelineDuration, fraction);
  else { view.start = clamp(view.start + (event.deltaX || event.deltaY) / (rect.width - timelineRailWidth()) * timelineDuration, 0, view.total - timelineDuration); timeline(); }
}, { passive: false });

function updateClock() {
  const end = Math.max(0, ...plan().map(item => item.end));
  const time = Math.max(0, sessionPosition());
  $('#sessionTime').innerHTML = `<span class="clock-current">${format(time)}</span><span class="clock-divider"> / </span><span class="clock-total">${format(end)}</span>`;
  $('#ruler').setAttribute('aria-valuemax', String(view.total));
  $('#ruler').setAttribute('aria-valuenow', String(Math.min(time, view.total)));
  $('#ruler').setAttribute('aria-valuetext', format(time));
  const cursor = $('#sessionCursor'); if (cursor) { cursor.hidden = time < view.start || time > view.start + timelineDuration; cursor.style.left = `${timelineRailWidth() + clamp((time - view.start) / timelineDuration, 0, 1) * ($('#timeline').clientWidth - timelineRailWidth())}px`; }
}
$('#prevPage').onclick = () => { timelinePage = Math.max(0, timelinePage - 1); timeline(); };
$('#nextPage').onclick = () => { timelinePage++; timeline(); };
$('#ruler').onclick = event => { const rect = event.currentTarget.getBoundingClientRect(); const resume = session.playing; pauseSession(); session.offset = view.start + clamp((event.clientX - rect.left) / rect.width, 0, 1) * timelineDuration; updateClock(); if (resume) playSession(); };
$('#ruler').onkeydown = event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const resume = session.playing; pauseSession(); session.offset = event.key === 'Home' ? 0 : event.key === 'End' ? view.total : clamp(session.offset + (event.key === 'ArrowRight' ? 1 : -1) * 60 / Number($('#globalBpm').value), 0, view.total); updateClock(); if (resume) playSession(); };
$('#addTrack').onclick = () => { edited(); const track = addTrack(); selectTrack(track); status('Pista añadida. Carga un tema y ajusta su posición.'); };
$('#importTracks').onclick = () => $('#multiFiles').click();
$('#multiFiles').onchange = async event => {
  if (busy) return;
  const files = [...event.target.files]; event.target.value = '';
  busy = true; lock(true);
  try {
    edited();
    let loaded = 0;
    for (const file of files) {
      const empty = tracks.find(track => !track.buffer && !track.file);
      const track = empty || addTrack();
      if (await load(track, file)) { chain(track); loaded++; }
    }
    status(`${loaded} de ${files.length} temas importados y encadenados. Revisa los BPM y las transiciones.`);
  } finally { busy = false; lock(false); }
};
function retime() {
  const playing = tracks.filter(track => track.playing);
  playing.forEach(pause);
  edited(); tracks.forEach(update); playing.forEach(play);
}
async function changeGlobalTempo() {
  const previous = appliedGlobalBpm;
  const next = clamp($('#globalBpm').value, 40, 240, previous);
  $('#globalBpm').value = next;
  if (next === previous) { tracks.forEach(update); timeline(); return; }
  const linked = $('#globalSync').checked ? tracks.filter(track => track.followGlobal) : [];
  const resumeSession = linked.length > 0 && (session.playing || session.pending);
  const playing = linked.filter(track => track.playing);
  if (resumeSession) pauseSession();
  playing.forEach(pause);
  const ratio = previous / next;
  const previousTotal = view.total;
  for (const track of tracks) {
    if (!linked.includes(track)) { track.tempoAnchor = null; continue; }
    // Keep an unrounded reference until the user edits placement again.
    // Returning to the reference tempo restores the exact sample-level position.
    if (!track.tempoAnchor || track.start !== track.tempoAnchor.lastStart) {
      track.tempoAnchor = { start: track.start, bpm: previous, lastStart: track.start };
    }
    const anchor = track.tempoAnchor;
    track.start = next === anchor.bpm ? anchor.start : anchor.start * anchor.bpm / next;
    anchor.lastStart = track.start;
    trackEl(track).querySelector('.track-start').value = track.start.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (linked.length) {
    // Keep the same source moment under the playhead and zoomed viewport.
    session.offset *= ratio;
    loopRegion.start*=ratio;loopRegion.end*=ratio;markers.forEach(marker=>marker.time*=ratio);
    view.start *= ratio;
    const total = Math.max(1, ...tracks.filter(track => track.buffer).map(track => track.start + duration(track)));
    const nextTotal = tracks.some(track => track.buffer) ? Math.max(total, 10) : 60;
    view.zoom *= nextTotal / previousTotal / ratio;
  }
  appliedGlobalBpm = next; markDirty();
  tracks.forEach(update); timeline();
  if (playing.length) await Promise.all(playing.map(play));
  if (resumeSession) await playSession();
  status(linked.length ? `Tempo global: ${next} BPM · alineación y ajuste fino conservados en ${linked.length} pistas vinculadas.` : `Tempo global: ${next} BPM · posiciones de las pistas independientes conservadas.`);
}
$('#globalBpm').onchange = changeGlobalTempo;
$('#globalSync').onchange = retime;
$('#curve').onchange = edited;
$('#master').oninput = () => { edited(true); syncLiveMix(); tracks.forEach(track => { if (track.node) scheduleIndividualGain(track, track.node); }); };
$('#playSession').onclick = playSession;
$('#stopSession').onclick = stopSession;
function settings() { return { globalBpm: Number($('#globalBpm').value), globalSync: $('#globalSync').checked, master: Number($('#master').value), curve: $('#curve').value, normalize: $('#normalize').value, mastering: masteringSettings(), nudgeStep: $('#nudgeStep').value }; }
function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function safeName() { return ($('#projectName').value.trim() || 'Mi sesión').replace(/[<>:"/\\|?*]/g, '_'); }
function base64(bytes) { let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(text); }
function lock(value) { window.simpleMix?.setBusy(value).catch(reportError);document.querySelectorAll('main,.app-header').forEach(el=>el.inert=value);document.querySelectorAll('button,input,select').forEach(el => {if(value){el.dataset.wasDisabled=String(el.disabled);el.disabled=true;}else if(el.dataset.wasDisabled!==undefined){el.disabled=el.dataset.wasDisabled==='true';delete el.dataset.wasDisabled;}}); if(!value){timeline();updateExportOptions();updateHistoryButtons();} }
function updateProjectFile(info = activeProject) {
  activeProject = info;
  $('#activeFile').textContent = info ? info.name : I18n.t('Sin guardar');
  $('#activeFile').setAttribute('translate','no');
  $('#activeFile').title = info?.path || info?.name || 'El proyecto todavía no tiene un archivo asociado';
  $('#activeFile').classList.toggle('unsaved', projectDirty);
  document.title = `${projectDirty ? '● ' : ''}${info?.name || $('#projectName').value || 'Nuevo proyecto'} — Simple Mix ${APP_VERSION}`;
}
function markDirty() { documentRevision++; projectDirty = true; updateProjectFile(); studioDirty(); }
async function serializeProject() {
  const name=$('#projectName').value,savedSettings=JSON.parse(JSON.stringify({...settings(),...studioSettings()}));
  const saved = await Promise.all(tracks.map(async track => ({ name: track.name, bpm: track.bpm, targetBpm: track.targetBpm, followGlobal: track.followGlobal, targetEdited: track.targetEdited, volume: track.volume, eq: [...track.eq], start: track.start, bars: track.bars, muted: track.muted, automation: track.automation.map(point => ({...point})), bpmMode: track.bpmMode === 'auto' ? 'auto' : 'manual', bpmConfidence: track.bpmConfidence, ...extraTrackData(track), wavePeaks:track.peaks?Array.from(track.peaks):null, audio: track.file ? await encodedFile(track.file) : null, type: track.file?.type })));
  return JSON.stringify({ version: 4, name, settings:savedSettings, tracks: saved });
}
async function saveProject(saveAs = false) {
  if (busy) return false;
  busy = true; lock(true);
  try {
    status('Guardando proyecto con todas sus pistas y audios…');
    const revision=documentRevision,content = await serializeProject();
    let info;
    if (window.simpleMix) {
      info = await window.simpleMix.saveProject({ content, saveAs, defaultName: safeName() + '.simplemix' });
      if (info.canceled) { status('Guardado cancelado.'); return false; }
    } else {
      download(new Blob([content], { type: 'application/json' }), safeName() + '.simplemix');
      info = { name: safeName() + '.simplemix' };
    }
    projectDirty = documentRevision!==revision; updateProjectFile(info);if(projectDirty)studioDirty();else studioSaved(info);
    status(projectDirty?I18n.t('Guardado; hay cambios posteriores pendientes.'):I18n.t(`Guardado: ${info.name} · ${tracks.length} pistas.`));
    return !projectDirty;
  } catch (error) { status(`Error al guardar: ${error.message}`); return false; } finally { busy = false; lock(false); }
}
$('#saveProject').onclick = () => saveProject(false);
$('#saveProjectAs').onclick = () => saveProject(true);
$('#projectName').oninput = markDirty;
$('#openProject').onclick = async () => {
  if (busy || !await confirmUnsaved()) return;
  if (!window.simpleMix) return $('#projectFile').click();
  try {
    const result = await window.simpleMix.openProject();
    if (result.canceled) return;
    await openProject(new File([result.content], result.name, { type: 'application/json' }), result);
  } catch (error) { status('No se pudo abrir el proyecto: ' + error.message); }
};
async function openProject(file, nativeSelection = null) {
  if (busy) return;
  busy = true; lock(true);
  try {
    status('Abriendo proyecto…');
    const project = JSON.parse(await file.text());
    if (![1, 2, 3, 4].includes(project.version) || !Array.isArray(project.tracks) || !project.settings) throw Error('Formato de proyecto no compatible');
    const savedSettings = project.settings;
    if (!Number.isFinite(savedSettings.globalBpm) || savedSettings.globalBpm < 40 || savedSettings.globalBpm > 240 || !['equal', 'linear'].includes(savedSettings.curve) || !['peak', 'none', 'master'].includes(savedSettings.normalize)) throw Error('Configuración global inválida');
    const savedMaster = validateMasteringSettings(savedSettings.mastering || {});
    const restored = [];
    // Validate and decode every file before replacing the current session.
    for (let i = 0; i < project.tracks.length; i++) {
      const item = project.tracks[i];
      const track = { ...item, start: project.version === 1 ? (i ? savedSettings.startB : 0) : item.start, bars: project.version === 1 ? savedSettings.bars : item.bars, muted: project.version === 1 ? false : item.muted };
      if (!Number.isFinite(track.bpm) || track.bpm < 40 || track.bpm > 240 || !Number.isFinite(track.volume) || track.volume < 0 || track.volume > 1 || !Array.isArray(track.eq) || track.eq.length !== 3 || track.eq.some(v => !Number.isFinite(v) || v < -24 || v > 12) || !Number.isFinite(track.start) || track.start < 0 || track.start > 10800 || !Number.isInteger(track.bars) || track.bars < 0 || track.bars > 128 || typeof track.muted !== 'boolean') throw Error('Configuración de pista inválida');
      const points = track.automation ?? [];
      if (!Array.isArray(points) || points.some(point => !Number.isFinite(point.time) || point.time < 0 || !Number.isFinite(point.value) || point.value < 0 || point.value > 1) || points.some((point, j) => j > 0 && point.time <= points[j - 1].time)) throw Error('Puntos de volumen inválidos');
      if (project.version >= 3 && (!Number.isFinite(track.targetBpm) || track.targetBpm < 40 || track.targetBpm > 240 || typeof track.followGlobal !== 'boolean')) throw Error('Tempo de pista inválido');
      const clean = { bpm: track.bpm, targetBpm: project.version >= 3 ? track.targetBpm : track.bpm, followGlobal: project.version >= 3 ? track.followGlobal : true, targetEdited: project.version >= 3 ? !!track.targetEdited : false, volume: track.volume, eq: [...track.eq], start: track.start, bars: track.bars, muted: track.muted, automation: points.map(point => ({ time: point.time, value: point.value, curve: ['linear','equal','smooth','exponential'].includes(point.curve)?point.curve:'linear' })), bpmMode: track.bpmMode === 'auto' ? 'auto' : 'manual', bpmConfidence: Number.isFinite(track.bpmConfidence) ? track.bpmConfidence : null };
      if (track.audio) {
        const bytes = Uint8Array.from(atob(track.audio), c => c.charCodeAt(0));
        Object.assign(clean, await decodeFile(new File([bytes], typeof track.name === 'string' ? track.name : 'Audio', { type: track.type || 'audio/mpeg' }),track.wavePeaks));
      }
      Object.assign(clean,validateExtraTrack(track,clean.buffer));
      restored.push(clean);
    }
    const accepted = nativeSelection ? await window.simpleMix.acceptProject(nativeSelection.token) : { name: file.name };
    stopSession(); view.zoom = 1; view.start = 0; tracks.forEach(stop); tracks.splice(0); $('#decks').replaceChildren();
    $('#projectName').value = typeof project.name === 'string' ? project.name : 'Mi sesión';
    $('#globalBpm').value = savedSettings.globalBpm; appliedGlobalBpm = savedSettings.globalBpm; $('#globalSync').checked = !!savedSettings.globalSync;
    $('#master').value = clamp(savedSettings.master ?? .85, 0, 1, .85);
    $('#curve').value = savedSettings.curve; $('#normalize').value = savedSettings.normalize;
    applyMasteringSettings(savedMaster);
    $('#nudgeStep').value = [...$('#nudgeStep').options].some(option => option.value === savedSettings.nudgeStep) ? savedSettings.nudgeStep : '.001';
    restoreStudioSettings(savedSettings,project.version);
    restored.forEach(track => addTrack(track)); renumber(); timeline();
    resetMasterReport();projectDirty = false; updateProjectFile(accepted); studioOpened();
    status(`Proyecto recuperado: ${tracks.length} pistas.`);
    return true;
  } catch (error) { status('No se pudo abrir el proyecto: ' + error.message); return false; } finally { busy = false; lock(false); }
}
$('#projectFile').onchange = async event => { if (event.target.files[0]) await openProject(event.target.files[0]); event.target.value = ''; };
function wav(buffer) {
  const frames = buffer.length, bytes = new ArrayBuffer(44 + frames * 4), view = new DataView(bytes);
  const str = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + frames * 4, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, 44100, true); view.setUint32(28, 176400, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, frames * 4, true);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const gain = $('#normalize').value === 'peak' && peak > 0 ? Math.pow(10, -1 / 20) / peak : 1;
  let clipped = 0;
  for (let i = 0; i < frames; i++) for (let channel = 0; channel < 2; channel++) {
    const value = (channel ? right[i] : left[i]) * gain;
    if (Math.abs(value) > 1) clipped++;
    const sample = clamp(value, -1, 1);
    view.setInt16(44 + (i * 2 + channel) * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return { blob: new Blob([bytes], { type: 'audio/wav' }), clipped };
}
function floatWav(buffer) {
  const frames = buffer.length, bytes = new ArrayBuffer(44 + frames * 8), view = new DataView(bytes);
  const str = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  str(0,'RIFF'); view.setUint32(4,36+frames*8,true); str(8,'WAVE'); str(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,3,true); view.setUint16(22,2,true); view.setUint32(24,44100,true); view.setUint32(28,352800,true); view.setUint16(32,8,true); view.setUint16(34,32,true); str(36,'data'); view.setUint32(40,frames*8,true);
  for (let channel=0;channel<2;channel++) { const data=buffer.getChannelData(Math.min(channel,buffer.numberOfChannels-1)); for(let i=0;i<frames;i++)view.setFloat32(44+(i*2+channel)*4,data[i],true); }
  return { blob: new Blob([bytes],{type:'audio/wav'}), clipped:0 };
}
async function renderSession() {
  const items = plan();
  if (!items.length) throw Error('Carga al menos una pista sin silenciar.');
  const total = Math.max(...items.map(item => item.end));
  if (total > 10800) throw Error('La sesión supera el límite de tres horas de esta versión.');
  await prepareTracks(items.map(i=>i.track));
  const offline = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * 44100)), 44100);
  schedule(offline, items, 0, 0);
  return offline.startRendering();
}
function exportOptions() {
  return { format: $('#exportFormat').value, bitrate: Number($('#mp3Bitrate').value), compression: Number($('#flacCompression').value), mastering: $('#normalize').value === 'master' ? masteringSettings() : null };
}
function resetMasterReport(){lastMasterReport=null;$('#masterReportButton').hidden=true;}
function updateExportOptions() {
  $('#masteringOptions').hidden = $('#normalize').value !== 'master';
  const format = $('#exportFormat').value;
  $('#mp3Options').hidden = format !== 'mp3'; $('#flacOptions').hidden = format !== 'flac';
  $('#confirmExport').textContent = 'Exportar ' + format.toUpperCase();
  $('#exportDepth').disabled=format==='mp3';
  $('#exportCue').disabled=format!=='wav'||$('#exportRate').value!=='44100'||$('#exportDepth').value!=='16';
  if($('#exportCue').disabled)$('#exportCue').checked=false;
  window.customSelectRefresh?.();
  const frequency=new Intl.NumberFormat(I18n.locale()).format(Number($('#exportRate').value)/1000);
  $('#exportFormatHint').textContent = format === 'flac' ? `Estéreo · ${$('#exportDepth').value} bits · ${frequency} kHz · compresión sin pérdida.` : format === 'mp3' ? `Estéreo · ${frequency} kHz · bitrate constante (CBR).` : `Estéreo · PCM ${$('#exportDepth').value} bits · ${frequency} kHz`;
}
async function exportMix(options = exportOptions()) {
  if(window.simpleMix?.beginExport)return exportInBlocks(options);
  if (busy) return false;
  busy = true; lock(true);
  try {
    const format = options.format || 'wav';
    const mastering = options.mastering || ($('#normalize').value === 'master' ? masteringSettings() : null);
    if (!['wav', 'flac', 'mp3'].includes(format)) throw Error('Formato de exportación no compatible.');
    if (!window.simpleMix && (format !== 'wav' || mastering)) throw Error('Abre la aplicación de escritorio para masterizar o exportar a FLAC o MP3.');
    status(`Renderizando la sesión para ${format.toUpperCase()}…`);
    $('#exportProgress').textContent = `Preparando ${format.toUpperCase()}…`;
    await new Promise(resolve => setTimeout(resolve, 50));
    const rendered = await renderSession();
    const result = mastering ? floatWav(rendered) : wav(rendered);
    if (window.simpleMix) {
      $('#exportProgress').textContent = mastering ? 'Analizando LUFS, masterizando y verificando el archivo final…' : format === 'wav' ? 'Guardando WAV…' : `Codificando ${format.toUpperCase()}…`;
      const saved = await window.simpleMix.exportAudio({ wav: await result.blob.arrayBuffer(), format, bitrate: options.bitrate, compression: options.compression, mastering, defaultName: safeName() });
      if (saved.canceled) { status('Exportación cancelada.'); $('#exportProgress').textContent = 'Exportación cancelada.'; return false; }
      if (saved.mastering) lastMasterReport = { ...saved.mastering, name: saved.name };
      status(`Exportado: ${saved.name}${format === 'mp3' ? ' · ' + options.bitrate + ' kbps' : ''}${result.clipped ? ' · Hay picos recortados; revisa el acabado.' : ''}`);
    } else {
      download(result.blob, safeName() + '.wav');
      status(result.clipped ? 'WAV exportado con picos recortados. Activa la normalización o reduce las ganancias.' : 'Sesión exportada en WAV estéreo, 44.1 kHz / 16 bit.');
    }
    $('#exportDialog').close();
    if (mastering && lastMasterReport) showMasterReport();
    return true;
  } catch (error) { status('Error de exportación: ' + error.message); $('#exportProgress').textContent = error.message; return false; } finally { busy = false; lock(false); }
}
const MASTER_PROFILES = {
  balanced: { profile: 'balanced', lufs: -14, truePeak: -1, compression: true },
  techno: { profile: 'techno', lufs: -12, truePeak: -1, compression: true },
  dynamic: { profile: 'dynamic', lufs: -16, truePeak: -1.5, compression: true }
};
function validateMasteringSettings(value) {
  const profile = value.profile || 'balanced', preset = MASTER_PROFILES[profile];
  if (!preset) throw Error('Perfil de masterización no compatible.');
  const lufs = Number(value.lufs ?? preset.lufs), truePeak = Number(value.truePeak ?? preset.truePeak);
  if (!Number.isFinite(lufs) || lufs < -24 || lufs > -9 || !Number.isFinite(truePeak) || truePeak < -3 || truePeak > -.5 || value.compression !== undefined && typeof value.compression !== 'boolean') throw Error('Objetivos de masterización inválidos.');
  return { enabled: true, profile, lufs, truePeak, compression: value.compression ?? true };
}
function masteringSettings() { return validateMasteringSettings({ profile: $('#masterProfile').value, lufs: Number($('#targetLufs').value), truePeak: Number($('#targetTruePeak').value), compression: $('#masterCompressor').checked }); }
function applyMasteringSettings(value) { $('#masterProfile').value=value.profile;$('#targetLufs').value=value.lufs;$('#targetTruePeak').value=value.truePeak;$('#masterCompressor').checked=value.compression; }
function showMasterReport() {
  if (!lastMasterReport) return;
  const report=lastMasterReport, display=(value,unit)=>value===null?'No medible':`${Number(value).toFixed(2)} ${unit}`;
  $('#masterReportFile').textContent=report.name;
  for(const [prefix,values] of [['Before',report.before],['After',report.after]]) {
    $('#report'+prefix+'Lufs').textContent=display(values.lufs,'LUFS');
    $('#report'+prefix+'Peak').textContent=display(values.truePeak,'dBTP');
    $('#report'+prefix+'Lra').textContent=display(values.lra,'LU');
  }
  $('#masterReportTarget').textContent=`${I18n.t(report.label)} · objetivo ${report.targetLufs} LUFS · techo ${report.targetTruePeak} dBTP · ${report.compression?'compresión suave':'sin compresor previo'}`;
  $('#masterReportNotes').textContent=report.notes.map(note=>I18n.t(note)).join(' ');
  $('#masterReportButton').hidden=false;
  if (!$('#masterReportDialog').open) $('#masterReportDialog').showModal();
}
$('#masterProfile').onchange=()=>{applyMasteringSettings(MASTER_PROFILES[$('#masterProfile').value]);markDirty();};
$('#targetLufs').onchange=()=>{$('#targetLufs').value=clamp($('#targetLufs').value,-24,-9,-14);markDirty();};
$('#targetTruePeak').onchange=()=>{$('#targetTruePeak').value=clamp($('#targetTruePeak').value,-3,-.5,-1);markDirty();};
$('#masterCompressor').onchange=markDirty;
$('#normalize').onchange=()=>{markDirty();updateExportOptions();};
$('#masterReportButton').onclick=showMasterReport;
$('#closeMasterReport').onclick=()=>$('#masterReportDialog').close();
$('#export').onclick = () => { if (!busy) { updateExportOptions(); $('#exportProgress').textContent = ''; $('#exportDialog').showModal(); } };
$('#cancelExport').onclick = () => { if (!busy) $('#exportDialog').close(); };
$('#exportDialog').oncancel = event => { if (busy) event.preventDefault(); };
$('#exportFormat').onchange = ()=>{markDirty();updateExportOptions();};
$('#mp3Bitrate').onchange=markDirty;$('#flacCompression').onchange=markDirty;$('#exportRegion').onchange=markDirty;$('#exportCue').onchange=markDirty;
$('#exportRate').onchange=()=>{markDirty();updateExportOptions();};$('#exportDepth').onchange=()=>{markDirty();updateExportOptions();};
$('#exportForm').onsubmit = event => { event.preventDefault(); exportMix(); };
function updateFinePosition() {
  const selected = tracks.find(track => track.id === selectedId);
  $('#finePosition').textContent = selected ? `${precisionTime(selected.start)} · #${Math.round(selected.start * PROJECT_SAMPLE_RATE).toLocaleString(I18n.locale())}` : 'Sin pista';
  $('#finePosition').title = 'Posición exacta: minutos:segundos.microsegundos · índice de muestra del proyecto a 44.100 Hz';
}
function nudgeTrack(track, direction, event = {}) {
  if (busy || !track || !tracks.includes(track) || track.locked) return;
  const sampleMode = $('#nudgeStep').value === 'sample';
  const base = sampleMode ? 1 / PROJECT_SAMPLE_RATE : Number($('#nudgeStep').value);
  const step = Math.max(1 / PROJECT_SAMPLE_RATE, base * (event.shiftKey ? .1 : event.altKey ? 10 : 1));
  const before = track.start;
  markDirty();
  // Do not round placement to milliseconds or microseconds. Preserve the exact sample grid.
  const next = clamp(sampleMode ? (Math.round(before * PROJECT_SAMPLE_RATE) + direction * Math.max(1, Math.round(step * PROJECT_SAMPLE_RATE))) / PROJECT_SAMPLE_RATE : before + direction * step, 0, 10800);
  const resume = session.playing || session.pending;
  if (resume) pauseSession();
  const refocus = document.activeElement?.classList.contains('clip');
  moveSelection(track,next-before);
  timelinePage = Math.floor(tracks.indexOf(track) / PAGE_SIZE);
  selectTrack(track);
  trackEl(track).querySelector('.track-start').value = track.start.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  // Nudging must preserve the inspected beat and the seconds-per-pixel scale.
  timeline(true);
  if (refocus) document.querySelector(`[data-track-id="${track.id}"]`)?.focus({ preventScroll: true });
  const milliseconds = (next - before) * 1000;
  const displacement = Math.abs(milliseconds) < 1 ? `${(milliseconds * 1000).toFixed(3)} µs` : `${milliseconds.toFixed(3)} ms`;
  const message = `Pista ${tracks.indexOf(track) + 1} · inicio ${precisionTime(track.start)} · ${milliseconds >= 0 ? '+' : ''}${displacement} · muestra ${Math.round(track.start * PROJECT_SAMPLE_RATE).toLocaleString(I18n.locale())} @ 44,1 kHz`;
  status(message);
  if (resume) playSession().then(() => status(message));
}
document.addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.target.closest('input, select, textarea, [contenteditable], [role=combobox], dialog')) {
    const clip = event.target.closest('.clip');
    const inspector = event.target.closest('.deck');
    const track = tracks.find(item => item.id === (clip ? Number(clip.dataset.trackId) : inspector ? Number(inspector.id.slice(5)) : selectedId));
    if (track && !busy) { event.preventDefault(); nudgeTrack(track, event.key === 'ArrowRight' ? 1 : -1, event); }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && ['s', 'o'].includes(event.key.toLowerCase())) {
    event.preventDefault(); if (!busy&&!document.querySelector('dialog[open]')) $(event.key.toLowerCase() === 's' ? event.shiftKey ? '#saveProjectAs' : '#saveProject' : '#openProject').click(); return;
  }
  if (event.code === 'Space' && !busy && !event.target.closest('input, select, button, canvas, dialog')) { event.preventDefault(); playSession(); }
});
window.addEventListener('resize', () => timeline());
setInterval(() => { if (session.playing) { updateClock(); tracks.forEach(draw); } else tracks.forEach(track => { if (track.playing) update(track); }); }, 80);
function scheduleIndividualGain(track, node) {
  const now=ctx.currentTime,from=position(track);
  scheduleEnvelope(node.gain.gain,track,from,sourceEnd(track),now,rate(track));
  scheduleTone(node,track,from,sourceEnd(track),now,rate(track));
  syncLiveMix();
}
async function detectBpm(track) {
  if (!track.buffer) return;
  const token = ++track.detectToken, buffer = track.buffer, previousMode=track.bpmMode;
  const rateOut = 8000, start = Math.min(20, buffer.duration / 4), seconds = Math.min(120, buffer.duration - start);
  const samples = new Float32Array(Math.floor(seconds * rateOut));
  let channel=0,bestEnergy=-1;for(let c=0;c<buffer.numberOfChannels;c++){const data=buffer.getChannelData(c);let energy=0;for(let i=0;i<data.length;i+=211)energy+=data[i]*data[i];if(energy>bestEnergy){bestEnergy=energy;channel=c;}}
  {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      const from = Math.floor((start + i / rateOut) * buffer.sampleRate), to = Math.min(data.length, Math.floor((start + (i + 1) / rateOut) * buffer.sampleRate));
      let value = 0; for (let j = from; j < to; j++) value += data[j];
      samples[i] = value / Math.max(1, to - from);
    }
  }
  track.bpmMode = 'detecting'; update(track);
  let worker;
  try {
    const result = await new Promise((resolve, reject) => {
      worker = new Worker('../workers/bpm-worker.js');
      const timer = setTimeout(() => { worker.terminate(); reject(Error('Tiempo de análisis agotado')); }, 20000);
      worker.onmessage = event => { clearTimeout(timer); event.data.error ? reject(Error(event.data.error)) : resolve(event.data.result); };
      worker.onerror = event => { clearTimeout(timer); reject(Error(event.message)); };
      worker.postMessage({ samples, sampleRate: rateOut }, [samples.buffer]);
    });
    if (!tracks.includes(track) || token !== track.detectToken || track.buffer!==buffer) return;
    if (result) {
      const resume = track.playing; pause(track); edited();
      track.sourceBpm=clamp(result.sourceBpm??result.bpm,40,240,140); track.bpm = Math.round(track.sourceBpm); if (!track.targetEdited) track.targetBpm = track.bpm; track.bpmMode = 'auto'; track.bpmConfidence = result.confidence; track.firstBeat = result.phase!==undefined ? ((start+result.phase)%(60/sourceTempo(track))) : estimateFirstBeat(track);
      update(track);
      if (resume) play(track);
      status(`Tempo estimado: ${track.bpm} BPM. Puedes corregirlo manualmente o con TAP.`);
    } else { track.bpmMode = previousMode==='auto'?'auto':'manual'; status('No se ha detectado un pulso fiable. Usa los BPM manuales o TAP.'); }
    update(track); timeline();
  } catch (error) { if (token === track.detectToken && tracks.includes(track)) { track.bpmMode = previousMode==='auto'?'auto':'manual'; update(track); status(`BPM automáticos no disponibles: ${error.message}. Puedes introducirlos manualmente.`); } }
  finally { worker?.terminate(); }
}
function setupClipDrag(clip, row, track) {
  let drag = null;
  const coords = event => { const rect = row.getBoundingClientRect(); return { time: clamp((view.start + (event.clientX - rect.left) / rect.width * timelineDuration - track.start) * rate(track)+sourceStart(track), 0, track.buffer?.duration || 0), value: 1 - clamp((event.clientY - clip.getBoundingClientRect().top - 4) / Math.max(1, clip.getBoundingClientRect().height - 8), 0, 1) }; };
  const nearest = event => { if (!track.buffer) return null; const point = coords(event), rect = row.getBoundingClientRect(); return track.automation.find(p => Math.hypot((p.time - point.time) / rate(track) / timelineDuration * rect.width, (p.value - point.value) * (clip.getBoundingClientRect().height - 8)) < 8); };
  clip.ondblclick = event => { if (!track.buffer || busy) return; event.preventDefault(); const point = coords(event); putPoint(track, point.time, point.value); automationChanged(track); selectTrack(track); };
  clip.oncontextmenu = event => { event.preventDefault(); const point = nearest(event); if (point && !busy) { track.automation.splice(track.automation.indexOf(point), 1); automationChanged(track); } };
  clip.onpointerdown = event => {
    if (event.button !== 0 || busy || track.locked) return;
    event.preventDefault();
    drag = { x: event.clientX, start: track.start, moved: false, duration: timelineDuration, viewStart: view.start, width: row.getBoundingClientRect().width, point: nearest(event) };
    clip.setPointerCapture(event.pointerId);
    selectionGesture(track,event);
    selectTrack(track);
  };
  clip.onpointermove = event => {
    if (!drag) return;
    const distance = event.clientX - drag.x;
    if ((Math.abs(distance) > 2 || drag.point) && !drag.moved) { pauseSession(); drag.moved = true; }
    if (!drag.moved) return;
    if (drag.point) {
      const point = coords(event), index = track.automation.indexOf(drag.point);
      drag.point.time = clamp(point.time, index ? track.automation[index - 1].time + .001 : 0, index < track.automation.length - 1 ? track.automation[index + 1].time - .001 : track.buffer.duration);
      drag.point.value = point.value;
      if (track.node) scheduleIndividualGain(track, track.node);
      drawClip(track, clip); drawAutomation(track);
      status(`Punto: ${precisionTime(drag.point.time)} · ${Math.round(drag.point.value * 100)}%`);
    } else {
      const raw = drag.start + distance / drag.width * drag.duration*(event.altKey?.1:1);
      const step = !event.shiftKey && !event.altKey && $('#snapBeats').checked ? 60 / Number($('#globalBpm').value) : 1/PROJECT_SAMPLE_RATE;
      const nextStart=clamp(Math.round(raw/step)*step,0,10800);moveSelection(track,nextStart-track.start);
      refreshMovingClips();
      trackEl(track).querySelector('.track-start').value = track.start.toFixed(3);
      status(`Pista ${tracks.indexOf(track) + 1}: ${precisionTime(track.start)} · Shift: sin ajuste a beat.`);
    }
  };
  const finish = () => { if (!drag) return; const moved = drag.moved, point = drag.point; drag = null; if (moved) markDirty(); if (point && moved) renderAutomation(track); if (moved) timeline(true); else selectTrack(track); };
  clip.onpointerup = finish; clip.onpointercancel = finish;
  clip.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); selectTrack(track); } };
}
function automationChanged(track, rebuild = true) {
  edited(true); syncLiveMix();
  track.automation.sort((a, b) => a.time - b.time);
  if (track.node) scheduleIndividualGain(track, track.node);
  if (rebuild) renderAutomation(track);
  drawAutomation(track);
}
function putPoint(track, time, value) {
  const point = { time: Math.round(time * 1000) / 1000, value: clamp(value, 0, 1) };
  track.automation = track.automation.filter(p => Math.abs(p.time - point.time) > .001);
  track.automation.push(point);
  track.automation.sort((a, b) => a.time - b.time);
  return point;
}
function renderAutomation(track) {
  const container = trackEl(track).querySelector('.automation-points');
  container.replaceChildren(...track.automation.map((point, i) => {
    const row = document.createElement('div'); row.className = 'automation-point';
    const label = document.createElement('span'); label.textContent = `P${i + 1}`;
    const time = document.createElement('input'); time.type = 'number'; time.min = '0'; time.step = '.1'; time.value = point.time; time.setAttribute('aria-label', `Tiempo del punto ${i + 1}`);
    const value = document.createElement('input'); value.type = 'number'; value.min = '0'; value.max = '100'; value.step = '1'; value.value = Math.round(point.value * 100); value.setAttribute('aria-label', `Volumen del punto ${i + 1} en porcentaje`);
    const unit = document.createElement('span'); unit.textContent = '%';
    const remove = document.createElement('button'); remove.innerHTML = uiIcon('close'); remove.setAttribute('aria-label', `Eliminar punto ${i + 1}`);
    time.onchange = () => { const newTime = clamp(time.value, 0, track.buffer?.duration || 10800); const gain = point.value; track.automation.splice(track.automation.indexOf(point), 1); putPoint(track, newTime, gain); automationChanged(track); };
    value.onchange = () => { point.value = clamp(value.value, 0, 100) / 100; automationChanged(track); };
    remove.onclick = () => { track.automation.splice(track.automation.indexOf(point), 1); automationChanged(track); };
    row.append(label, time, value, unit, remove); return row;
  }));
  drawAutomation(track);
}
function drawAutomation(track) {
  const canvas = trackEl(track)?.querySelector('canvas.automation');
  if (!canvas || !trackEl(track).classList.contains('is-selected')) return;
  const rect = canvas.getBoundingClientRect(), scale = devicePixelRatio || 1;
  const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const g = canvas.getContext('2d'), inset = 10 * scale, window = sourceView(track);
  const x = time => inset + (time - window.from) / window.span * (width - 2 * inset), y = gain => height - inset - gain * (height - 2 * inset);
  g.clearRect(0, 0, width, height);
  g.strokeStyle = '#333b48'; g.lineWidth = scale;
  for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo(0, y(i / 2)); g.lineTo(width, y(i / 2)); g.stroke(); }
  g.strokeStyle = track.color; g.lineWidth = 2 * scale; g.beginPath(); g.moveTo(x(window.from), y(automationValue(track, window.from)));
  for(let pixel=1;pixel<=width;pixel+=2){const time=window.from+pixel/width*window.span;g.lineTo(x(time),y(automationValue(track,time)));}
  g.lineTo(x(window.to), y(automationValue(track, window.to))); g.stroke();
  track.automation.filter(point => point.time >= window.from && point.time <= window.to).forEach(point => { g.beginPath(); g.arc(x(point.time), y(point.value), 4 * scale, 0, Math.PI * 2); g.fillStyle = track.color; g.fill(); });
}
function setupAutomationEditor(track) {
  const el = trackEl(track), canvas = el.querySelector('canvas.automation');
  let dragged = null;
  const coords = event => { const rect = canvas.getBoundingClientRect(); return { time: sourceView(track).from + clamp((event.clientX - rect.left - 10) / Math.max(1, rect.width - 20), 0, 1) * sourceView(track).span, value: 1 - clamp((event.clientY - rect.top - 10) / Math.max(1, rect.height - 20), 0, 1) }; };
  const nearest = event => { const point = coords(event), rect = canvas.getBoundingClientRect(), length = sourceView(track).span; return track.automation.find(p => Math.hypot((p.time - point.time) / length * (rect.width - 20), (p.value - point.value) * (rect.height - 20)) < 12); };
  canvas.ondblclick = event => { if (!track.buffer || busy) return; const point = coords(event); putPoint(track, point.time, point.value); automationChanged(track); };
  canvas.onpointerdown = event => { if (event.button || busy) return; dragged = nearest(event); if (dragged) { event.preventDefault(); pauseSession(); canvas.setPointerCapture(event.pointerId); } };
  canvas.onpointermove = event => {
    if (!dragged) return;
    const next = coords(event), i = track.automation.indexOf(dragged);
    const min = i ? track.automation[i - 1].time + .001 : 0;
    const max = i < track.automation.length - 1 ? track.automation[i + 1].time - .001 : track.buffer.duration;
    dragged.time = clamp(next.time, min, max); dragged.value = next.value;
    automationChanged(track, false);
  };
  const finish = () => { if (dragged) { dragged = null; renderAutomation(track); } };
  canvas.onpointerup = finish; canvas.onpointercancel = finish;
  canvas.oncontextmenu = event => { event.preventDefault(); if (busy) return; const point = nearest(event); if (point) { track.automation.splice(track.automation.indexOf(point), 1); automationChanged(track); } };
  el.querySelector('.point-start').onclick = () => { if (track.buffer) { putPoint(track, sourceStart(track), automationValue(track, sourceStart(track))); automationChanged(track); } };
  el.querySelector('.point-end').onclick = () => { if (track.buffer) { putPoint(track, sourceEnd(track), automationValue(track, sourceEnd(track))); automationChanged(track); } };
  el.querySelector('.toggle-points').setAttribute('aria-expanded', 'false');
  el.querySelector('.toggle-points').onclick = event => event.currentTarget.setAttribute('aria-expanded', String(el.classList.toggle('points-open')));
  el.querySelector('.clear-fades').onclick = () => { track.automation = []; automationChanged(track); };
  el.querySelector('.add-fade').onclick = () => {
    if (!track.buffer) return status('Carga audio antes de añadir un fade.');
    const length = track.buffer.duration, from = clamp(el.querySelector('.fade-start').value, 0, Math.max(0, length - .001));
    const to = Math.min(length, from + clamp(el.querySelector('.fade-duration').value, .001, length, 8));
    const incoming = el.querySelector('.fade-kind').value === 'in';
    // Replace only points inside this fade; all other fades remain intact.
    track.automation = track.automation.filter(point => point.time < from || point.time > to);
    putPoint(track, from, incoming ? 0 : 1); putPoint(track, to, incoming ? 1 : 0);
    el.querySelector('.fade-start').value = to.toFixed(2);
    automationChanged(track); status('Fade añadido. Puedes mover sus puntos o añadir más fades en esta pista.');
  };
}
addTrack();

updateProjectFile();
initializeStudio();
