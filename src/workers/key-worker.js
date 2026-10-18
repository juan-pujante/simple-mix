// Local chroma/key estimation. Krumhansl–Kessler profiles:
// https://extras.humdrum.org/man/keycor/ . This is an estimator, not Mixed In Key's algorithm.
'use strict';
const profiles=[[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]];
function fft(real,imag){const n=real.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[real[i],real[j]]=[real[j],real[i]];}}
 for(let size=2;size<=n;size<<=1){const angle=-2*Math.PI/size,wr=Math.cos(angle),wi=Math.sin(angle);for(let base=0;base<n;base+=size){let r=1,im=0;for(let j=0;j<size/2;j++){const a=base+j,b=a+size/2,tr=r*real[b]-im*imag[b],ti=r*imag[b]+im*real[b];real[b]=real[a]-tr;imag[b]=imag[a]-ti;real[a]+=tr;imag[a]+=ti;const next=r*wr-im*wi;im=r*wi+im*wr;r=next;}}}}
function analyzeKey(samples,sampleRate,segmentLength=samples.length){
 const n=8192,chroma=new Float64Array(12),real=new Float64Array(n),imag=new Float64Array(n),power=new Float64Array(n/2);let frames=0,total=0;
 for(let segment=0;segment<samples.length;segment+=segmentLength)for(let offset=segment;offset+n<=Math.min(samples.length,segment+segmentLength);offset+=n/2){
  let energy=0;for(let i=0;i<n;i++){real[i]=samples[offset+i]*(.5-.5*Math.cos(2*Math.PI*i/(n-1)));imag[i]=0;energy+=real[i]*real[i];}if(energy/n<1e-7)continue;
  fft(real,imag);let max=0;for(let k=1;k<n/2;k++){power[k]=real[k]*real[k]+imag[k]*imag[k];max=Math.max(max,power[k]);}
  const local=new Float64Array(12);
  for(let k=Math.ceil(55*n/sampleRate);k<Math.min(n/2-1,Math.floor(2600*n/sampleRate));k++){
   if(power[k]<max*.002||power[k]<power[k-1]||power[k]<power[k+1])continue;
   const a=Math.log(power[k-1]+1e-20),b=Math.log(power[k]+1e-20),c=Math.log(power[k+1]+1e-20),den=a-2*b+c,delta=den?Math.max(-.5,Math.min(.5,.5*(a-c)/den)):0;
   const midi=69+12*Math.log2((k+delta)*sampleRate/n/440),note=Math.round(midi),distance=Math.abs(midi-note);if(distance>.4)continue;
   local[(note%12+12)%12]+=Math.sqrt(power[k])*Math.exp(-distance*distance/.06);
  }
  const sum=local.reduce((a,b)=>a+b,0);if(sum){for(let i=0;i<12;i++)chroma[i]+=local[i]/sum;frames++;total+=energy;}
 }
 if(frames<3||!total)return null;const average=chroma.reduce((a,b)=>a+b,0)/12,variance=chroma.reduce((sum,x)=>sum+(x-average)**2,0);// Reject flat chroma (noise/percussion) and isolated notes without enough modal evidence.
 const peak=Math.max(...chroma),notes=chroma.filter(x=>x>=peak*.15).length;
 if(variance<1e-8||Math.sqrt(variance/12)/average<.12||notes<3)return null;
 const scores=[];for(let mode=0;mode<2;mode++)for(let root=0;root<12;root++){
  const profile=profiles[mode],mean=profile.reduce((a,b)=>a+b,0)/12;let dot=0,pvariance=0;for(let i=0;i<12;i++){const value=profile[(i-root+12)%12]-mean;dot+=(chroma[i]-average)*value;pvariance+=value*value;}
  scores.push({root,mode:mode?'minor':'major',correlation:dot/Math.sqrt(variance*pvariance)});
 }
 scores.sort((a,b)=>b.correlation-a.correlation);const best=scores[0],gap=best.correlation-scores[1].correlation;
 if(best.correlation<.55||gap<.035)return null;
 return {...best,confidence:Math.min(1,Math.max(0,(best.correlation-.4)*.9+gap*2)),chroma:Array.from(chroma)};
}
self.onmessage=event=>{try{self.postMessage({result:analyzeKey(event.data.samples,event.data.sampleRate,event.data.segmentLength)});}catch(error){self.postMessage({error:error.message});}};
