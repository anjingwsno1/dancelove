import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function walk(dir){const list=[];for(const f of await readdir(dir,{withFileTypes:true})){const p=join(dir,f.name);list.push(...(f.isDirectory()?await walk(p):[p]));}return list;}
let count=0;
for(const dir of ['server','web','miniprogram','tests','scripts'])for(const path of await walk(dir)){
  if(path.endsWith('.js')){const r=spawnSync(process.execPath,['--check',path],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(`${path}: ${r.error?.message||r.stderr}`);count++;}
  if(path.endsWith('.json')){JSON.parse(await readFile(path,'utf8'));count++;}
}
const app=JSON.parse(await readFile('miniprogram/app.json','utf8'));
for(const page of app.pages)for(const ext of ['js','json','wxml','wxss'])await readFile('miniprogram/'+page+'.'+ext);
const env=await readFile('.env','utf8').catch(()=>'');
const appSecret=env.match(/^WECHAT_APP_SECRET=(.+)$/m)?.[1]?.trim();
if(appSecret)for(const dir of ['miniprogram','web'])for(const path of await walk(dir)){
  if((await readFile(path,'utf8')).includes(appSecret))throw new Error('Server credential found in client source; remove it before packaging.');
}
if(!(await readFile('.gitignore','utf8')).split(/\r?\n/).includes('.env'))throw new Error('Server environment file must remain excluded from version control.');
console.log(`Validated ${count} JS/JSON files and all ${app.pages.length} mini-program pages.`);
