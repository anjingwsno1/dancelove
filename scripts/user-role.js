import { createStore, requireThat } from '../server/store.js';
import { resolve } from 'node:path';

// Local operator utility. No public API allows users to choose their own role.
const store=createStore(resolve(process.env.DATA_DIR||'data'));
try {
  const [id,role]=process.argv.slice(2);
  if(id==='--list')console.table(store.all('SELECT u.id,u.name,u.role FROM users u JOIN wechat_users w ON w.user_id=u.id'));
  else {
    requireThat(['student','teacher','admin'].includes(role),400,'用法：node --env-file-if-exists=.env scripts/user-role.js <用户ID> <student|teacher|admin>，或 --list');
    requireThat(store.one('SELECT 1 FROM wechat_users WHERE user_id=?',id||''),404,'请先在小程序使用微信登录，再提供真实用户 ID');
    store.run('UPDATE users SET role=? WHERE id=?',role,id);
    console.log('用户角色已更新，下次刷新首页生效。');
  }
} catch(e) { console.error(e.message);process.exitCode=1; } finally { store.db.close(); }
