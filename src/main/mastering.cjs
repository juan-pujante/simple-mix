const path = require('node:path');
const PROFILES = {
  balanced: { label: 'Equilibrado', lufs: -14, truePeak: -1, lra: 11, threshold: -12, ratio: 1.5, attack: 20, release: 200 },
  techno: { label: 'Techno', lufs: -12, truePeak: -1, lra: 9, threshold: -14, ratio: 1.8, attack: 25, release: 180 },
  dynamic: { label: 'Dinámico', lufs: -16, truePeak: -1.5, lra: 14, threshold: -10, ratio: 1.3, attack: 30, release: 250 }
};
function masteringOptions(value) {
  if (!value || value.enabled === false) return null;
  if (typeof value !== 'object') throw Error('Configuración de masterización inválida.');
  const profile = value.profile || 'balanced', preset = PROFILES[profile];
  if (!preset) throw Error('Perfil de masterización no compatible.');
  const lufs = Number(value.lufs ?? preset.lufs), truePeak = Number(value.truePeak ?? preset.truePeak);
  if (!Number.isFinite(lufs) || lufs < -24 || lufs > -9 || !Number.isFinite(truePeak) || truePeak < -3 || truePeak > -.5) throw Error('Objetivo LUFS o pico verdadero fuera de rango.');
  return { enabled: true, profile, label: preset.label, lufs, truePeak, lra: preset.lra, compression: value.compression !== false, preset };
}
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
async function measureLoudness({ run, binary, file, options, prefix = '' }) {
  const filter = `${prefix ? prefix + ',' : ''}loudnorm=I=${options.lufs}:TP=${options.truePeak}:LRA=${options.lra}:print_format=json`;
  const log = await run(binary, ['-hide_banner', '-loglevel', 'info', '-nostdin', '-i', file, '-map', '0:a:0', '-af', filter, '-f', 'null', '-']);
  const blocks = log.match(/\{\s*"input_i"[\s\S]*?\}/g);
  if (!blocks?.length) throw Error('No se pudo medir la sonoridad del audio.');
  const raw = JSON.parse(blocks.at(-1));
  return { lufs: finite(raw.input_i), truePeak: finite(raw.input_tp), lra: finite(raw.input_lra), threshold: finite(raw.input_thresh), offset: finite(raw.target_offset) };
}
async function measureEbu({ run, binary, file, prefix = '' }) {
  const log = await run(binary, ['-hide_banner','-loglevel','info','-nostdin','-i',file,'-map','0:a:0','-af',prefix+'ebur128=peak=true:metadata=1,ametadata=print:key=lavfi.r128.I','-f','null','-']);
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const integrated = [...log.matchAll(/lavfi\.r128\.I=([-\d.]+)/g)].at(-1);
  const fallback = summary.match(/I:\s*([-\d.]+) LUFS/), peak = summary.match(/Peak:\s*([-\w.]+) dBFS/), range = summary.match(/LRA:\s*([-\d.]+) LU/);
  const lufs = finite(integrated?.[1] ?? fallback?.[1]);
  return { lufs: lufs !== null && lufs > -69.9 ? lufs : null, truePeak: finite(peak?.[1]), lra: finite(range?.[1]) };
}
async function finalMeasurement(args) {
  const detailed = await measureLoudness(args), ebu = await measureEbu(args);
  const peaks = [detailed.truePeak,ebu.truePeak].filter(value=>value!==null);
  return { ...detailed, lufs: detailed.lufs === null ? null : ebu.lufs, truePeak: peaks.length ? Math.max(...peaks) : null, lra: ebu.lra ?? detailed.lra };
}
async function masterAudio({ input, output, workDir, run, binary, options, codec, sampleRate = 44100 }) {
  const before = await finalMeasurement({ run, binary, file: input, options });
  const headroom = before.truePeak !== null && before.truePeak > -1 ? -1 - before.truePeak : 0;
  const pre = [headroom ? `volume=${headroom}dB` : '', 'highpass=f=25'];
  if (options.compression) {
    const p = options.preset;
    pre.push(`acompressor=threshold=${Math.pow(10,p.threshold/20)}:ratio=${p.ratio}:attack=${p.attack}:release=${p.release}:makeup=1:knee=2.82843:link=maximum:detection=rms`);
  }
  const prefix = pre.filter(Boolean).join(',');
  const prepared = path.join(workDir, 'master-float.wav');
  const notes = [];
  let normalization = 'sin medición LUFS';
  if (before.lufs === null) {
    // Silence and ungated very short/quiet material must never receive infinite gain.
    const attenuation = before.truePeak !== null && before.truePeak > options.truePeak - .15 ? options.truePeak - .15 - before.truePeak : 0;
    await run(binary, ['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-af',`volume=${attenuation}dB`,'-c:a','pcm_f32le','-ar','44100','-ac','2',prepared]);
    notes.push('No hay nivel o duración suficientes para medir LUFS. Se ha conservado el nivel sin amplificar el fondo.');
  } else {
    const measured = await measureLoudness({ run, binary, file: input, options, prefix });
    const usable = measured.lufs !== null && measured.lufs <= 0 && measured.threshold !== null && measured.threshold <= 0 && measured.lra !== null && measured.truePeak !== null && measured.offset !== null && Math.abs(measured.offset) <= 99;
    let loudnorm = `loudnorm=I=${options.lufs}:TP=${options.truePeak-.15}:LRA=${options.lra}`;
    if (usable) loudnorm += `:measured_I=${measured.lufs}:measured_TP=${measured.truePeak}:measured_LRA=${measured.lra}:measured_thresh=${measured.threshold}:offset=${measured.offset}:linear=true`;
    else loudnorm += ':linear=false';
    normalization = usable ? 'dos pasadas' : 'dinámica';
    await run(binary, ['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-af',`${prefix},${loudnorm}`,'-c:a','pcm_f32le','-ar','44100','-ac','2',prepared]);
  }
  let after, adjustment = 0, attempts = 0;
  for (; attempts < 4; attempts++) {
    await run(binary, ['-hide_banner','-loglevel','error','-nostdin','-y','-i',prepared,'-map','0:a:0','-af',`volume=${adjustment}dB`,'-vn',...codec,'-ar',String(sampleRate),'-ac','2',output]);
    // Measure the final encoded file, including MP3 reconstruction overshoots.
    after = await finalMeasurement({ run, binary, file: output, options });
    if (after.truePeak !== null && after.truePeak > options.truePeak + .03) {
      adjustment += options.truePeak - after.truePeak - .15;
      continue;
    }
    if (after.lufs !== null) {
      const desired = options.lufs - after.lufs;
      const headroom = after.truePeak === null ? desired : options.truePeak - after.truePeak - .1;
      const correction = desired < 0 ? desired : Math.min(desired, headroom);
      if (Math.abs(desired) > .2 && Math.abs(correction) > .08 && (desired < 0 || correction > 0) && attempts < 3) {
        adjustment += correction;
        continue;
      }
    }
    break;
  }
  if (after.truePeak !== null && after.truePeak > options.truePeak + .03) throw Error('No se ha podido respetar el techo de pico verdadero. No se ha sustituido el archivo de destino.');
  if (after.lufs !== null && Math.abs(after.lufs - options.lufs) > .7) notes.push('Se ha priorizado el techo de picos y la dinámica; la sonoridad final difiere del objetivo.');
  if (adjustment < -.05) notes.push('Se ha ajustado el nivel después de comprobar los picos del archivo codificado.');
  return { profile: options.profile, label: options.label, targetLufs: options.lufs, targetTruePeak: options.truePeak, before, after, compression: options.compression && before.lufs !== null, normalization, correctionDb: adjustment, silent: before.lufs === null && before.truePeak === null, notes };
}
module.exports = { PROFILES, masteringOptions, measureLoudness, measureEbu, masterAudio };
