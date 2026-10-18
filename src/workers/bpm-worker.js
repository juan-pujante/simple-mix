 'use strict';
// Onset-envelope autocorrelation, with a techno-oriented tempo prior.
// Reference: https://librosa.org/doc/latest/auto_tutorials/01-intro/06-rhythm.html
function estimateTempo(samples, sampleRate) {
  if (samples.length < sampleRate * 6) return null;
  const hop = 80, frame = 160, fps = sampleRate / hop;
  const count = Math.floor((samples.length - frame) / hop);
  const onset = new Float32Array(count);
  let previous = 0, energySum = 0,averageEnergy=0,maxOnset=0;
  for (let i = 0; i < count; i++) {
    let energy = 0;
    for (let j = i * hop; j < i * hop + frame; j++) energy += samples[j] * samples[j];
    energy = Math.sqrt(energy / frame);
    onset[i] = Math.max(0, energy - previous);
    averageEnergy+=energy;if(i>3)maxOnset=Math.max(maxOnset,onset[i]);
    previous = energy;
    energySum += onset[i] * onset[i];
  }
  if (energySum / count < 1e-9 || maxOnset<averageEnergy/count*.12) return null;
  const minLag = Math.floor(fps * 60 / 200), maxLag = Math.ceil(fps * 60 / 65);
  const correlations = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let dot = 0, a = 0, b = 0;
    for (let i = lag; i < count; i++) { dot += onset[i] * onset[i - lag]; a += onset[i] ** 2; b += onset[i - lag] ** 2; }
    correlations[lag] = dot / Math.max(1e-12, Math.sqrt(a * b));
  }
  let best = 0, bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (correlations[lag] < correlations[lag - 1] || correlations[lag] < correlations[lag + 1]) continue;
    const bpm = 60 * fps / lag;
    const prior = .65 + .35 * Math.exp(-.5 * (Math.log(bpm / 140) / .3) ** 2);
    const score = correlations[lag] * prior;
    if (score > bestScore) { best = lag; bestScore = score; }
  }
  if (!best || correlations[best] < .08) return null;
  const left = correlations[best - 1], center = correlations[best], right = correlations[best + 1];
  const divisor = left - 2 * center + right;
  const correction = Math.abs(divisor) > 1e-10 ? Math.max(-.5, Math.min(.5, .5 * (left - right) / divisor)) : 0;
  // Refine over many beats: a 10 ms error over one beat can misread the
  // source by tenths of a BPM. Long lags reduce that quantization bias.
  const coarse=60*fps/(best+correction),candidates=[];
  for(const beats of [8,16,32]){
    const expected=60*fps/coarse*beats;if(expected>count/3)continue;
    const radius=Math.max(3,Math.ceil(expected*.012)),values=[];
    for(let lag=Math.round(expected)-radius;lag<=Math.round(expected)+radius;lag++){
      let dot=0,a=0,b=0;for(let i=lag;i<count;i++){dot+=onset[i]*onset[i-lag];a+=onset[i]**2;b+=onset[i-lag]**2;}
      values.push({lag,score:dot/Math.max(1e-12,Math.sqrt(a*b))});
    }
    const winner=values.reduce((a,b)=>a.score>b.score?a:b),index=values.indexOf(winner);
    if(!index||index===values.length-1||winner.score<center*.6)continue;
    const l=values[index-1].score,r=values[index+1].score,d=l-2*winner.score+r,shift=d?Math.max(-.5,Math.min(.5,.5*(l-r)/d)):0;
    candidates.push(60*fps*beats/(winner.lag+shift));
  }
  candidates.sort((a,b)=>a-b);const precise=candidates.length?candidates[Math.floor(candidates.length/2)]:coarse;
  const grid=locateBeatGrid(samples,sampleRate,precise);
  const sourceBpm=grid?.sourceBpm||precise;
  return {bpm:Math.round(sourceBpm),sourceBpm,confidence:center,phase:grid?.phase||0,beatConfidence:grid?.confidence||0};
}
function locateBeatGrid(samples,sampleRate,bpm){
  // Millisecond attack times, with bass evidence to downweight offbeat hats.
  // Keep channels separate upstream; never cancel antiphase stereo drums.
  const hop=Math.max(1,Math.round(sampleRate/1000)),frame=hop*4,count=Math.floor((samples.length-frame)/hop),energy=new Float64Array(count),bass=new Float64Array(count),low=new Float32Array(samples.length);
  const alpha=1-Math.exp(-2*Math.PI*180/sampleRate);let l1=0,l2=0;
  for(let i=0;i<samples.length;i++){l1+=alpha*(samples[i]-l1);l2+=alpha*(l1-l2);low[i]=l2;}
  for(let i=0;i<count;i++){let sum=0,lo=0;for(let j=i*hop;j<i*hop+frame;j++){sum+=samples[j]**2;lo+=low[j]**2;}energy[i]=Math.sqrt(sum/frame);bass[i]=Math.sqrt(lo/frame);}
  const flux=new Float64Array(count);let square=0;
  for(let i=3;i<count;i++){flux[i]=Math.max(0,energy[i]-energy[i-3]);square+=flux[i]**2;}
  const threshold=Math.sqrt(square/count)*.7,attacks=[];
  for(let i=30;i<count-30;i++){
    if(flux[i]<threshold||flux[i]<flux[i-1]||flux[i]<=flux[i+1])continue;
    let full=0,lowSum=0;for(let j=i;j<i+25;j++){full+=energy[j];lowSum+=bass[j];}
    const weight=Math.min(flux[i],threshold*4)*(.2+.8*Math.min(1,lowSum/Math.max(full,1e-10)*3));
    // Backtrack to the beginning of the local energy rise, not its peak.
    let base=i;for(let j=i-1;j>=i-20;j--){if(energy[j]<energy[base])base=j;}
    const level=energy[base]+(energy[i]-energy[base])*.15;let at=i;while(at>base&&energy[at-1]>level)at--;
    const time=(at*hop+frame/2)/sampleRate;
    const previous=attacks.at(-1);if(previous&&time-previous.time<.03){if(weight>previous.weight)attacks[attacks.length-1]={time,weight};}else attacks.push({time,weight});
  }
  if(attacks.length<8)return null;
  let period=60/bpm;const bins=2048,scores=new Float64Array(bins);
  for(const attack of attacks){const at=Math.round((attack.time%period)/period*bins)%bins;for(let k=-16;k<=16;k++)scores[(at+k+bins)%bins]+=attack.weight*Math.exp(-k*k/64);}
  let best=0;for(let i=1;i<bins;i++)if(scores[i]>scores[best])best=i;
  let origin=best/bins*period,points=[];
  for(let pass=0;pass<3;pass++){
    const byBeat=new Map();
    for(const attack of attacks){const beat=Math.round((attack.time-origin)/period);if(Math.abs(attack.time-origin-beat*period)>.018)continue;const previous=byBeat.get(beat);if(!previous||attack.weight>previous.weight)byBeat.set(beat,{...attack,beat});}
    points=[...byBeat.values()];if(points.length<8)break;
    let weight=0,x=0,y=0;for(const p of points){weight+=p.weight;x+=p.beat*p.weight;y+=p.time*p.weight;}x/=weight;y/=weight;
    let dot=0,variance=0;for(const p of points){dot+=p.weight*(p.beat-x)*(p.time-y);variance+=p.weight*(p.beat-x)**2;}
    const slope=dot/variance;if(!Number.isFinite(slope)||Math.abs(slope-60/bpm)>.003*60/bpm)break;
    period=slope;origin=y-period*x;
  }
  return {sourceBpm:60/period,phase:((origin%period)+period)%period,confidence:Math.min(1,points.length/(samples.length/sampleRate/period))};

}
self.onmessage = event => {
  try { self.postMessage({ result: estimateTempo(event.data.samples, event.data.sampleRate) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
