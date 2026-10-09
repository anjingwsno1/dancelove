import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dayKey, requireThat } from './store.js';

const initialCategories=[['classical','中国舞'],['jazz','爵士舞'],['hiphop','街舞'],['ballet','芭蕾'],['contemporary','现代舞'],['practice','基本功']];
const normalize=sql=>sql.replace(/^INSERT OR IGNORE\b/i,'INSERT IGNORE');

export async function createMySqlStore(env=process.env) {
  for(const key of ['MYSQL_HOST','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD'])requireThat(env[key],503,`缺少 ${key} 配置`);
  const pool=mysql.createPool({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),database:env.MYSQL_DATABASE,user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,waitForConnections:true,connectionLimit:10,charset:'utf8mb4'});
  const query=async(client,sql,args)=>{const [rows]=await client.execute(normalize(sql),args);return rows;};
  const context=client=>({
    one:async(sql,...args)=>(await query(client,sql,args))[0],
    all:(sql,...args)=>query(client,sql,args),
    run:async(sql,...args)=>({changes:(await query(client,sql,args)).affectedRows})
  });
  const base=context(pool);
  async function txAsync(fn) {
    const connection=await pool.getConnection();
    try{await connection.beginTransaction();const result=await fn(context(connection));await connection.commit();return result;}
    catch(error){await connection.rollback();throw error;}
    finally{connection.release();}
  }
  const user=id=>base.one('SELECT * FROM users WHERE id=?',id);
  async function quota(id) {
    const u=await user(id),used=Number((await base.one("SELECT COUNT(*) n FROM uploads WHERE user_id=? AND day=? AND source='free'",id,dayKey())).n);
    const limit={student:1,teacher:2,admin:null}[u.role];
    return {limit,used,freeRemaining:limit===null?null:Math.max(0,limit-used),credits:u.credits,day:dayKey()};
  }
  async function submit(id,data) {
    return txAsync(async db=>{
      const u=await db.one('SELECT id,role,credits FROM users WHERE id=? FOR UPDATE',id);
      const used=Number((await db.one("SELECT COUNT(*) n FROM uploads WHERE user_id=? AND day=? AND source='free'",id,dayKey())).n);
      const limit={student:1,teacher:2,admin:null}[u.role];let source='free';
      if(limit!==null&&used>=limit){requireThat(u.credits>0,409,'今日上传次数已用完，请明天再来');await db.run('UPDATE users SET credits=credits-1 WHERE id=?',id);source='paid';await db.run('INSERT INTO ledger VALUES(?,?,?,?,?)',randomUUID(),id,-1,`upload:${data.id}`,new Date().toISOString());}
      await db.run("INSERT INTO videos(id,owner_id,title,tags,category_id,visibility,status,duration,bytes,frame,color,ink,style,created_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)",data.id,id,data.title,JSON.stringify(data.tags),data.categoryId,data.visibility,data.duration,data.bytes,data.frame,data.color,data.ink,data.style,new Date().toISOString());
      await db.run('INSERT INTO uploads VALUES(?,?,?,?)',data.id,id,dayKey(),source);
      return data.id;
    });
  }
  async function settle(orderId,userId) {
    return txAsync(async db=>{
      const order=await db.one('SELECT * FROM orders WHERE id=? AND user_id=? FOR UPDATE',orderId,userId);
      requireThat(order,404,'订单不存在');if(order.state==='paid')return order;
      requireThat(order.state==='pending',409,'订单状态不允许支付');
      await db.run("UPDATE orders SET state='paid',paid_at=? WHERE id=?",new Date().toISOString(),orderId);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',order.credits,userId);
      await db.run('INSERT INTO ledger VALUES(?,?,?,?,?)',randomUUID(),userId,order.credits,`order:${orderId}`,new Date().toISOString());
      return db.one('SELECT * FROM orders WHERE id=?',orderId);
    });
  }
  try{
    await base.one('SELECT 1 AS ok');
    const schema=await readFile(new URL('../db/mysql-schema.sql',import.meta.url),'utf8');
    for(const statement of schema.split(/;\s*(?:\r?\n|$)/).slice(2))if(statement.trim())await pool.query(statement);
    if(!await base.one("SELECT value FROM settings WHERE `key`='categories_seeded'"))await txAsync(async db=>{
      for(const [id,name] of initialCategories)await db.run('INSERT OR IGNORE INTO categories(id,name,parent_id) VALUES(?,?,NULL)',id,name);
      await db.run("INSERT IGNORE INTO settings(`key`,value) VALUES('categories_seeded','1')");
    });
    return {...base,db:{close:()=>pool.end()},txAsync,user,quota,submit,settle};
  }catch(error){await pool.end();throw error;}
}
