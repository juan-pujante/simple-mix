const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {promisify}=require('node:util'),exec=promisify(require('node:child_process').execFile),asar=require('@electron/asar');
const {verifyBinary}=require('./after-pack.cjs');
const root=path.join(__dirname,'..'),version=require('../package.json').version,out=path.join(root,'dist',version),zip=process.argv[2];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
(async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'simplemix-release-check-')),checks=[],binaries=[];
 try{
  if(!zip)throw Error('Pass a 7-Zip executable path');
  const installer=path.join(out,`Simple-Mix-${version}-Windows-x64-Setup.exe`);
  await exec(zip,['x',installer,'-o'+tmp,'$PLUGINSDIR/app-64.7z','-y']);const payload=path.join(tmp,'$PLUGINSDIR/app-64.7z');
  await exec(zip,['t',payload]);checks.push('Windows installer payload passes full 7-Zip integrity test');
  const extracted=path.join(tmp,'windows');await exec(zip,['x',payload,'-o'+extracted,'resources/app.asar','resources/ffmpeg/*','resources/ffmpeg-build.json','Simple Mix.exe','-y']);
  const variants=[['darwin','arm64',path.join(out,'mac-arm64','Simple Mix.app','Contents','Resources')],['darwin','x64',path.join(out,'mac','Simple Mix.app','Contents','Resources')],['win32','x64',path.join(extracted,'resources')]];
  for(const [platform,arch,resources] of variants){
   const archive=path.join(resources,'app.asar'),manifest=JSON.parse(asar.extractFile(archive,'package.json'));assert.equal(manifest.version,version);
   for(const file of ["src/renderer/app.js","src/shared/gain.js","src/renderer/studio.js","src/main/native-files.cjs","src/main/studio-native.cjs","src/main/mastering.cjs","src/main/preload.cjs","src/renderer/index.html","src/renderer/style.css","src/renderer/splash.html","src/renderer/splash.css","src/renderer/splash.js","src/shared/version.js","src/shared/locales/en.json"])assert.equal(hash(asar.extractFile(archive,file)),hash(await fs.readFile(path.join(root,file))),file+' packaged mismatch');
   const binary=path.join(resources,'ffmpeg','ffmpeg'+(platform==='win32'?'.exe':'')),bytes=await fs.readFile(binary);verifyBinary(bytes,platform,arch);
   const info=JSON.parse(await fs.readFile(path.join(resources,'ffmpeg-build.json'),'utf8'));assert.equal(info.sha256,hash(bytes));assert.equal(info.arch,arch);assert.equal(info.platform,platform);
   await fs.access(binary+'.LICENSE');await fs.access(binary+'.README');binaries.push(info);checks.push(platform+' '+arch+': version, packaged source hashes, FFmpeg architecture/hash and notices');
  }
  const bundled=await fs.readFile(path.join(out,'win-unpacked','Simple Mix.exe')),installed=await fs.readFile(path.join(extracted,'Simple Mix.exe'));assert.equal(hash(bundled),hash(installed));verifyBinary(installed,'win32','x64');checks.push('Windows installer contains the generated x64 application executable');
  for(const arch of ['arm64','x64']){await exec('hdiutil',['verify',path.join(out,`Simple-Mix-${version}-macOS-${arch}.dmg`)]);checks.push('macOS '+arch+' DMG integrity verified');}
  const report={version,checks,binaries,limits:['Windows and Intel Mac installers have not been run on their native systems.','Unsigned installers; macOS notarization not performed.']};
  await fs.writeFile(path.join(out,'VERIFICATION.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
