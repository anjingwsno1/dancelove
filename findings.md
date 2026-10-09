# 发现

- `server/index.js` 固定调用 SQLite `createStore`，MySQL 建表脚本目前没有参与运行。
- 微信登录路由已有创建 `users` 和 `wechat_users` 的逻辑，但调用同步 SQLite 接口。
- 小程序连接 `https://dancelovemini.site`；本地无法确认该远程服务器的当前数据库配置。
- 当前 `.env` 为演示模式，尚无 MySQL 凭据；测试需要保持本地可运行。
