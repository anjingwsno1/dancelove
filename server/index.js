import http from 'node:http';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, requireThat, ApiError } from './store.js';
import { receive, validateFields, processVideo, MAX_BYTES } from './media.js';
import { exchangeWechatCode } from './wechat.js';
import { createMediaStorage } from './cos-media.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req) {
  let size=0,chunks=[]; for await(const chunk of req){size+=chunk.length;requireThat(size<=16384,413,'请求内容过大');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new ApiError(400,'JSON 格式错误');}
}
export function createApp({dataDir=resolve(process.env.DATA_DIR||join(root,'data')),mode=process.env.APP_MODE||'demo',wechatExchange=exchangeWechatCode}={}) {
  requireThat(['demo','wechat'].includes(mode),503,'正式上线请使用 wechat 模式并配置微信身份认证与存储');
  const store=createStore(dataDir), secret=randomBytes(32), uploading=new Set();
  const mediaStorage=createMediaStorage(dataDir);
  const demoAccounts=['student','student2','teacher','admin'];
  if(mode==='demo')for(const [id,name,role] of [['student','林同学','student'],['student2','陈同学','student'],['teacher','许老师','teacher'],['admin','管理员','admin']]) store.run('INSERT OR IGNORE INTO users(id,name,role) VALUES(?,?,?)',id,name,role);
  function newSession(u) {
    store.run('DELETE FROM sessions WHERE expires<?',Date.now());
    const token=randomBytes(32).toString('hex');
    store.run('INSERT INTO sessions VALUES(?,?,?)',token,u.id,Date.now()+86400000);
    return {token,user:u};
  }
  function categoryName(value) {
    requireThat(typeof value==='string',400,'请输入分类名称');
    const name=value.trim().normalize('NFC');
    requireThat([...name].length>=1&&[...name].length<=12&&!/[\u0000-\u001f\u007f]/.test(name),400,'分类名称应为 1 至 12 个字');
    return name;
  }
  function categoryParent(value, selfId) {
    if(value===undefined||value===null||value==='')return null;
    requireThat(typeof value==='string',400,'上级分类无效');
    const parent=store.one('SELECT id,parent_id FROM categories WHERE id=?',value);
    requireThat(parent&&parent.id!==selfId&&parent.parent_id===null,400,'上级分类必须是一级分类');
    return parent.id;
  }
  const categoryRows=()=>store.all(`SELECT c.id,c.name,c.parent_id AS parentId,p.name AS parentName,
    CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' / ' || c.name END AS displayName,
    (SELECT COUNT(*) FROM categories child WHERE child.parent_id=c.id) AS childrenCount,
    (SELECT COUNT(*) FROM videos v WHERE v.category_id=c.id) AS videoCount
    FROM categories c LEFT JOIN categories p ON p.id=c.parent_id
    ORDER BY CASE WHEN c.parent_id IS NULL THEN c.rowid ELSE (SELECT root.rowid FROM categories root WHERE root.id=c.parent_id) END,
      CASE WHEN c.parent_id IS NULL THEN 0 ELSE 1 END,c.rowid`);
  const sign=text=>createHmac('sha256',secret).update(text).digest('base64url');
  function ticket(userId,videoId,kind,review=false) {
    const value=Buffer.from(JSON.stringify({u:userId,v:videoId,k:kind,r:review,e:Date.now()+15*60*1000})).toString('base64url');
    return `/media/${videoId}/${kind}?ticket=${value}.${sign(value)}`;
  }
  function access(u,v,{review=false,metadata=false}={}) {
    requireThat(v,404,'视频不存在');
    if(review){requireThat(u.role==='admin'&&v.status==='pending',403,'仅管理员可在审核期间预览');return;}
    if(metadata&&v.owner_id===u.id) return;
    requireThat(v.status==='approved'&&(v.visibility==='public'||v.owner_id===u.id),403,'视频尚未通过审核或无访问权限');
  }
  function serialize(v,u,review=false) {
    const available=v.status==='approved'&&(v.visibility==='public'||v.owner_id===u.id);
    const category=store.one('SELECT c.name,p.name AS parentName FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=?',v.category_id);
    return {...v,tags:JSON.parse(v.tags),ownerName:store.user(v.owner_id).name,categoryName:category.parentName?`${category.parentName} / ${category.name}`:category.name,
      likes:Number(store.one("SELECT COUNT(*) n FROM reactions WHERE video_id=? AND kind='like'",v.id).n),
      liked:!!store.one("SELECT 1 FROM reactions WHERE user_id=? AND video_id=? AND kind='like'",u.id,v.id),
      favorited:!!store.one("SELECT 1 FROM reactions WHERE user_id=? AND video_id=? AND kind='favorite'",u.id,v.id),
      coverUrl:available||review?ticket(u.id,v.id,'cover',review):null,playUrl:available||review?ticket(u.id,v.id,'play',review):null};
  }
  async function media(req,res,url) {
    let payload; const [value,sig]=String(url.searchParams.get('ticket')||'').split('.');
    const expected=sign(value||'');
    requireThat(sig&&sig.length===expected.length&&timingSafeEqual(Buffer.from(sig),Buffer.from(expected)),403,'链接无效');
    try{payload=JSON.parse(Buffer.from(value,'base64url'));}catch{throw new ApiError(403,'链接无效');}
    requireThat(payload.e>Date.now(),403,'播放链接已过期，请刷新');
    const match=url.pathname.match(/^\/media\/([a-f0-9-]+)\/(cover|play|download)$/);
    requireThat(match&&match[1]===payload.v&&match[2]===payload.k,403,'链接无效');
    const u=store.user(payload.u),v=store.one('SELECT * FROM videos WHERE id=?',payload.v);
    requireThat(u,403,'用户不存在'); access(u,v,{review:payload.r});
    requireThat(!(payload.r&&payload.k==='download'),403,'审核视频不能下载');
    const file=payload.k==='cover'?'cover.jpg':'video.mp4';
    const headers={'Content-Type':payload.k==='cover'?'image/jpeg':'video/mp4','Cache-Control':'private, no-store','Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
    if(payload.k==='download')headers['Content-Disposition']=`attachment; filename="dance-${v.id}.mp4"`;
    // COS 会在 Content-Range 中返回对象总大小；本地存储则直接读取文件长度。
    let start=0,end=undefined,status=200;
    const requested=req.headers.range&&/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(req.headers.range&&!requested){res.writeHead(416);res.end();return;}
    if(requested&&requested[1]) start=Number(requested[1]);
    const object=await mediaStorage.read(v.id,file,requested&&requested[1]?{start,end:requested[2]?Number(requested[2]):undefined}:undefined);
    const total=Number((object.headers?.['content-range']||'').match(/\/(\d+)$/)?.[1]||object.size);
    end=requested&&requested[2]?Math.min(Number(requested[2]),total-1):total-1;
    if(requested&&!requested[1]){const suffix=Number(requested[2]);start=Math.max(0,total-suffix);end=total-1;}
    if(start>end||start>=total){res.writeHead(416,{'Content-Range':`bytes */${total}`});res.end();return;}
    if(req.headers.range){
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${total}`;
    }
    res.writeHead(status,{...headers,'Content-Length':end-start+1});
    if(req.method==='HEAD'){res.end();return;}
    const stream=object.stream;stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost'),p=url.pathname;
      if(p.startsWith('/media/')){requireThat(['GET','HEAD'].includes(req.method),405,'请求方法不支持');await media(req,res,url);return;}
      if(p==='/api/health'){json(res,200,{mode,paymentsEnabled:false});return;}
      if(p==='/api/auth/wechat'&&req.method==='POST'){
        const {code}=await body(req);
        requireThat(typeof code==='string'&&code.length>0&&code.length<=256,400,'微信登录凭证无效');
        const identity=await wechatExchange(code);
        const user=store.tx(()=>{
          const existing=store.one('SELECT user_id FROM wechat_users WHERE app_id=? AND openid=?',identity.appId,identity.openid);
          if(existing)return store.user(existing.user_id);
          const id=randomUUID();
          store.run("INSERT INTO users(id,name,role) VALUES(?,?,'student')",id,'微信学员');
          store.run('INSERT INTO wechat_users VALUES(?,?,?)',identity.appId,identity.openid,id);
          return store.user(id);
        });
        json(res,200,newSession(user));return;
      }
      if(p==='/api/demo/login'&&req.method==='POST'){
        requireThat(mode==='demo',404,'演示登录已关闭');
        const {account}=await body(req);requireThat(demoAccounts.includes(account),400,'请选择演示账号');
        json(res,200,newSession(store.user(account)));return;
      }
      if(!p.startsWith('/api/')){
        requireThat(req.method==='GET',405,'请求方法不支持');
        const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
        requireThat(files[p],404,'页面不存在');const [file,type]=files[p];const path=join(root,'web',file);await stat(path);
        res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});createReadStream(path).pipe(res);return;
      }
      const token=(req.headers.authorization||'').replace(/^Bearer /,'');
      const session=store.one('SELECT * FROM sessions WHERE token=? AND expires>?',token,Date.now());requireThat(session,401,'请先登录');
      const u=store.user(session.user_id);
      if(mode==='wechat')requireThat(store.one('SELECT 1 FROM wechat_users WHERE user_id=?',u.id),401,'请使用微信重新登录');
      if(p==='/api/me'&&req.method==='GET'){json(res,200,{user:u,quota:store.quota(u.id),mode,paymentsEnabled:false});return;}
      if(p==='/api/orders'||p.startsWith('/api/orders/'))throw new ApiError(403,'充值功能暂未开放');
      if(p==='/api/categories'&&req.method==='GET'){
        if(url.searchParams.get('manage')==='1'){
          requireThat(u.role==='admin',403,'仅管理员可管理分类');
          json(res,200,categoryRows());return;
        }
        json(res,200,categoryRows());return;
      }
      if(p==='/api/categories'&&req.method==='POST'){
        requireThat(u.role==='admin',403,'仅管理员可管理分类');
        const data=await body(req),name=categoryName(data.name);
        const category=store.tx(()=>{
          requireThat(!store.one('SELECT 1 FROM categories WHERE name=? COLLATE NOCASE',name),409,'分类名称已存在');
          const parentId=categoryParent(data.parentId); 
          if(parentId)requireThat(!store.one('SELECT 1 FROM videos WHERE category_id=?',parentId),409,'该一级分类已有视频，请先转移视频后再创建二级分类');
          const id=randomUUID();store.run('INSERT INTO categories(id,name,parent_id) VALUES(?,?,?)',id,name,parentId);return {id,name,parentId};
        });json(res,201,category);return;
      }
      const categoryRoute=p.match(/^\/api\/categories\/([a-z0-9-]+)$/);
      if(categoryRoute&&['PATCH','DELETE'].includes(req.method)){
        requireThat(u.role==='admin',403,'仅管理员可管理分类');
        const id=categoryRoute[1],data=await body(req);
        const result=store.tx(()=>{
          const current=store.one('SELECT id,parent_id FROM categories WHERE id=?',id);requireThat(current,404,'分类不存在，请刷新');
          if(req.method==='PATCH'){
            const name=categoryName(data.name);
            requireThat(!store.one('SELECT 1 FROM categories WHERE name=? COLLATE NOCASE AND id<>?',name,id),409,'分类名称已存在');
            const parentId=Object.hasOwn(data,'parentId')?categoryParent(data.parentId,id):current.parent_id;
            if(parentId!==current.parent_id){
              requireThat(!store.one('SELECT 1 FROM categories WHERE parent_id=?',id),409,'含有二级分类的一级分类不能移动');
              if(parentId)requireThat(!store.one('SELECT 1 FROM videos WHERE category_id=?',id),409,'含有视频的一级分类不能设为二级分类');
            }
            store.run('UPDATE categories SET name=?,parent_id=? WHERE id=?',name,parentId,id);return {id,name,parentId};
          }
          requireThat(!store.one('SELECT 1 FROM categories WHERE parent_id=?',id),409,'请先删除或移动该一级分类下的二级分类');
          requireThat(store.one('SELECT COUNT(*) n FROM categories').n>1,409,'请至少保留一个分类');
          const count=store.one('SELECT COUNT(*) n FROM videos WHERE category_id=?',id).n;
          if(count){
            requireThat(typeof data.moveTo==='string'&&data.moveTo!==id,409,'该分类已有视频，请选择末级分类后再删除');
            const target=store.one('SELECT id FROM categories WHERE id=?',data.moveTo);
            requireThat(target&&!store.one('SELECT 1 FROM categories WHERE parent_id=?',target.id),409,'该分类已有视频，请选择末级分类后再删除');
            store.run('UPDATE videos SET category_id=? WHERE category_id=?',data.moveTo,id);
          }
          store.run('DELETE FROM categories WHERE id=?',id);return {message:'分类已删除',moved:count};
        });json(res,200,result);return;
      }
      if(p==='/api/videos'&&req.method==='GET'){
        const scope=url.searchParams.get('scope')||'public',q=(url.searchParams.get('q')||'').trim().toLowerCase(),category=url.searchParams.get('category');
        requireThat(['public','mine','favorites','review'].includes(scope),400,'列表类型无效');
        if(scope==='review')requireThat(u.role==='admin',403,'仅管理员可审核');
        let rows=store.all('SELECT * FROM videos ORDER BY created_at DESC,id DESC').filter(v=>scope==='mine'?v.owner_id===u.id:scope==='review'?v.status==='pending':v.status==='approved'&&(scope==='public'?v.visibility==='public':(v.visibility==='public'||v.owner_id===u.id)&&store.one("SELECT 1 FROM reactions WHERE video_id=? AND user_id=? AND kind='favorite'",v.id,u.id)));
        const selected=category?store.one('SELECT id FROM categories WHERE id=?',category):null;
        requireThat(!category||selected,400,'分类不存在，请刷新');
        const categoryIds=category?new Set([category,...store.all('SELECT id FROM categories WHERE parent_id=?',category).map(c=>c.id)]):null;
        rows=rows.filter(v=>(!categoryIds||categoryIds.has(v.category_id))&&(!q||v.title.toLowerCase().includes(q)||JSON.parse(v.tags).some(t=>t.toLowerCase().includes(q))));
        const page=Math.max(1,Number.parseInt(url.searchParams.get('page')||'1',10)||1),limit=20;
        json(res,200,{items:rows.slice((page-1)*limit,page*limit).map(v=>serialize(v,u,scope==='review')),total:rows.length,page,hasMore:page*limit<rows.length});return;
      }
      if(p==='/api/videos'&&req.method==='POST'){
        requireThat(Number(req.headers['content-length']||0)<=MAX_BYTES+65536,413,'视频不能超过 100MB');
        requireThat(!uploading.has(u.id)&&uploading.size<2,429,'有视频正在处理，请稍后再试');
        const quota=store.quota(u.id);requireThat(quota.limit===null||quota.freeRemaining>0||quota.credits>0,409,'今日上传次数已用完，请明天再来');
        uploading.add(u.id);const id=randomUUID(),dir=await mediaStorage.staging(id);
        try{const fields=validateFields(await receive(req,dir),store);const video=await processVideo(dir,fields);await mediaStorage.publish(id,dir);store.submit(u.id,{...video,id});json(res,201,{id,message:'已提交审核'});}
        catch(e){await mediaStorage.remove(id);await rm(dir,{recursive:true,force:true});throw e;}
        finally{uploading.delete(u.id);}return;
      }
      const route=p.match(/^\/api\/videos\/([a-f0-9-]+)(?:\/(like|favorite|download|review))?$/);
      if(route){
        const [,id,action]=route,v=store.one('SELECT * FROM videos WHERE id=?',id);
        if(!action&&req.method==='GET'){const review=url.searchParams.get('review')==='1';access(u,v,{review,metadata:true});json(res,200,serialize(v,u,review));return;}
        if(action==='review'&&req.method==='POST'){
          requireThat(u.role==='admin',403,'仅管理员可审核');requireThat(v,404,'视频不存在');
          const {decision,reason=''}=await body(req);requireThat(['approved','rejected'].includes(decision),400,'审核结果无效');requireThat(typeof reason==='string'&&reason.length<=200&&(decision!=='rejected'||reason.trim()),400,'驳回时请填写原因（不超过 200 字）');
          store.tx(()=>{const updated=store.run("UPDATE videos SET status=?,reason=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'",decision,reason.trim(),u.id,new Date().toISOString(),id);requireThat(updated.changes===1,409,'该视频已被审核，请刷新');store.run('INSERT INTO audit VALUES(?,?,?,?,?,?)',randomUUID(),u.id,id,decision,reason.trim(),new Date().toISOString());});
          json(res,200,{message:decision==='approved'?'审核已通过':'已驳回'});return;
        }
        access(u,v);
        if(['like','favorite'].includes(action)&&req.method==='PUT'){
          const {active}=await body(req);requireThat(typeof active==='boolean',400,'操作参数无效');
          if(active)store.run('INSERT OR IGNORE INTO reactions VALUES(?,?,?)',u.id,id,action);else store.run('DELETE FROM reactions WHERE user_id=? AND video_id=? AND kind=?',u.id,id,action);
          json(res,200,serialize(v,u));return;
        }
        if(action==='download'&&req.method==='POST'){json(res,200,{url:ticket(u.id,id,'download')});return;}
      }
      if(p==='/api/orders'&&req.method==='GET'){json(res,200,store.all('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50',u.id));return;}
      if(p==='/api/orders'&&req.method==='POST'){
        const {amountYuan}=await body(req);requireThat(Number.isSafeInteger(amountYuan)&&amountYuan>=1&&amountYuan<=10000,400,'请输入 1 至 10000 的整数金额（元）');
        const id=randomUUID();store.run('INSERT INTO orders(id,user_id,amount_fen,credits,created_at) VALUES(?,?,?,?,?)',id,u.id,amountYuan*100,amountYuan,new Date().toISOString());json(res,201,store.one('SELECT * FROM orders WHERE id=?',id));return;
      }
      const pay=p.match(/^\/api\/orders\/([a-f0-9-]+)\/demo-pay$/);
      if(pay&&req.method==='POST'){json(res,200,store.settle(pay[1],u.id));return;}
      throw new ApiError(404,'接口不存在');
    } catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'服务暂时不可用，请稍后重试'});else res.destroy();if(!e.status)console.error(e);}
  });
  server.requestTimeout=240000;
  return {server,store};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {server}=createApp();server.listen(Number(process.env.PORT||8787),process.env.HOST||'127.0.0.1',()=>console.log(`DanceLove 本地演示：http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||8787}`));
}
