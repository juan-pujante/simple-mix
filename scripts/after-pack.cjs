// Install the FFmpeg executable for the target, without modifying host dependencies.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {createWriteStream}=require('node:fs'),{Readable}=require('node:stream'),{pipeline}=require('node:stream/promises'),{createGunzip}=require('node:zlib');
const root=path.join(__dirname,'..'),pkg=require('ffmpeg-static/package.json');
const release=pkg['ffmpeg-static']['binary-release-tag'];
function verifyBinary(bytes,platform,arch){
  if(platform==='darwin'){
    const expected=arch==='arm64'?0x100000c:arch==='x64'?0x1000007:0;
    if(bytes.readUInt32LE(0)!==0xfeedfacf||bytes.readUInt32LE(4)!==expected)throw Error('Incorrect macOS FFmpeg architecture: '+arch);
  }else if(platform==='win32'){
    const offset=bytes.readUInt32LE(0x3c);
    if(bytes.toString('ascii',0,2)!=='MZ'||bytes.toString('ascii',offset,offset+4)!=='PE\0\0'||bytes.readUInt16LE(offset+4)!==0x8664||arch!=='x64')throw Error('Incorrect Windows FFmpeg architecture');
  }else if(platform==='linux'){
    const expected={x64:62,arm64:183,ia32:3,armv7l:40}[arch];
    if(bytes.toString('ascii',1,4)!=='ELF'||bytes.readUInt16LE(18)!==expected)throw Error('Incorrect Linux FFmpeg architecture');
  }else throw Error('Unsupported FFmpeg platform: '+platform);
}
async function download(url,dest,gzip=false){
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(`Download ${response.status}: ${url}`);
  const temporary=dest+'.download';
  try{const streams=[Readable.fromWeb(response.body)];if(gzip)streams.push(createGunzip());streams.push(createWriteStream(temporary));await pipeline(...streams);await fs.rename(temporary,dest);}
  finally{await fs.rm(temporary,{force:true});}
}
async function targetFiles(platform,arch){
  const name='ffmpeg'+(platform==='win32'?'.exe':''),dir=path.join(root,'.cache','release-ffmpeg',release,platform+'-'+arch),dest=path.join(dir,name);
  await fs.mkdir(dir,{recursive:true});
  if(platform===process.platform&&arch===process.arch){
    const source=require('ffmpeg-static');for(const suffix of ['', '.LICENSE','.README'])await fs.copyFile(source+suffix,dest+suffix);
  }else{
    const base=`https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`;
    for(const [suffix,url,gzip] of [['',`${base}/ffmpeg-${platform}-${arch}.gz`,true],['.LICENSE',`${base}/${platform}-${arch}.LICENSE`,false],['.README',`${base}/${platform}-${arch}.README`,false]]){
      try{await fs.access(dest+suffix);}catch{console.log('Downloading target FFmpeg:',platform,arch,suffix||'executable');await download(url,dest+suffix,gzip);}
    }
  }
  verifyBinary(await fs.readFile(dest),platform,arch);await fs.chmod(dest,0o755);return dest;
}
async function afterPack(context){
  const platform=context.electronPlatformName,arch=['ia32','x64','armv7l','arm64','universal'][context.arch];
  const source=await targetFiles(platform,arch),resources=platform==='darwin'?path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents','Resources'):path.join(context.appOutDir,'resources');
  const dir=path.join(resources,'ffmpeg');await fs.mkdir(dir,{recursive:true});
  const destination=path.join(dir,path.basename(source));
  for(const suffix of ['', '.LICENSE','.README'])await fs.copyFile(source+suffix,destination+suffix);
  await fs.chmod(destination,0o755);
  const bytes=await fs.readFile(destination);verifyBinary(bytes,platform,arch);
  if(platform!==process.platform||arch!==process.arch)throw Error('FFmpeg licensing checks require a native build host matching the release target.');
  const buildconf=execFileSync(destination,['-hide_banner','-buildconf'],{encoding:'utf8',timeout:15000});
  if(/--enable-nonfree\b/.test(buildconf))throw Error('Refusing to package FFmpeg built with --enable-nonfree; this binary is not redistributable.');
  if(/--enable-gpl\b|--enable-version3\b/.test(buildconf))throw Error('Refusing to package this FFmpeg build until its GPL/LGPLv3 license and corresponding source are cleared for release.');
  const record={platform,arch,release,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  await fs.writeFile(path.join(resources,'ffmpeg-build.json'),JSON.stringify(record,null,2)+'\n');console.log('Verified packaged FFmpeg:',platform,arch,record.sha256);
}
module.exports=afterPack;module.exports.verifyBinary=verifyBinary;module.exports.targetFiles=targetFiles;
