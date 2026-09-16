import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exchangeWechatCode } from '../server/wechat.js';
import { createApp } from '../server/index.js';

test('code exchange uses official server endpoint and never returns session_key',async()=>{
  const result=await exchangeWechatCode('one-time-code',{appId:'test-app',secret:'test-secret',fetchImpl:async(url)=>{
    assert.equal(url.origin,'https://api.weixin.qq.com');assert.equal(url.pathname,'/sns/jscode2session');
    assert.equal(url.searchParams.get('appid'),'test-app');assert.equal(url.searchParams.get('secret'),'test-secret');assert.equal(url.searchParams.get('js_code'),'one-time-code');
    return {ok:true,json:async()=>({openid:'wx-person',session_key:'never-send-this'})};
  }});
  assert.deepEqual(result,{appId:'test-app',openid:'wx-person'});
});
test('invalid code and provider/network failures fail closed without exposing credentials',async()=>{
  await assert.rejects(exchangeWechatCode('',{appId:'test-app',secret:'test-secret'}),e=>e.status===400);
  await assert.rejects(exchangeWechatCode('code',{appId:'test-app',secret:''}),e=>e.status===503);
  await assert.rejects(exchangeWechatCode('code',{appId:'test-app',secret:'test-secret',fetchImpl:async()=>({ok:true,json:async()=>({errcode:40029,errmsg:'secret in upstream error'})})}),e=>e.status===401&&!e.message.includes('secret'));
  await assert.rejects(exchangeWechatCode('code',{appId:'test-app',secret:'test-secret',fetchImpl:async()=>{throw new Error('URL includes test-secret');}}),e=>e.status===502&&!e.message.includes('test-secret'));
});
test('WeChat users are stable students, cannot impersonate roles and cannot use demo login',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dance-wechat-'));
  const exchange=async code=>({appId:'test-app',openid:code==='person-b'?'person-b':'person-a'});
  const app=createApp({dataDir:dir,mode:'demo',wechatExchange:exchange});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  const req=async(path,data,token)=>{const res=await fetch(url+'/api'+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:data?JSON.stringify(data):undefined});return {status:res.status,value:await res.json()};};
  let second;
  try {
    const a=await req('/auth/wechat',{code:'person-a',role:'admin',openid:'fake'});assert.equal(a.status,200);assert.equal(a.value.user.role,'student');
    const again=await req('/auth/wechat',{code:'fresh-code'});assert.equal(again.value.user.id,a.value.user.id);
    const b=await req('/auth/wechat',{code:'person-b'});assert.notEqual(b.value.user.id,a.value.user.id);
    assert.equal((await req('/demo/login',{account:a.value.user.id})).status,400);
    assert.equal((await req('/categories',{name:'越权'},a.value.token)).status,403);
    assert.equal(JSON.stringify(a.value).includes('openid'),false);
    const demo=await req('/demo/login',{account:'admin'});
    second=createApp({dataDir:dir,mode:'wechat',wechatExchange:exchange});await new Promise(resolve=>second.server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+second.server.address().port;
    assert.equal((await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"account":"admin"}'})).status,404);
    assert.equal((await fetch(base+'/api/me',{headers:{Authorization:'Bearer '+demo.value.token}})).status,401);
    assert.equal((await fetch(base+'/api/me',{headers:{Authorization:'Bearer '+a.value.token}})).status,200);
    // An operator can assign a real account; a subsequent refresh reflects it.
    app.store.run("UPDATE users SET role='admin' WHERE id=?",a.value.user.id);
    assert.equal((await req('/me',undefined,a.value.token)).value.user.role,'admin');
    assert.equal((await req('/categories',{name:'微信管理员创建'},a.value.token)).status,201);
  } finally {
    if(second){await new Promise(resolve=>second.server.close(resolve));second.store.db.close();}
    await new Promise(resolve=>app.server.close(resolve));app.store.db.close();await rm(dir,{recursive:true,force:true});
  }
});
