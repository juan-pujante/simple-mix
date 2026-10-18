const { BrowserWindow, screen, app } = require('electron');
const path = require('node:path');
function createStudioWindows({ showSplash = true, minimumSplashMs = 850 } = {}) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  let saved={};try{saved=JSON.parse(require('node:fs').readFileSync(path.join(app.getPath('userData'),'preferences.json'),'utf8')).window||{};}catch{}
  const icon = path.join(__dirname, "../../assets/brand/app-icon.png");
  const main = new BrowserWindow({ show: false, width: Math.min(Math.max(960,saved.width||1440),width), height: Math.min(Math.max(700,saved.height||900),height), minWidth: 960, minHeight: 700, backgroundColor: '#141517', icon, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const splash = showSplash ? new BrowserWindow({ show: false, width: 460, height: 254, frame: false, resizable: false, maximizable: false, minimizable: false, backgroundColor: '#222529', icon, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } }) : null;
  for(const window of [main,splash].filter(Boolean)){window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.on('will-attach-webview',event=>event.preventDefault());}
  let resizeTimer;main.on('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!main.isDestroyed()){const [w,h]=main.getSize();require('./studio-native.cjs').savePreferences({window:{width:w,height:h}}).catch(()=>{});}},500);});
  let timer, fallbackTimer, shownAt = null, revealed = false;
  const closeSplash = () => { if (splash && !splash.isDestroyed()) splash.destroy(); };
  main.once('closed', () => { clearTimeout(timer); clearTimeout(fallbackTimer); closeSplash(); });
  const ready = new Promise((resolve, reject) => {
    const reveal = () => { if (revealed) return; revealed = true; clearTimeout(timer); clearTimeout(fallbackTimer); closeSplash(); if (!main.isDestroyed()) { main.show(); main.focus(); } resolve(); };
    const scheduleReveal = () => { timer = setTimeout(reveal, shownAt === null ? 0 : Math.max(0, minimumSplashMs - (Date.now() - shownAt))); };
    main.once('ready-to-show', scheduleReveal);
    main.webContents.once('did-finish-load', () => { fallbackTimer = setTimeout(scheduleReveal, 1000); });
    main.webContents.once('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (!isMainFrame) return; clearTimeout(timer); clearTimeout(fallbackTimer); closeSplash(); if (!main.isDestroyed()) main.show(); reject(new Error(`No se pudo iniciar el editor (${code}): ${description}`)); });
  });
  if (splash) {
    splash.once('ready-to-show', () => { if (!main.isDestroyed() && !main.isVisible()) { shownAt = Date.now(); splash.show(); } else closeSplash(); });
    splash.loadFile(path.join(__dirname, "../renderer/splash.html")).catch(closeSplash);
  }
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon);
  main.loadFile(path.join(__dirname, "../renderer/index.html")).catch(() => {});
  return { main, splash, ready };
}
module.exports = { createStudioWindows };
