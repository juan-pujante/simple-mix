// Version 4 projects: atomic manifests, immutable content-addressed audio, relative paths.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
async function atomic(file, data) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  try { await fs.writeFile(temp, data, {flag:'wx',mode:0o600}); await fs.rename(temp,file); }
  finally { await fs.rm(temp,{force:true}); }
}
async function bundleDestination(selected) {
  const base = path.basename(selected, path.extname(selected));
  for (let n=0;n<10000;n++) {
    const folder=path.join(path.dirname(selected),base+(n?' ('+(n+1)+')':''));
    try { await fs.mkdir(folder); return path.join(folder,base+'.simplemix'); }
    catch(error) { if(error.code!=='EEXIST')throw error; }
  }
  throw Error('No se pudo crear una carpeta de proyecto.');
}
async function writeProject(file, content, portable=false) {
  const doc=JSON.parse(content);
  if(doc.version!==4 || portable) { await atomic(file,content); return; }
  if(!Array.isArray(doc.tracks))throw Error('Configuración de pista inválida');
  const dir=path.join(path.dirname(file),'Audio');
  await fs.mkdir(dir,{recursive:true});
  const root=await fs.realpath(path.dirname(file)),realDir=await fs.realpath(dir);
  if(!realDir.startsWith(root+path.sep))throw Error('Ruta de audio no válida.');
  for(const track of doc.tracks) {
    if(!track.audio) { if(track.asset)throw Error('Falta el audio del proyecto.'); continue; }
    const bytes=Buffer.from(track.audio,'base64'), hash=createHash('sha256').update(bytes).digest('hex');
    const asset=path.join(dir,hash+'.audio');
    try { await fs.writeFile(asset,bytes,{flag:'wx',mode:0o600}); }
    catch(error) { if(error.code!=='EEXIST')throw error; const existing=await fs.readFile(asset); if(createHash('sha256').update(existing).digest('hex')!==hash)await atomic(asset,bytes); }
    track.asset=path.basename(dir)+'/'+hash+'.audio'; delete track.audio;
  }
  doc.storage='managed';
  // Audio is durable before the manifest is replaced. Previous assets remain for recovery.
  await atomic(file,JSON.stringify(doc));
}
async function readProject(file) {
  const content=await fs.readFile(file,'utf8'), doc=JSON.parse(content);
  if(doc.version!==4 || doc.storage!=='managed')return content;
  if(!Array.isArray(doc.tracks))throw Error('Configuración de pista inválida');
  const root=await fs.realpath(path.dirname(file));
  for(const track of doc.tracks) {
    if(!track.asset)continue;
    const rel=track.asset;
    if(typeof rel!=='string' || !/^(?:Audio|[^/\\]+\.audio)\/[a-f0-9]{64}\.audio$/.test(rel) || rel.includes('..'))throw Error('Ruta de audio no válida.');
    const target=await fs.realpath(path.join(root,rel)).catch(()=>{throw Error('Falta un archivo de audio del proyecto: '+rel);});
    if(!target.startsWith(root+path.sep))throw Error('Ruta de audio no válida.');
    const bytes=await fs.readFile(target), hash=createHash('sha256').update(bytes).digest('hex');
    if(path.basename(target)!==hash+'.audio')throw Error('El audio del proyecto está dañado: '+rel);
    track.audio=bytes.toString('base64'); delete track.asset;
  }
  delete doc.storage;
  return JSON.stringify(doc);
}
module.exports={atomic,bundleDestination,writeProject,readProject};
