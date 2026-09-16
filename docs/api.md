# 本地接口

基础地址 `http://127.0.0.1:8787/api`，除健康检查和演示登录外均需要 `Authorization: Bearer <token>`。错误格式为 `{ "error": "中文说明" }`，HTTP 状态码区分 400/401/403/404/409/413/422/429。

| 方法 / 路径 | 输入 | 行为 |
| --- | --- | --- |
| GET `/health` | 无 | 演示模式信息 |
| POST `/demo/login` | `{account: student / student2 / teacher / admin}` | 仅 demo 模式，返回演示用户与一天有效的 token；不接受真实用户 ID |
| POST `/auth/wechat` | `{code: wx.login 返回的临时凭证}` | 服务端换取微信身份，新用户为学员，仅返回业务用户与 token |
| GET `/me` | 无 | 用户、免费额度、永久次数与北京时间日期 |
| GET `/categories` | 可选 `manage=1` | 普通请求返回分类；manage=1 仅管理员可用，增加 videoCount |
| POST `/categories` | `{name, parentId?}` | 管理员创建一级分类或一级分类下的二级分类；不支持第三层 |
| PATCH `/categories/:id` | `{name, parentId?}` | 管理员修改名称或上级；含二级分类或视频的一级分类不能直接下移 |
| DELETE `/categories/:id` | 可选 `{moveTo: 末级分类ID}` | 管理员删除；含二级分类的一级分类须先处理子分类；已有作品时必须转移至其他末级分类；至少保留一个分类 |
| GET `/videos` | `scope=public/mine/favorites/review`、`q`、`category`、`page` | 按权限过滤，每页 20 条，返回 items/total/page/hasMore |
| POST `/videos` | multipart 表单，见下文 | 流式接收、校验、转码、截图、原子扣次并提交待审 |
| GET `/videos/:id` | 可选 `review=1` | 详情；待审管理员通过 review=1 获得审核预览 |
| PUT `/videos/:id/like` | `{active: true/false}` | 幂等设置/取消点赞 |
| PUT `/videos/:id/favorite` | `{active: true/false}` | 幂等设置/取消收藏 |
| POST `/videos/:id/download` | `{}` | 返回短时下载链接 |
| POST `/videos/:id/review` | `{decision: approved/rejected, reason}` | 管理员审核，驳回原因必填，重复审核返回 409 |
| 任意 `/orders` 及 `/orders/*` | — | 支付暂时关闭，登录后统一返回 403，不能创建订单或增加次数 |

上传字段：`video` 文件、`title`、`categoryId`、`visibility`（public/private）、`tags`（JSON 字符串数组）、`frame`（秒，必须小于视频时长）、`style`（poetry/bold/minimal）。只有处理及数据库提交成功才返回 201。前端遇到网络中断应先查看“我的作品”核实，避免对已完成的提交重复上传。

媒体链接形如 `/media/:id/play?ticket=...`，同理 cover/download。前端应使用接口返回的链接，不拼接对象路径、不持久保存 ticket。链接 15 分钟有效，状态改变或服务重启后可能提前失效，重新请求详情刷新。Range 格式错误返回 416。
