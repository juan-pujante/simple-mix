// Install the FFmpeg executable for the target, without modifying host dependencies.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..'),ffmpegVersion='8.1.2',lameVersion='3.100';
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
async function targetFiles(platform,arch){
  if(platform!==process.platform||arch!==process.arch)throw Error('Build FFmpeg locally for the target platform and architecture before packaging.');
  const dir=path.join(root,'.cache','release-ffmpeg',ffmpegVersion,platform+'-'+arch),dest=path.join(dir,'ffmpeg'+(platform==='win32'?'.exe':''));
  const info=JSON.parse(await fs.readFile(path.join(dir,'BUILD-INFO.json'),'utf8'));
  if(info.platform!==platform||info.arch!==arch||info.ffmpegVersion!==ffmpegVersion||info.lameVersion!==lameVersion)throw Error('FFmpeg build manifest does not match the package target.');
  const bytes=await fs.readFile(dest);verifyBinary(bytes,platform,arch);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==info.binarySha256)throw Error('FFmpeg binary checksum does not match its build manifest.');
  await fs.chmod(dest,0o755);return dest;
}
async function afterPack(context){
  const platform=context.electronPlatformName,arch=['ia32','x64','armv7l','arm64','universal'][context.arch];
  const source=await targetFiles(platform,arch),resources=platform==='darwin'?path.join(context.appOutDir,context.packager.appInfo.productFilename+'.app','Contents','Resources'):path.join(context.appOutDir,'resources');
  const dir=path.join(resources,'ffmpeg');await fs.mkdir(dir,{recursive:true});
  const destination=path.join(dir,path.basename(source));
  const staged=path.dirname(source),info=JSON.parse(await fs.readFile(path.join(staged,'BUILD-INFO.json'),'utf8'));
  for(const [from,to] of [['FFmpeg-LGPL-2.1.txt','FFmpeg-LGPL-2.1.txt'],['LAME-LGPL-2.0.txt','LAME-LGPL-2.0.txt'],['BUILD-CONFIG.txt','BUILD-CONFIG.txt'],['BUILD-INFO.json','BUILD-INFO.json']])await fs.copyFile(path.join(staged,from),path.join(dir,to));
  const notices=`Simple Mix bundles FFmpeg ${ffmpegVersion} and LAME ${lameVersion} as separate LGPL executables.\nFFmpeg source: https://ffmpeg.org/releases/ffmpeg-${ffmpegVersion}.tar.gz\nFFmpeg SHA-256: ${info.ffmpegSourceSha256}\nLAME source: https://downloads.sourceforge.net/project/lame/lame/${lameVersion}/lame-${lameVersion}.tar.gz\nLAME SHA-256: ${info.lameSourceSha256}\nThe LGPL-2.1 license texts and exact build configuration are included in this directory.\n`;
  await fs.writeFile(path.join(dir,'SOURCE-AVAILABILITY.txt'),notices);
  const bytes=await fs.readFile(source);await fs.writeFile(destination,bytes);await fs.chmod(destination,0o755);
  const buildconf=execFileSync(destination,['-hide_banner','-buildconf'],{encoding:'utf8',timeout:15000});
  if(/--enable-nonfree\b/.test(buildconf))throw Error('Refusing to package FFmpeg built with --enable-nonfree; this binary is not redistributable.');
  if(/--enable-gpl\b|--enable-version3\b/.test(buildconf))throw Error('Refusing FFmpeg configured outside the approved LGPL-2.1 build.');
  for(const required of ['--enable-libmp3lame','--enable-filter=asetpts','--enable-filter=pan','--enable-filter=loudnorm','--enable-filter=ebur128','--enable-filter=ametadata','--enable-filter=astats','--enable-filter=acompressor','--enable-muxer=pcm_s16le','--enable-muxer=pcm_f32le'])if(!buildconf.includes(required))throw Error('Refusing FFmpeg missing required feature '+required+'.');
  verifyBinary(bytes,platform,arch);
  const record={...info,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  await fs.writeFile(path.join(resources,'ffmpeg-build.json'),JSON.stringify(record,null,2)+'\n');console.log('Verified packaged LGPL FFmpeg:',platform,arch,record.sha256);
}
module.exports=afterPack;module.exports.verifyBinary=verifyBinary;module.exports.targetFiles=targetFiles;
