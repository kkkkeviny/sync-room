# 部署到 Render（长期方案）

目标：**关掉你的电脑，两个人用两个不同 WiFi 也能玩。**

需要两个免费账号：GitHub（放代码）+ Render（跑服务）。全程不需要信用卡，也不需要懂命令行。

整条链路大概 10 分钟，其中 8 分钟是在等部署。

---

## 一、把代码放到 GitHub

1. 打开 <https://github.com/new>
2. Repository name 填 `sync-room`，选 **Public**，点 **Create repository**
3. 在新仓库页面点 **uploading an existing file**
4. 打开 `sync-room` 文件夹，**全选里面的内容**（`server.js`、`public`、`shared`、`render.yaml`……），拖进网页

   > ⚠️ 最容易错的一步：不要把 `sync-room` 文件夹本身拖进去。
   > 拖文件夹会变成 `sync-room/render.yaml`，下一步 Render 就找不到配置了。
   > 正确的层级是仓库根目录下直接能看到 `render.yaml`。

5. 下方点 **Commit changes**

---

## 二、在 Render 部署

1. 打开 <https://render.com>，用 **GitHub 账号登录**
2. 右上 **New** → **Blueprint**
3. 选中刚建的 `sync-room` 仓库 → **Connect**
4. 它会读到 [render.yaml](render.yaml)，直接点 **Apply**
5. 等 1–2 分钟，状态从 *Building* 变成 **Live**
6. 顶部会给你一个地址，形如：

   ```
   https://sync-room-xxxx.onrender.com
   ```

   （服务日志里也会打印 `异地联机 https://...`）

> 如果 Blueprint 说找不到配置，用备用路径：
> **New → Web Service** → 选仓库 → Build Command 留空 → Start Command 填 `node server.js` → Create。

---

## 三、验证

1. 手机打开 `https://sync-room-xxxx.onrender.com/healthz`，应显示 `ok`
2. 打开首页，点「创建房间」
3. 点「邀请 TA 进来」，把链接发到微信
4. 对方点开链接 → 直接成为 B 端进房
5. 两个人各说各的，开始玩

第一次打开可能要等 20–40 秒（见下面「休眠」）。

---

## 四、日常使用的四个注意点

| 事项 | 说明 |
|---|---|
| **休眠** | 免费实例 15 分钟没人访问会睡过去，下一局第一次打开要等 20–40 秒。建议开局前 1 分钟先打开页面预热 |
| **断线** | 休眠或切网会断开 WebSocket，客户端会自动重连，2 分钟内进度不丢 |
| **重启清空** | 房间只存在内存里，重新部署或服务重启后房间就没了，重新创建即可 |
| **额度** | 免费额度 750 实例小时/月；一个服务全天在线约 730 小时 |

想让它一直不睡：用 UptimeRobot / cron-job.org 每 10 分钟访问一次 `/healthz`。
代价是把 750 小时额度吃满，适合「这个月就想随时能玩」。

---

## 五、换自己的域名（可选）

Render → 你的服务 → **Settings → Custom Domains** → 添加域名 → 按提示把 CNAME 指过去。
证书是自动签的，不用管。

---

## 六、常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| Blueprint 报 `render.yaml not found` | 文件被放进了子目录 | 重新上传，让 `render.yaml` 在仓库根目录 |
| 打开一直转圈 / 502 | 免费实例在冷启动 | 等 30 秒刷新；或先访问 `/healthz` 预热 |
| 页面能开，点「创建房间」没反应 | WebSocket 没连上 | 看浏览器控制台；确认打开的是 `https://` 而不是 `http://` 或 `localhost` |
| 两个人进不到同一个房间 | 用了不同的地址 | 两个人必须打开**同一个** `onrender.com` 域名 |
| 邀请链接点开说房间不存在 | 房主那边页面关了 / 服务休眠了 | 重新创建房间再发一次 |
| 部署日志报找不到 node | 运行时选错 | 用 Blueprint 会自动选 Node；手动建服务时 Runtime 选 Node |
| 玩到一半一起掉线 | 免费实例被回收 | 正常现象，等它醒来后重连，进度还在 2 分钟内 |

服务端日志在 Render 的 **Logs** 面板，出问题先看那里有没有 `listening` 和连接记录。

---

## 七、如果不想用 Render

**Fly.io**（需要绑卡，约 $2/月）

```bash
# 先把 fly.toml 里的 app 名字改成全球唯一的
fly launch --copy-config --no-deploy
fly deploy
```

**自己的 VPS**（约 $3–5/月，延迟最低）

```bash
# 装 Node 18+，把项目传上去
node server.js
# 另开一个终端；把 Caddyfile 里的域名换成你的，A 记录指向这台机器
caddy run --config Caddyfile
```

Caddy 会自动申请 HTTPS 证书并支持 WebSocket 升级。用 Nginx 的话记得带 `Upgrade` 头（[README.md](README.md) 里有配置片段）。

---

## 八、隐私

- 没有账号系统，不收集任何个人信息。
- 房间只存在内存里，双方离线 2 分钟后自动销毁。
- 游戏里没有聊天内容，只有三个快捷信号（我看到了 / 等一下 / 可以了）。
- 语音建议用微信/电话，不经过这台服务器。
