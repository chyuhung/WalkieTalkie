# 📻 网页对讲机（Web Walkie-Talkie）

手机浏览器端多人对讲系统：实时语音对讲（WebRTC P2P）、文字消息（自动朗读 TTS）、语音转文字显示（ASR）、在线状态、聊天记录。

## 功能特性

| 功能 | 说明 |
|---|---|
| 🎙️ 多人实时对讲 | 按住「说话」按钮，WebRTC 点到点直达，延迟最低（mesh 拓扑，适合 5-10 人小房间） |
| 💬 文字消息 | 输入文字发送，自动朗读（浏览器 `SpeechSynthesis`，可开关） |
| 📝 语音转文字 | 录制语音消息时实时转写（`SpeechRecognition`），对方可选择「听语音」或「看文字」 |
| 🟢 在线状态 | WebSocket 心跳 + 在线成员列表，实时显示说话状态 |
| 🕘 聊天记录 | SQLite 持久化，分页加载历史消息 |

## 技术栈

- **后端**：Go + Gin + gorilla/websocket + SQLite（modernc，纯 Go 无 cgo）
- **前端**：原生 HTML/CSS/JS（移动优先），WebRTC + Web Speech API
- **部署**：Docker / docker-compose / Caddy HTTPS

## 快速开始

### 方式一：直接运行（本地调试）

```bash
go mod tidy
go build -o walkietalkie.exe .
.\walkietalkie.exe
# 浏览器访问 http://localhost:8083
```

### 方式二：Docker

```bash
docker compose up -d --build
# 访问 http://<服务器IP>:8083
```

> **镜像拉取慢或卡住？** 国内直连 Docker Hub 受限，需给 Docker 配置镜像加速器（仅对 `golang:...`、`alpine:...` 这类官方镜像名生效）：
>
> ```bash
> sudo tee /etc/docker/daemon.json <<'EOF'
> { "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run", "https://hub.rat.dev"] }
> EOF
> sudo systemctl restart docker
> ```
>
> 应急方案：换源预拉取后打回官方 tag，构建直接使用本地缓存：
>
> ```bash
> docker pull docker.m.daocloud.io/library/golang:1.26-alpine
> docker tag docker.m.daocloud.io/library/golang:1.26-alpine golang:1.26-alpine
> docker pull docker.m.daocloud.io/library/alpine:3.20
> docker tag docker.m.daocloud.io/library/alpine:3.20 alpine:3.20
> ```

### 方式三：HTTPS 部署（手机对讲必需）

手机浏览器的麦克风要求「安全上下文」（HTTPS 或 localhost）。局域网通过 IP 访问时会被浏览器拦截麦克风权限。

#### 有域名：Caddy 自动签发（最省事）

推荐用 [Caddy](https://caddyserver.com) 自动签发证书：

1. 准备一个域名，解析到服务器
2. 修改 `Caddyfile` 中的域名
3. 启动 Caddy 反向代理到 8083 端口

#### 无域名（iOS/安卓用）：自签证书 + Nginx 反代

不需要域名，直接用服务器 IP 做 HTTPS。配置文件在 `deploy/https/`：

1. **在服务器生成自签证书**（填服务器公网 IP；如需局域网直连可追加局域网 IP）：
   ```bash
   cd /root/WalkieTalkie && git pull origin main   # 确保脚本是最新版（证书含 CA:TRUE）
   bash deploy/https/gen-certs.sh 8.134.203.172
   ```

2. **安装 Nginx 并套上反代配置**：
   ```bash
   apt install -y nginx
   cp deploy/https/nginx-https.conf /etc/nginx/conf.d/walkietalkie.conf
   nginx -t && systemctl reload nginx
   ```

3. `docker-compose.yml` 默认把 8083 绑到 `127.0.0.1`（仅本机可达，必须经 Nginx 访问）；安全组/防火墙只开放 **443**（后续部署 TURN 需额外放行对应端口，见下文）

4. **iPhone 安装并信任证书**：
   - 若装过旧证书，先删除：**设置 → 通用 → VPN与设备管理 → 删除旧描述文件**
   - 把 `walkielog.crt`（生成在项目目录，即 `gen-certs.sh` 的执行目录）通过 AirDrop/邮件/网盘传到手机 → 打开 → **已下载的描述文件 → 安装**
   - **设置 → 通用 → 关于本机 → 证书信任设置 → 开启「完全信任」**（证书必须出现在该列表里才可开启；出现即说明 CA 信任已生效）
   - **彻底关闭 Safari（上滑卡片杀掉）再重新打开**

5. Safari 访问 `https://8.134.203.172` 即可

> 注意：iOS 对被信任的证书有效期有 1 年限制，到期需重新生成并重装（重新执行 `gen-certs.sh` → `systemctl reload nginx` → 手机删旧装新）。
>
> 自测时可选 Chrome 实验参数（仅桌面端）：
> `chrome --unsafely-treat-insecure-origin-as-secure="http://192.168.x.x:8083"`

#### 跨公网对讲：部署 TURN（coturn）

不同网络（如手机流量 vs 家里宽带）之间的实时对讲需要 TURN 中继。项目已内置 Docker 配置（`docker-compose.yml` 中的 `coturn` 服务 + `deploy/turnserver.conf`）：

1. **修改密码**：编辑 `deploy/turnserver.conf`，把 `<强密码>` 改成你的强密码
2. **启动服务**：
   ```bash
   cd /root/WalkieTalkie && git pull origin main
   docker compose up -d   # 同时启动 walkietalkie 与 coturn
   ```
3. **放行端口**（安全组 + 本机防火墙）：TCP/UDP `3478`、UDP `40000-41000`
4. **启用前端配置**：把 `config.yaml` 中 `ice_servers` 替换为其下方的 TURN 注释行（填服务器公网 IP 与同一密码），然后重启应用容器拉取新配置：
   ```bash
   docker compose up -d --build walkietalkie
   ```
5. **验证**：
   ```bash
   docker logs coturn   # 确认无报错、正常监听 3478
   docker run --rm coturn/coturn turnutils_uclient -u walkie -w <强密码> -v <公网IP>
   ```
   测试客户端能完成分配并输出丢包统计即表示中继可用；最后用两台不同网络的设备实测按住实时对讲。

> 同一 WiFi 下无需 TURN，浏览器 host/mDNS 候选即可直连。

## 使用说明

1. **注册/登录**：创建账号，进入房间列表
2. **加入房间**：新建房间，或输入房间 ID 直接加入
3. **实时对讲**：按住底部红色「说话」按钮，松开即发送；说话时其他人会看到你正在说话
4. **文字消息**：底部输入框打字回车发送；勾选「文字自动朗读」时，收到的文字会以语音播报
5. **语音消息**：点 🎤 开始录音，松开/再次点击发送；若浏览器支持，会自动附上转写文字
6. **在线成员**：点右上角 👥 查看在线成员与说话状态

## 配置说明（config.yaml）

```yaml
server:
  port: "8083"          # 监听端口

webrtc:
  ice_servers: '[...]'  # ICE 服务器；跨网络对讲需配置 TURN 服务器

asr:
  provider: ""          # 第三方语音转文字服务（预留）
  api_key: ""
  api_url: ""
```

- **局域网对讲**：默认公网 STUN 即可（手机与服务器同网段时，ICE 会自动走主机候选）
- **跨公网对讲**：需自建 [coturn](https://github.com/coturn/coturn) 作为 TURN 服务器，填入 `ice_servers`
- **语音转文字**：优先使用浏览器 `SpeechRecognition`（Chrome/Edge）；Safari 不支持时自动回退，转写结果为空仅显示语音气泡

## 项目结构

```
WalkieTalkie/
├── main.go              # 路由、迁移、启动
├── config.yaml          # 配置
├── schema.sql           # 数据库结构参考
├── handlers/            # auth / room / message / ws / asr
├── hub/                 # WebSocket hub：房间、信令转发、在线状态
├── middleware/          # 认证中间件
├── templates/           # 页面（index / login / register）
├── static/              # 前端（app.js / webrtc.js / voice.js / style.css）
├── Dockerfile
├── docker-compose.yml
└── Caddyfile            # HTTPS 反向代理示例
```

## 数据表

- `users`：用户（用户名、密码哈希）
- `rooms`：对讲房间
- `room_members`：房间成员
- `messages`：聊天记录（text / voice，含转写文本与音频 URL）

## WebSocket 协议（客户端 ⇄ 服务器）

```
客户端 → 服务器：
  {type:"join", room:1}                     加入房间
  {type:"leave"}                            离开房间
  {type:"speaking", data:{talking:true}}    对讲状态
  {type:"webrtc_offer|webrtc_answer|webrtc_ice", to:2, data:{...}}  WebRTC 信令

服务器 → 客户端：
  {type:"presence", data:[{id,username}]}   在线成员列表
  {type:"user_joined"|"user_left", ...}     成员进出
  {type:"speaking", data:{id,talking}}      说话状态
  {type:"chat"|"voice", data:{...}}         聊天/语音消息
  {type:"webrtc_offer|webrtc_answer|webrtc_ice", from:1, data:{...}}
```

## 已知限制

- 对讲采用 **mesh 拓扑**，房间成员较多（>10）时带宽压力大，可扩展为 SFU 架构
- Web Speech API（TTS/ASR）仅 Chrome/Edge 完整支持；iOS Safari 不支持实时转写
- 多人同时按住说话时会相互叠加，建议同一时刻由一人发言（对讲机使用习惯）
