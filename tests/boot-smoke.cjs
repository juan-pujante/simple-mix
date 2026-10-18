const { app, ipcMain, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createStudioWindows } = require('../src/main/desktop-window.cjs');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'simplemix-boot-'));app.setPath('userData',profile);
  require('../src/main/native-files.cjs').registerNativeFiles({ipcMain,BrowserWindow,dialog,rendererUrl:require('node:url').pathToFileURL(path.join(__dirname, "../src/renderer/index.html")).href});
  const timeout = setTimeout(() => app.exit(1), 20000);
  try {
    const first = createStudioWindows({ minimumSplashMs: 1100 });
    assert.equal(first.main.isVisible(), false);
    await new Promise(resolve => first.splash.webContents.once('did-finish-load', resolve));
    await first.splash.webContents.executeJavaScript('document.fonts.ready');
    const splashState = await first.splash.webContents.executeJavaScript(`({version:document.querySelector('#version').textContent,logo:document.images[0].complete && document.images[0].naturalWidth>0,scroll:document.documentElement.scrollHeight>innerHeight})`);
    assert.equal(splashState.version, 'v' + require('../package.json').version); assert(splashState.logo); assert(!splashState.scroll);
    fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../artifacts/splash.png'), (await first.splash.webContents.capturePage()).toPNG());
    await first.ready; assert(first.main.isVisible()); assert(first.splash.isDestroyed());
    assert.equal(await first.main.webContents.executeJavaScript('document.images[0].naturalWidth > 0'), true);
    first.main.destroy();
    const reopened = createStudioWindows({ showSplash: false }); await reopened.ready; assert.equal(reopened.splash, null); assert(reopened.main.isVisible()); reopened.main.destroy();
    const early = createStudioWindows(); early.main.destroy(); assert(early.splash.isDestroyed());
    console.log('Boot checks passed: hidden editor, splash assets/version/layout, automatic handoff, reopen without splash, early-close cleanup.');
    clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
