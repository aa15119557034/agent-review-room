const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const f=JSON.parse(fs.readFileSync(path.join(__dirname,'meta/plastic_crate_02.files.json')));
const relative='textures/plastic_crate_02_opacity_1k.png',entry=f.blend['1k'].blend.include[relative];
if(entry.md5!=='1b087615419b81cc55241fa7cdbe36f7'||entry.size!==16785)throw Error('Unexpected official mask record');
const destination=path.join(__dirname,'supplemental/plastic_crate_02',relative);
fs.mkdirSync(path.dirname(destination),{recursive:true});
if(!fs.existsSync(destination)){
  const result=spawnSync('curl.exe',['--fail','--location','--silent','--show-error','--max-time','45','--proxy',process.env.WORLD_BASE_PROXY||'http://127.0.0.1:7897',
    '--user-agent','agent-review-room-X51-asset-audit','--output',destination+'.part',entry.url],{windowsHide:true,encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr||String(result.error));
}
const input=fs.existsSync(destination)?destination:destination+'.part',raw=fs.readFileSync(input);
const md5=crypto.createHash('md5').update(raw).digest('hex');
if(raw.length!==entry.size||md5!==entry.md5)throw Error('Mask integrity mismatch');
if(input!==destination)fs.renameSync(input,destination);
const record={path:'supplemental/plastic_crate_02/'+relative,url:entry.url,bytes:raw.length,md5,sha256:crypto.createHash('sha256').update(raw).digest('hex'),
  metadataSource:'meta/plastic_crate_02.files.json: blend.1k.blend.include['+JSON.stringify(relative)+']',source:'https://polyhaven.com/a/plastic_crate_02',author:'Fabi_G',
  license:'CC0-1.0',licenseSource:'https://polyhaven.com/license',modified:false,original13Files:'unchanged; separate receipt retained'};
fs.writeFileSync(path.join(__dirname,'supplemental/opacity-receipt.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record,null,2));
