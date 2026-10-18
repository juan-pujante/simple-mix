const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerNativeFiles } = require('./native-files.cjs');
const { createStudioWindows } = require('./desktop-window.cjs');
async function applicationMenu() {
  const {preferences}=require('./studio-native.cjs'),prefs=await preferences(),en=prefs.language==='en';
  const send=action=>()=>BrowserWindow.getFocusedWindow()?.webContents.send('studio:action',action);
  const item=(es,english,action,accelerator)=>({label:en?english:es,click:send(action),accelerator});
  const template=[...(process.platform==='darwin'?[{role:'appMenu'}]:[]),{label:en?'File':'Archivo',submenu:[item('Nuevo','New','new','CmdOrCtrl+N'),item('Abrir…','Open…','open','CmdOrCtrl+O'),item('Guardar','Save','save','CmdOrCtrl+S'),item('Guardar como…','Save as…','saveAs','CmdOrCtrl+Shift+S'),{type:'separator'},item('Exportar mezcla…','Export mix…','export'),item('Preferencias…','Preferences…','preferences','CmdOrCtrl+,'),{type:'separator'},{role:'close'}]},{label:en?'Edit':'Editar',submenu:[item('Deshacer','Undo','undo','CmdOrCtrl+Z'),item('Rehacer','Redo','redo','CmdOrCtrl+Shift+Z'),{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{role:'windowMenu'}];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function openStudio(showSplash) {
  const { ready } = createStudioWindows({ showSplash });
  ready.catch(error => dialog.showErrorBox('Simple Mix', error.message));
}
app.whenReady().then(() => {
  registerNativeFiles({ ipcMain, dialog, BrowserWindow, rendererUrl: pathToFileURL(path.join(__dirname, "../renderer/index.html")).href });
  applicationMenu();app.on('studio-language',applicationMenu);
  openStudio(true);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) openStudio(false); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
