import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const dayKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const requireThat = (condition, status, message) => { if (!condition) throw new ApiError(status, message); };
export function createStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'dance.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('student','teacher','admin')), credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0));
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wechat_users(app_id TEXT NOT NULL, openid TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), PRIMARY KEY(app_id,openid));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, parent_id TEXT REFERENCES categories(id));
    CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, tags TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), visibility TEXT NOT NULL CHECK(visibility IN ('public','private')), status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), reason TEXT NOT NULL DEFAULT '', duration REAL NOT NULL, bytes INTEGER NOT NULL, frame REAL NOT NULL DEFAULT 0, color TEXT NOT NULL, ink TEXT NOT NULL, style TEXT NOT NULL, created_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT);
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY REFERENCES videos(id), user_id TEXT NOT NULL REFERENCES users(id), day TEXT NOT NULL, source TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS uploads_user_day ON uploads(user_id,day);
    CREATE INDEX IF NOT EXISTS videos_feed ON videos(status,visibility,created_at);
    CREATE TABLE IF NOT EXISTS reactions(user_id TEXT NOT NULL REFERENCES users(id), video_id TEXT NOT NULL REFERENCES videos(id), kind TEXT NOT NULL CHECK(kind IN ('like','favorite')), PRIMARY KEY(user_id,video_id,kind));
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount_fen INTEGER NOT NULL, credits INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, paid_at TEXT);
    CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, reference TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor TEXT NOT NULL, video_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  // Add hierarchy support without recreating an existing user's database.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('categories') WHERE name='parent_id'").get()) db.exec('ALTER TABLE categories ADD COLUMN parent_id TEXT REFERENCES categories(id)');
  if (!db.prepare("SELECT 1 FROM settings WHERE key='categories_seeded'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [id, name] of [['classical','中国舞'],['jazz','爵士舞'],['hiphop','街舞'],['ballet','芭蕾'],['contemporary','现代舞'],['practice','基本功']]) db.prepare('INSERT OR IGNORE INTO categories(id,name,parent_id) VALUES(?,?,NULL)').run(id,name);
      db.prepare("INSERT INTO settings VALUES('categories_seeded','1')").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const user = id => one('SELECT * FROM users WHERE id=?', id);
  const quota = id => {
    const u = user(id);
    const used = Number(one("SELECT COUNT(*) AS n FROM uploads WHERE user_id=? AND day=? AND source='free'", id, dayKey()).n);
    const limit = { student: 1, teacher: 2, admin: null }[u.role];
    return { limit, used, freeRemaining: limit === null ? null : Math.max(0, limit-used), credits: u.credits, day: dayKey() };
  };
  function submit(id, data) {
    return tx(() => {
      const q = quota(id); let source = 'free';
      if (q.limit !== null && !q.freeRemaining) {
        requireThat(q.credits > 0, 409, '今日上传次数已用完，请明天再来');
        run('UPDATE users SET credits=credits-1 WHERE id=?', id); source = 'paid';
        run('INSERT INTO ledger VALUES(?,?,?,?,?)',randomUUID(),id,-1,`upload:${data.id}`,new Date().toISOString());
      }
      run(`INSERT INTO videos(id,owner_id,title,tags,category_id,visibility,status,duration,bytes,frame,color,ink,style,created_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,data.id,id,data.title,JSON.stringify(data.tags),data.categoryId,data.visibility,data.duration,data.bytes,data.frame,data.color,data.ink,data.style,new Date().toISOString());
      run('INSERT INTO uploads VALUES(?,?,?,?)',data.id,id,dayKey(),source);
      return data.id;
    });
  }
  function settle(orderId, userId) {
    return tx(() => {
      const order = one('SELECT * FROM orders WHERE id=? AND user_id=?', orderId,userId);
      requireThat(order,404,'订单不存在');
      if(order.state === 'paid') return order;
      requireThat(order.state === 'pending',409,'订单状态不允许支付');
      run("UPDATE orders SET state='paid',paid_at=? WHERE id=?",new Date().toISOString(),orderId);
      run('UPDATE users SET credits=credits+? WHERE id=?',order.credits,userId);
      run('INSERT INTO ledger VALUES(?,?,?,?,?)',randomUUID(),userId,order.credits,`order:${orderId}`,new Date().toISOString());
      return one('SELECT * FROM orders WHERE id=?',orderId);
    });
  }
  return { db, one, all, run, tx, user, quota, submit, settle };
}
