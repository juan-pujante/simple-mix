// Deterministic audio fixture for visual review; never loaded by the production app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
    await win.loadFile(path.join(__dirname, "../src/renderer/index.html"));
    await win.webContents.executeJavaScript(`(async () => {
      const names=['Warehouse signals','Phase / 002','Concrete rhythm','Low frequency','After hours'];
      for(let k=0;k<5;k++){
        const buffer = audio().createBuffer(1,44100*34,44100), data=buffer.getChannelData(0);
        for(let i=0;i<data.length;i++){
          const t=i/44100, beat=t%(60/140), half=t%(30/140), phrase=.45+.55*Math.sin(t*.39+k)**2;
          const kick=.62*Math.sin(2*Math.PI*(46*beat+2*(1-Math.exp(-beat*35))))*Math.exp(-beat*19);
          const bass=.13*Math.sin(2*Math.PI*(65+k*7)*t)*(1-Math.exp(-beat*30));
          const hat=.11*Math.sin(i*1.37)*Math.exp(-half*60);
          const breakGain = t>13+k*.5 && t<17+k*.5 ? .17 : 1;
          data[i]=(kick+bass+hat)*phrase*breakGain;
        }
        const track=tracks[k]||addTrack();
        await load(track,new File([wav(buffer).blob],names[k]+'.wav',{type:'audio/wav'}));
        track.start=k*24;track.bpm=140;track.followGlobal=true;track.targetBpm=140;track.bpmMode='manual';
        if(k>0)track.automation=[{time:0,value:0},{time:8,value:1},{time:27,value:1},{time:34,value:0}];
        trackEl(track).querySelector('.track-start').value=track.start;
        update(track);renderAutomation(track);
      }
      document.querySelector('#projectName').value='Warehouse / Session 01';
      selectTrack(tracks[1]);view.zoom=1;view.start=0;session.offset=31;timeline();
      status('5 pistas · Selecciona una pista para editar el tempo, la posición o los puntos de volumen.');
    })()`);
    for(const [width,height] of [[1440,900],[960,700]]){
      win.setSize(width,height); await new Promise(resolve=>setTimeout(resolve,180));
      await win.webContents.executeJavaScript('timeline()');
      const layout=await win.webContents.executeJavaScript(`(() => {const lane=document.querySelector('.timeline-row').getBoundingClientRect(), ruler=document.querySelector('#ruler').getBoundingClientRect(), placement=document.querySelector('.is-selected .placement').getBoundingClientRect(),eq=document.querySelector('.is-selected .eq').getBoundingClientRect();return {aligned:Math.abs(lane.left-ruler.left)<2,placementFits:placement.bottom<=eq.top+1,scroll:document.documentElement.scrollHeight>innerHeight}})()`);
      if(!layout.aligned||!layout.placementFits||layout.scroll)throw new Error(JSON.stringify(layout));
      fs.writeFileSync(path.join(__dirname, '../artifacts/studio-preview-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`document.querySelector('[data-mute-track-id="' + tracks[2].id + '"]').click()`);
    const muteLayout = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.rail-mute')).every(button => { const b=button.getBoundingClientRect(),h=button.parentElement.getBoundingClientRect();return b.width>=24&&b.left>=h.left&&b.right<=h.right&&b.top>=h.top&&b.bottom<=h.bottom; })`);
    if(!muteLayout)throw Error('Mute controls do not fit inside their track headers');
    fs.writeFileSync(path.join(__dirname, '../artifacts/track-mute-960.png'), (await win.webContents.capturePage()).toPNG());
    console.log('Visual fixtures captured at 1440×900 and 960×700; track rail, ruler, controls and no-scroll layout verified.');app.exit(0);
  }catch(error){console.error(error);app.exit(1);}
});
