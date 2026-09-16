import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { createApp } from '../server/index.js';
import { execute, validateFields, MAX_BYTES } from '../server/media.js';
import { dayKey, createStore } from '../server/store.js';

let app,dir,base,clip,longClip;const tokens={};
async function request(path,{account='student',method='GET',data,headers={}}={}) {
  const r=await fetch(base+'/api'+path,{method,headers:{Authorization:'Bearer '+tokens[account],...(data instanceof FormData?{}:{'Content-Type':'application/json'}),...headers},body:data===undefined?undefined:data instanceof FormData?data:JSON.stringify(data)});
  return {status:r.status,value:await r.json()};
}
async function upload(account,fields={},file=clip) {const data=new FormData();for(const [key,value] of Object.entries({title:'风中起舞',categoryId:'classical',tags:'["古典","练习"]',visibility:'public',frame:'0.5',style:'poetry',...fields}))data.set(key,value);data.set('video',new Blob([file],{type:'video/mp4'}),'dance.mp4');return request('/videos',{account,method:'POST',data});}
async function approve(id){return request(`/videos/${id}/review`,{account:'admin',method:'POST',data:{decision:'approved'}});}
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'dancelove-test-'));app=createApp({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
  for(const account of ['student','student2','teacher','admin'])tokens[account]=(await request('/demo/login',{method:'POST',data:{account}})).value.token;
  const short=join(dir,'short.mp4'),long=join(dir,'long.mp4');
  await execute(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=160x240:rate=12','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-y',short]);
  await execute(ffmpeg,['-v','error','-f','lavfi','-i','color=c=green:s=32x32:r=1','-t','91','-c:v','libx264','-y',long]);
  clip=await readFile(short);longClip=await readFile(long);
});
after(async()=>{if(app){await new Promise(resolve=>app.server.close(resolve));app.store.db.close();}if(dir)await rm(dir,{recursive:true,force:true});});
test('API requires a session; clients cannot choose their own role',async()=>{
  assert.equal((await request('/me',{account:'none'})).status,401);
  const login=await request('/demo/login',{method:'POST',data:{account:'student',role:'admin'}});assert.equal(login.value.user.role,'student');
  assert.throws(()=>createApp({dataDir:dir,mode:'production'}),/正式上线/);
});
test('Shanghai daily boundary is independent of host timezone',()=>{assert.equal(dayKey(new Date('2026-09-16T15:59:59Z')),'2026-09-16');assert.equal(dayKey(new Date('2026-09-16T16:00:00Z')),'2026-09-17');});
test('invalid title, category, tags, visibility and frame fail validation',()=>{
  const valid={title:'起舞',categoryId:'jazz',tags:'["练习"]',visibility:'public',frame:'0'};
  for(const changes of [{title:'一二三四五六七八九'},{title:' '},{categoryId:'bogus'},{tags:'[]'},{tags:'[1]'},{tags:'{}'},{tags:JSON.stringify(Array(9).fill('a'))},{visibility:'everyone'},{frame:'NaN'},{frame:'-1'},{style:'evil'}])assert.throws(()=>validateFields({...valid,...changes},app.store));
  assert.equal(validateFields({...valid,title:'一二三四五六七八'},app.store).title.length,8);
});
test('actual duration >90s and invalid media fail without consuming quota',async()=>{
  const before=app.store.quota('student');
  assert.equal((await upload('student',{},longClip)).status,400);
  assert.equal((await upload('student',{},Buffer.from('not a video'))).status,422);
  assert.equal((await upload('student',{frame:'3'})).status,400);
  assert.deepEqual(app.store.quota('student'),before);
});
test('student upload becomes pending, blocks all interactions and consumes one free use',async()=>{
  const result=await upload('student');assert.equal(result.status,201);const id=result.value.id;
  assert.equal(app.store.quota('student').freeRemaining,0);
  const mine=await request('/videos?scope=mine');assert.equal(mine.value.items[0].status,'pending');assert.equal(mine.value.items[0].playUrl,null);assert.equal(mine.value.items[0].coverUrl,null);
  assert.equal((await request('/videos?q=古典')).value.total,0);
  for(const action of ['like','favorite','download'])assert.equal((await request(`/videos/${id}/${action}`,{method:action==='download'?'POST':'PUT',data:{active:true}})).status,403);
  assert.equal((await upload('student')).status,409);
  assert.equal((await request(`/videos/${id}/review`,{method:'POST',data:{decision:'approved'}})).status,403);
  assert.equal((await request('/videos?scope=review')).status,403);
});
test('admin review is exclusive; approval unlocks search, playback, range and idempotent reactions',async()=>{
  const queue=await request('/videos?scope=review',{account:'admin'});const v=queue.value.items[0];assert.ok(v.playUrl);
  assert.equal((await fetch(base+v.playUrl)).status,200);
  assert.equal((await approve(v.id)).status,200);assert.equal((await approve(v.id)).status,409);
  assert.equal((await fetch(base+v.playUrl)).status,403,'old review ticket revoked after review');
  const results=await request('/videos?q=古典&category=classical');assert.equal(results.value.total,1);
  const video=results.value.items[0];assert.ok(video.coverUrl);assert.match(video.color,/^#[0-9a-f]{6}$/);
  const cover=await fetch(base+video.coverUrl);assert.equal(cover.headers.get('content-type'),'image/jpeg');assert.ok((await cover.arrayBuffer()).byteLength>100);
  const range=await fetch(base+video.playUrl,{headers:{Range:'bytes=0-99'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);
  assert.equal((await fetch(base+video.playUrl,{headers:{Range:'bytes=999999999-'}})).status,416);
  assert.equal((await fetch(base+video.playUrl+'x')).status,403);
  for(let i=0;i<2;i++)assert.equal((await request(`/videos/${v.id}/like`,{method:'PUT',data:{active:true}})).value.likes,1);
  await request(`/videos/${v.id}/favorite`,{method:'PUT',data:{active:true}});assert.equal((await request('/videos?scope=favorites')).value.total,1);
  const download=await request(`/videos/${v.id}/download`,{method:'POST',data:{}});assert.match((await fetch(base+download.value.url)).headers.get('content-disposition'),/attachment/);
  await request(`/videos/${v.id}/like`,{method:'PUT',data:{active:false}});assert.equal((await request(`/videos/${v.id}`)).value.likes,0);
  assert.equal(await stat(join(dir,'media',v.id,'input')).then(()=>true,()=>false),false,'original removed after processing');
});
test('private video is accessible only to its owner after approval, even for administrators',async()=>{
  const {value}=await upload('teacher',{visibility:'private',title:'私藏练习'});assert.ok(value.id);
  assert.equal((await request(`/videos/${value.id}`,{account:'student2'})).status,403);
  assert.equal((await request(`/videos/${value.id}?review=1`,{account:'admin'})).status,200);
  await approve(value.id);
  for(const account of ['student','student2','admin']){
    assert.equal((await request(`/videos/${value.id}`,{account})).status,403);
    assert.equal((await request('/videos?q=私藏练习',{account})).value.total,0);
    assert.equal((await request(`/videos/${value.id}/download`,{account,method:'POST',data:{}})).status,403);
  }
  const mine=await request(`/videos/${value.id}`,{account:'teacher'});assert.ok(mine.value.playUrl);
  assert.equal((await fetch(base+mine.value.playUrl)).status,200);
  await request(`/videos/${value.id}/favorite`,{account:'teacher',method:'PUT',data:{active:true}});assert.equal((await request('/videos?scope=favorites',{account:'teacher'})).value.total,1);
});
test('teacher gets two daily uploads; rejection needs a reason and does not refund',async()=>{
  const result=await upload('teacher',{title:'第二次练习'});assert.equal(result.status,201);
  assert.equal(app.store.quota('teacher').freeRemaining,0);assert.equal((await upload('teacher')).status,409);
  assert.equal((await request(`/videos/${result.value.id}/review`,{account:'admin',method:'POST',data:{decision:'rejected'}})).status,400);
  assert.equal((await request(`/videos/${result.value.id}/review`,{account:'admin',method:'POST',data:{decision:'rejected',reason:'画面太暗，请重新录制'}})).status,200);
  const mine=await request(`/videos/${result.value.id}`,{account:'teacher'});assert.equal(mine.value.reason,'画面太暗，请重新录制');assert.equal(mine.value.playUrl,null);assert.equal(app.store.quota('teacher').freeRemaining,0);
});
test('payment endpoints are disabled for every role; existing extra credits remain usable',async()=>{
  for(const account of ['student','teacher','admin']){
    assert.equal((await request('/orders',{account,method:'POST',data:{amountYuan:10}})).status,403);
    assert.equal((await request('/orders',{account})).status,403);
    assert.equal((await request('/orders/00000000-0000-0000-0000-000000000000/demo-pay',{account,method:'POST',data:{}})).status,403);
  }
  assert.equal((await request('/health')).value.paymentsEnabled,false);
  // Fixture models already-purchased credits. No network route can add credits.
  app.store.run('UPDATE users SET credits=10 WHERE id=?','student');
  assert.equal((await upload('student',{title:'额外上传'})).status,201);assert.equal(app.store.quota('student').credits,9);
});
test('free allowance is consumed before paid credits; admin unlimited and credits persist',async()=>{
  app.store.run('UPDATE users SET credits=1 WHERE id=?','student2');
  assert.equal((await upload('student2')).status,201);assert.equal(app.store.quota('student2').credits,1);
  for(let i=0;i<3;i++)assert.equal((await upload('admin')).status,201);
  assert.equal(app.store.quota('admin').limit,null);
  app.store.run("UPDATE uploads SET day='2000-01-01' WHERE user_id='student2'");assert.equal(app.store.quota('student2').freeRemaining,1);assert.equal(app.store.quota('student2').credits,1);
});
test('100MiB boundary is enforced on the received file, without quota charges',async()=>{
  const before=app.store.quota('admin');
  assert.equal((await upload('admin',{},Buffer.alloc(MAX_BYTES))).status,422,'exact limit reaches media validation');
  assert.equal((await upload('admin',{},Buffer.alloc(MAX_BYTES+1))).status,413,'one extra byte rejected');
  assert.deepEqual(app.store.quota('admin'),before);
});
test('a video of exactly 90 seconds is accepted',async()=>{
  const path=join(dir,'exact90.mp4');await execute(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=1','-t','90','-c:v','libx264','-y',path]);
  const result=await upload('admin',{frame:'0'},await readFile(path));assert.equal(result.status,201);assert.equal(app.store.one('SELECT duration FROM videos WHERE id=?',result.value.id).duration,90);
});
test('failed database submission rolls back credit deduction and data survives reopening',()=>{
  const before=app.store.quota('student');
  assert.throws(()=>app.store.submit('student',{id:'test-invalid',title:'事务',tags:[],categoryId:'invalid',visibility:'public',duration:2,bytes:100,frame:0,color:'#000000',ink:'#ffffff',style:'poetry'}));
  assert.deepEqual(app.store.quota('student'),before);
  assert.equal(app.store.one('SELECT * FROM ledger WHERE reference=?','upload:test-invalid'),undefined);
  const reopened=createStore(dir);assert.deepEqual(reopened.quota('student'),before);reopened.db.close();
});
test('only admins may create, rename, delete or inspect category management counts',async()=>{
  for(const account of ['student','teacher']){
    assert.equal((await request('/categories?manage=1',{account})).status,403);
    assert.equal((await request('/categories',{account,method:'POST',data:{name:'越权分类'}})).status,403);
    assert.equal((await request('/categories/classical',{account,method:'PATCH',data:{name:'越权改名'}})).status,403);
    assert.equal((await request('/categories/classical',{account,method:'DELETE',data:{moveTo:'jazz'}})).status,403);
    assert.equal((await request('/categories',{account})).status,200);
  }
});
test('category CRUD validates names, prevents duplicates and survives restart without reseeding',async()=>{
  for(const name of ['', '  ', '一二三四五六七八九十一二三',123,'非法\n名称'])assert.equal((await request('/categories',{account:'admin',method:'POST',data:{name}})).status,400);
  const c=(await request('/categories',{account:'admin',method:'POST',data:{name:'  拉丁舞  '}})).value;
  assert.equal(c.name,'拉丁舞');assert.ok(c.id);
  assert.equal((await request('/categories',{account:'admin',method:'POST',data:{name:'拉丁舞'}})).status,409);
  assert.equal((await request(`/categories/${c.id}`,{account:'admin',method:'PATCH',data:{name:'中国舞'}})).status,409);
  assert.equal((await request(`/categories/${c.id}`,{account:'admin',method:'PATCH',data:{name:'拉丁基础'}})).status,200);
  assert.equal((await request(`/categories/${c.id}`,{account:'admin',method:'DELETE',data:{}})).status,200);
  assert.equal((await request('/categories/jazz',{account:'admin',method:'DELETE',data:{}})).status,200);
  assert.equal((await request('/categories/ballet',{account:'admin',method:'PATCH',data:{name:'芭蕾基础'}})).status,200);
  const reopened=createStore(dir);assert.equal(reopened.one('SELECT * FROM categories WHERE id=?','jazz'),undefined);assert.equal(reopened.one('SELECT name FROM categories WHERE id=?','ballet').name,'芭蕾基础');reopened.db.close();
});
test('categories support exactly two levels, roots filter descendants, and uploads accept leaves only',async()=>{
  const root=(await request('/categories',{account:'admin',method:'POST',data:{name:'测试一级'}})).value;
  const child=(await request('/categories',{account:'admin',method:'POST',data:{name:'测试二级',parentId:root.id}})).value;
  assert.equal(child.parentId,root.id);
  const categories=(await request('/categories')).value;
  assert.deepEqual(categories.filter(c=>c.id===child.id)[0],{
    id:child.id,name:'测试二级',parentId:root.id,parentName:'测试一级',displayName:'测试一级 / 测试二级',childrenCount:0,videoCount:0
  });
  assert.equal((await request('/categories',{account:'admin',method:'POST',data:{name:'三级分类',parentId:child.id}})).status,400);
  assert.equal((await upload('admin',{categoryId:root.id,title:'一级不能上传'})).status,400);
  const video=await upload('admin',{categoryId:child.id,title:'二级可上传'});assert.equal(video.status,201);
  await approve(video.value.id);
  assert.equal((await request('/videos?category='+root.id)).value.items.some(v=>v.id===video.value.id),true);
  assert.equal((await request('/categories/'+root.id,{account:'admin',method:'DELETE',data:{}})).status,409);
  assert.equal((await request('/categories/'+root.id,{account:'admin',method:'PATCH',data:{name:'改名一级',parentId:'practice'}})).status,409);
  assert.equal((await request('/categories/'+child.id,{account:'admin',method:'DELETE',data:{moveTo:'practice'}})).status,200);
  assert.equal((await request('/categories/'+root.id,{account:'admin',method:'DELETE',data:{}})).status,200);
});
test('occupied category deletion atomically moves every video without changing visibility or review state',async()=>{
  const before=app.store.all('SELECT id,visibility,status,owner_id FROM videos WHERE category_id=? ORDER BY id','classical');assert.ok(before.length);
  const managed=await request('/categories?manage=1',{account:'admin'});assert.equal(managed.value.find(c=>c.id==='classical').videoCount,before.length);
  for(const moveTo of [undefined,'classical','does-not-exist'])assert.equal((await request('/categories/classical',{account:'admin',method:'DELETE',data:{moveTo}})).status,409);
  assert.equal(app.store.one('SELECT COUNT(*) n FROM videos WHERE category_id=?','classical').n,before.length);
  const moved=await request('/categories/classical',{account:'admin',method:'DELETE',data:{moveTo:'practice'}});assert.equal(moved.status,200);assert.equal(moved.value.moved,before.length);
  const after=app.store.all('SELECT id,visibility,status,owner_id FROM videos WHERE category_id=? ORDER BY id','practice');
  assert.deepEqual(after.filter(v=>before.some(original=>original.id===v.id)),before);
  assert.equal(app.store.one('SELECT * FROM categories WHERE id=?','classical'),undefined);
  assert.equal((await upload('admin',{categoryId:'classical'})).status,400);
  assert.equal((await request('/videos?category=practice')).value.total>0,true);
  assert.equal((await request('/videos?q=私藏练习',{account:'admin'})).value.total,0);
});
test('last remaining category cannot be deleted',async()=>{
  for(const c of app.store.all("SELECT id FROM categories WHERE id<>'practice'"))assert.equal((await request('/categories/'+c.id,{account:'admin',method:'DELETE',data:{moveTo:'practice'}})).status,200);
  assert.equal((await request('/categories/practice',{account:'admin',method:'DELETE',data:{}})).status,409);
});
