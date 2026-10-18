const { app, ipcMain, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createStudioWindows } = require('../src/main/desktop-window.cjs');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'simplemix-boot-'));app.setPath('userData',profile);
  require('../src/main/native-files.cjs').registerNativeFiles({ipcMain,BrowserWindow,dialog,rendererUrl:require('node:url').pathToFileURL(path.join(__dirname, "../src/renderer/index.html")).href});
  let phase = 'splash assets';
  const timeout = setTimeout(() => { console.error(`Boot smoke test timeout during ${phase}`); app.exit(1); }, 90000);
  try {
    // Validate splash assets independently: a fast editor can close the real
    // splash before its did-finish-load event, leaving a load listener pending.
    const preview = new BrowserWindow({ show: false, width: 460, height: 254, frame: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await preview.loadFile(path.join(__dirname, '../src/renderer/splash.html'));
    const splashState = await preview.webContents.executeJavaScript(`({version:document.querySelector('#version').textContent,logo:document.images[0].complete && document.images[0].naturalWidth>0,scroll:document.documentElement.scrollHeight>innerHeight})`);
    assert.equal(splashState.version, 'v' + require('../package.json').version); assert(splashState.logo); assert(!splashState.scroll);
    preview.destroy();
    phase = 'editor handoff';
    const first = createStudioWindows({ minimumSplashMs: 1100 });
    assert.equal(first.main.isVisible(), false);
    await first.ready; assert(first.main.isVisible()); assert(first.splash.isDestroyed());
    assert.equal(await first.main.webContents.executeJavaScript('document.images[0].naturalWidth > 0'), true);
    first.main.destroy();
    phase = 'reopen';
    const reopened = createStudioWindows({ showSplash: false }); await reopened.ready; assert.equal(reopened.splash, null); assert(reopened.main.isVisible()); reopened.main.destroy();
    const early = createStudioWindows(); early.main.destroy(); assert(early.splash.isDestroyed());
    console.log('Boot checks passed: hidden editor, splash assets/version/layout, automatic handoff, reopen without splash, early-close cleanup.');
    clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
