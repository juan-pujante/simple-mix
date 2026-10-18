const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.whenReady().then(async()=>{
  const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'simplemix-ui-'));app.setPath('userData',profile);
  const win=new BrowserWindow({show:false,width:1440,height:900});
  const run=code=>win.webContents.executeJavaScript(code);
  const capture=async name=>{await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(__dirname,'../artifacts/'+name+'.png'),(await win.webContents.capturePage()).toPNG());};
  try{
    await win.loadFile(path.join(__dirname,"../src/renderer/index.html"));
    await run('I18n.ready.then(async()=>{I18n.setLocale("es");await newProject();})');
    assert.equal(await run('document.querySelector("#projectName").value'),'Mi sesión');
    for(const [w,h] of [[1440,900],[960,700]]){
      win.setContentSize(w,h);await new Promise(resolve=>setTimeout(resolve,100));
      const empty=await run(`(()=>{const e=document.querySelector('.timeline-empty'),b=e.querySelector('button').getBoundingClientRect(),t=document.querySelector('#timeline').getBoundingClientRect();return {inside:b.top>=t.top&&b.bottom<=t.bottom,scroll:document.documentElement.scrollHeight>innerHeight}})()`);
      assert(empty.inside&&!empty.scroll);await capture('ui-empty-'+w);
    }
    await run(`document.querySelector('#ruler').focus();session.offset=0;`);
    const placement=await run('tracks[0].start');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await new Promise(resolve=>setTimeout(resolve,50));
    const seek=await run('({position:session.offset,start:tracks[0].start})');assert(seek.position>0);assert.equal(seek.start,placement);
    await run(`document.querySelector('#export').click();document.querySelector('#exportFormat').value='mp3';document.querySelector('#exportFormat').dispatchEvent(new Event('change'));document.querySelector('#normalize').value='master';document.querySelector('#normalize').dispatchEvent(new Event('change'));`);
    const dialog=await run(`(()=>{const d=document.querySelector('#exportDialog'),b=d.getBoundingClientRect(),button=document.querySelector('#confirmExport').getBoundingClientRect();return {open:d.open&&b.height>100,fits:b.top>=0&&b.bottom<=innerHeight,allVisible:d.scrollHeight<=d.clientHeight+1&&button.bottom<=b.bottom,mastering:!document.querySelector('#masteringOptions').hidden,label:d.getAttribute('aria-labelledby')}})()`);
    assert(dialog.open&&dialog.fits&&dialog.allVisible&&dialog.mastering&&dialog.label);await capture('ui-export');
    await run(`document.querySelector('#cancelExport').click();`);
    const missing=await run(`Array.from(document.querySelectorAll('button')).filter(e=>e.getClientRects().length&&!e.textContent.trim()&&!e.getAttribute('aria-label')).map(e=>e.outerHTML)`);
    assert.deepEqual(missing,[]);
    win.show();win.focus();win.webContents.focus();
    await new Promise(resolve=>setTimeout(resolve,100));
    await run(`document.querySelector('#stopSession').focus();`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await new Promise(resolve=>setTimeout(resolve,50));
    const focus=await run(`({id:document.activeElement.id,outline:getComputedStyle(document.activeElement).outlineStyle,visible:document.activeElement.matches(':focus-visible'),windowFocus:document.hasFocus()})`);
    assert.equal(focus.id,'playSession');assert.equal(focus.outline,'solid',JSON.stringify(focus));
    console.log('UI review passed: neutral session name; empty state at both sizes; keyboard ruler seeks without moving clips; complete export/mastering dialog without scroll; icon labels and visible keyboard focus.');win.destroy();fs.rmSync(profile,{recursive:true,force:true,maxRetries:5});app.exit(0);
  }catch(e){console.error(e);win.destroy();fs.rmSync(profile,{recursive:true,force:true,maxRetries:5});app.exit(1);}
});
