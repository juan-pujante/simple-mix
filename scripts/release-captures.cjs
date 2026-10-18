// Captures real Electron screens with an isolated profile and generated demo audio.
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 const root=path.join(__dirname,'..'),version=require('../package.json').version,out=path.join(root,'dist',version),profile=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-release-'));
 app.setPath('userData',profile);let studio;const errors=[];const timer=setTimeout(()=>app.exit(1),120000);
 try{
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(profile,'preferences.json'),JSON.stringify({language:'es'}));
  require('../src/main/native-files.cjs').registerNativeFiles({ipcMain,BrowserWindow,dialog,rendererUrl:pathToFileURL(path.join(root,"src/renderer/index.html")).href});
  const splash=new BrowserWindow({show:false,width:460,height:254,frame:false,backgroundColor:'#222529',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await splash.loadFile(path.join(root, "src/renderer/splash.html"));
  await splash.webContents.executeJavaScript('(async()=>{await I18n.ready;I18n.setLocale("es");await document.fonts.ready;return true;})()');
  assert.equal(await splash.webContents.executeJavaScript('document.querySelector("#version").textContent'),'v'+version);
  await new Promise(r=>setTimeout(r,180));
  await fs.writeFile(path.join(out,'Simple-Mix-'+version+'-Splash.png'),(await splash.webContents.capturePage()).toPNG());
  splash.destroy();console.log('Splash captured');
  studio=require('../src/main/desktop-window.cjs').createStudioWindows({showSplash:false});
  await studio.ready;const win=studio.main;win.setContentSize(1440,900);
  win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
  await win.webContents.executeJavaScript(`(async()=>{
    await I18n.ready;I18n.setLocale('es');await document.fonts.ready;
    const names=['Warehouse Signals','Concrete Rhythm','Low Frequency','Phase Shift','After Hours'];
    for(let k=0;k<5;k++){
      const buffer=audio().createBuffer(1,44100*34,44100),data=buffer.getChannelData(0);
      for(let i=0;i<data.length;i++){
        const t=i/44100,beat=t%(60/140),half=t%(30/140),phrase=.45+.55*Math.sin(t*.39+k)**2;
        const kick=.62*Math.sin(2*Math.PI*(46*beat+2*(1-Math.exp(-beat*35))))*Math.exp(-beat*19);
        const bass=.13*Math.sin(2*Math.PI*(65+k*7)*t)*(1-Math.exp(-beat*30));
        const hat=.11*Math.sin(i*1.37)*Math.exp(-half*60);
        data[i]=(kick+bass+hat)*phrase*(t>13+k*.5&&t<17+k*.5?.17:1);
      }
      const track=tracks[k]||addTrack();await load(track,new File([floatWav(buffer).blob],names[k]+'.wav',{type:'audio/wav'}));
      Object.assign(track,{start:k*24,bpm:140,sourceBpm:null,targetBpm:140,followGlobal:true,bpmMode:'manual'});
      if(k>0)track.automation=[{time:0,value:0},{time:8,value:1},{time:27,value:1},{time:34,value:0}];
      trackEl(track).querySelector('.track-start').value=track.start;update(track);renderAutomation(track);
    }
    $('#projectName').value='Sesión demo';selectTrack(tracks[1]);view.zoom=1;view.start=0;session.offset=31;timeline();
    status('Sesión demo · 5 pistas');I18n.setLocale('es');I18n.render();
  })()`);
  await new Promise(r=>setTimeout(r,300));
  assert(await win.webContents.executeJavaScript('document.documentElement.scrollHeight<=innerHeight&&tracks.filter(t=>t.buffer).length===5'));
  await fs.writeFile(path.join(out,'Simple-Mix-'+version+'-Interfaz.png'),(await win.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);console.log(JSON.stringify({version,out,captures:['Splash','Interfaz'],demo:'Generated synthetic audio; no user project modified'},null,2));
 }catch(e){console.error(e);process.exitCode=1;}
 finally{clearTimeout(timer);studio?.main.destroy();await new Promise(r=>setTimeout(r,600));await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.exit(process.exitCode||0);}
});
