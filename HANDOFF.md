# 交接文档 · HomeTalker

> 写给**下次接着干**的人（或自己）。
> 最后更新：2026-10-25
> 仓库：https://github.com/wangqiang1988/hometalker

---

## 目录

1. [一句话现状](#一句话现状)
2. [已经完成并验证过的](#二已经完成并验证过的)
3. [你的环境事实（探测结果，别重做）](#三你的环境事实探测结果别重做)
4. [已诊断出的根因](#四已诊断出的根因)
5. [下一步：nginx 替换 Caddy（完整方案）](#五下一步nginx-替换-caddy完整方案)
6. [待你确认的两个问题](#六待你确认的两个问题)
7. [常用命令速查](#七常用命令速查)
8. [踩过的坑与结论](#八踩过的坑与结论)

---

## 一句话现状

项目功能已完成并通过 3 套自动化测试（19 + 9 + 19 项全绿），**但你的实际部署卡在 TLS 这一环**：Caddy 用 IP 访问时握手失败，导致浏览器根本进不去。

下一步是**把项目的 Caddy 换成 nginx**，改完后用域名 + Let's Encrypt 公开证书，家人手机**零配置**（不用装任何证书）就能用。

---

## 二、已经完成并验证过的

### 代码

| 模块 | 状态 |
|---|---|
| `server/` Node 20 + TS，运行时仅依赖 `ws` | ✅ 麦权状态机、口令校验、音频转发、静态文件服务 |
| `web/` React 19 + Vite，PWA | ✅ 门禁页、房间页、PTT、AudioWorklet 采集/播放、Wake Lock |
| `docker-compose.yml` + `Caddyfile` | ⚠️ 能跑，但 TLS 层有下面的问题 |
| `scripts/` 4 个自测脚本 | ✅ smoke(19) / behavior(9) / browser-e2e(19) / gen-icons |

### 验证结果（最后一次全绿）

```
smoke.mjs        19 通过 0 失败   # 协议层：鉴权/在线状态/麦权/音频转发
behavior.mjs      9 通过 0 失败   # exclusive 抢占/超时放麦/断线放麦
browser-e2e.mjs  19 通过 0 失败   # 真实 Chrome：麦克风→worklet→WS→服务端→另一端播放
```

### 已推送

```
bd8634f  docs: 重写 README 并新增 Docker 部署文档，补充界面截图
97e67fd  feat: 家庭内网对讲应用（server + web）
```

> ⚠️ **本机（10.255.1.98）无法跑 Docker**：`dockerd` 在跑但当前用户不在 `docker` 组、无免密 sudo。
> 验证方式：本地直接 `node dist/index.js` + 真实 Chrome（`--use-fake-device-for-media-stream` 走完整音频链路）+ 模拟 Docker 镜像的目录布局（`dist/` + `public/` 同级）跑干净构建。
> Caddy 配置用**官方二进制**校验：`caddy validate --config Caddyfile --adapter caddyfile`。

---

## 三、你的环境事实（探测结果，别重做）

### 服务器 10.255.1.101 的服务分布

| 端口 | 是什么 |
|---|---|
| 22 | SSH |
| **80** | **nginx/1.19.7** —— Cloudflare 域名导航站 |
| **443** | **Caddy** —— 管 `*.madless.club`（Let's Encrypt，**已于 2026-04-07 过期**） |
| 3000 | 某个登录面板（302 → /login） |
| 8000 | uvicorn（Python 服务） |
| 8080 | nginx |
| 8443 | **HomeTalker 容器（我们的）** |
| 9090 | 301 跳 https |
| 2019 | 关闭（Caddy admin API 未开） |

> `:443` 已被 Caddy 占着 —— 我们的容器想用 443 会冲突。

### 域名 / DNS / ACME

| 项 | 结论 |
|---|---|
| `madless.club` 的 NS | `bayan.ns.cloudflare.com` / `chloe.ns.cloudflare.com` → **DNS 在 Cloudflare** |
| `madless.club` A | `82.156.183.251`（公网，腾讯云） |
| `talker.madless.club` | **无记录**（要加） |
| 宿主机 nginx 对 `/.well-known/acme-challenge/*` | **404** → ACME 不走 HTTP-01 |
| 宿主机 Caddy 的证书 | `*.madless.club` 通配符 → **通配符只能用 DNS-01** |
| 宿主机 Caddy 的构建 | 官方 caddy 镜像/二进制**不含任何 DNS provider**，它能签通配符 → **必然是自编译的**（xcaddy + `caddy-dns-cloudflare`） |
| 宿主机 Caddy 的证书存储 | `/data/caddy/certificates/<host>/{<host>.crt, .key, .key 同名副本}`（容器路径推测，未验证） |

### 开发机 10.255.1.98

Ubuntu 24.04、Node 20.20.2、Docker 29.1.3（**无权限**）、`docker-compose` v1.29.2（`docker compose` v2 子命令不存在）、有 `/usr/bin/google-chrome`。

---

## 四、已诊断出的根因

### 现象 1：用 `http://` 访问 → 「连接不安全」

```bash
$ curl -i http://10.255.1.101:8443/api/health
HTTP/1.0 400 Bad Request

Client sent an HTTP request to an HTTPS server.
```

Caddy 在 HTTPS 端口收到明文请求时，返回的是一个**合法的 HTTP 400 响应**（不是 TLS 错误）。浏览器把它当普通网页渲染，地址栏于是显示：

> 「与 10.255.1.101 的连接不安全。您之所以会看到此警告，是因为该网站不支持 HTTPS。」

（这是从 Chrome 的 `locales/zh-CN.pak` 里扒出来的确切文案，不是猜的。）

**→ 你看到的「连接不安全」就是这个。协议写错了，跟证书无关。**

### 现象 2：改用 `https://` → 握手直接失败

```bash
$ curl -v https://10.255.1.101:8443/api/health
* TLS alert, internal error (592)
# Chrome 实测：net::ERR_SSL_PROTOCOL_ERROR
```

**原因：浏览器访问 IP 时不发送 SNI**（RFC 6066 规定 SNI 里只能放 DNS 名）。

Caddy 选证书的逻辑（`modules/caddytls/connpolicy.go`）：

```go
for _, matcher := range pol.matchers {
    if !matcher.Match(hello) { continue policyLoop }   // 空 SNI 匹配不上 IP
}
return nil, fmt.Errorf("no server TLS configuration available for ClientHello: %+v", hello)
```

Go 把这个错误映射成 TLS `internal_error` alert。

**→ 必须用主机名/域名访问。**

### 你的配置其实是对的

```bash
$ openssl s_client -connect 10.255.1.101:8443 -servername 10.255.1.101 </dev/null | openssl x509 -noout -ext subjectAltName
X509v3 Subject Alternative Name: critical
    IP Address:10.255.1.101
```

带 SNI 时握手完全正常，证书 SAN 也对。

### ⚠️ 一个还没查清的疑点

我用**完全相同的 Caddyfile** 在本地（Caddy 2.10.0 和 2.11.7、全新数据目录、site 带/不带端口、试过加 `sni` matcher）**都能正常握手**。也就是说，你实例上那个"匹配不上空 SNI 的连接策略"是怎么来的，还没搞清楚。

**下次第一件事**：在服务器上跑这 4 条命令，把输出贴出来：

```bash
cd /home/ubuntu/hometalker
docker compose exec caddy cat /etc/caddy/Caddyfile
docker compose logs caddy --tail=50
docker compose exec caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile | head -60
cat .env
```

> 注：`caddy list-certificates` 这个子命令**不存在**，别用。

---

## 五、下一步：nginx 替换 Caddy（完整方案）

### 为什么换 nginx

| | Caddy（现状） | nginx |
|---|---|---|
| 加载外部证书 | `tls /path/fullchain.pem /path/privkey.pem` | `ssl_certificate` / `ssl_certificate_key` —— 直接读手动签的，不用 Caddy 参与签发 |
| http→https 跳转 | 同端口做不到 | `listen 80; return 301 https://$host$request_uri;` 一行搞定 |
| 你宿主机 | :443 是 Caddy | :80 **已经是 nginx 1.19.7**，技能和配置都是现成的 |
| WebSocket | 自动支持 | 要显式配 `Upgrade`/`Connection` + 长超时 |
| 本地自签 CA | `tls internal` 一行搞定 | **做不了** ← 唯一损失 |

**唯一损失**：没法再用 `tls internal` 自签 + 装根 CA 那条"零配置"路。所以换 nginx 的前提是用 **Let's Encrypt 公开证书**（你正好有 Cloudflare + 域名，DNS-01 签发）。

### 决策（上次已定）

| 项 | 决定 |
|---|---|
| nginx 放哪 | **A + B 都支持**：基础 compose 只留 server（127.0.0.1:8787），另加 `docker-compose.nginx.yml` 覆盖文件 |
| 自签 CA 路线 | **彻底删掉 Caddy**（`Caddyfile` 和 caddy 服务都删） |
| 端口 | 全部走环境变量（你 443/80 都被占了） |

### 文件清单

| 操作 | 文件 |
|---|---|
| 🗑 删除 | `Caddyfile` |
| 🗑 删除 | `docker-compose.yml` 里的 caddy 服务 |
| ✏️ 改 | `docker-compose.yml` → 只留 server，端口绑 `127.0.0.1:${SERVER_PORT}:8443`，加 healthcheck |
| ➕ 新增 | `docker-compose.nginx.yml` → 加 nginx 服务 |
| ➕ 新增 | `nginx/templates/default.conf.template` |
| ➕ 新增 | `nginx/certs/README.md`（证书放哪、怎么签） |
| ✏️ 改 | `.env.example`、` .gitignore`（忽略 `nginx/certs/*`） |
| ➕ 新增 | `scripts/check-deploy.sh` |
| ✏️ 改 | `web/src/App.tsx` + `web/src/pages/Gate.tsx` → 非安全上下文时红字提示 + 一键跳 https |
| ✏️ 重写 | `DEPLOY.md` 部署章节、`README.md` 快速开始 |

### nginx 配置（`nginx/templates/default.conf.template`）

```nginx
# WebSocket 升级映射（conf.d/*.conf 被 include 在 http{} 内，map 可用）
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# HTTP：跳转 + ACME 挑战目录 + 健康检查
server {
    listen 80;
    server_name ${SITE_ADDR};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location = /healthz { access_log off; return 200 "ok\n"; }
    location / { return 301 https://$host$request_uri; }
}

# HTTPS
server {
    listen 443 ssl;
    http2 on;                      # WebSocket 仍走 h1（nginx 不发 SETTINGS_ENABLE_CONNECT_PROTOCOL）
    server_name ${SITE_ADDR};

    ssl_certificate     ${CERT_FILE};
    ssl_certificate_key ${KEY_FILE};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    server_tokens off;

    location / {
        proxy_pass http://${UPSTREAM};
        proxy_http_version 1.1;                 # WebSocket 必需
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                   # 音频实时性，别缓冲
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

**已核实的实现前提**（别再查了）：
- 官方 `nginx:alpine` 当前 **1.31.x**，支持 `http2 on;` 新语法（1.25.1+）
- 镜像的 `/etc/nginx/nginx.conf` 里 `include /etc/nginx/conf.d/*.conf;` 在 `http{}` 内 → **`map` 可以放 conf.d 文件** ✓
- entrypoint 会把 `/etc/nginx/templates/*.template` 做 envsubst 输出到 `/etc/nginx/conf.d/` → **能覆盖掉默认的 default.conf** ✓
- 官方 entrypoint 的 envsubst 只替换**环境里存在的变量名**，nginx 自己的 `$host`/`$remote_addr` 不受影响；但仍建议用 `NGINX_ENVSUBST_FILTER` 精确限定

### compose 草案

**`docker-compose.yml`（基础，形态 A 用）**
```yaml
services:
  server:
    build: { context: ., dockerfile: server/Dockerfile }
    container_name: hometalker-server
    restart: unless-stopped
    environment:
      PORT: "${PORT:-8443}"
      FAMILY_CODE: "${FAMILY_CODE:?请在 .env 中设置 FAMILY_CODE}"
      ROOM_NAME: "${ROOM_NAME:-home}"
      MAX_MEMBERS: "${MAX_MEMBERS:-12}"
      MAX_SPEAK_MS: "${MAX_SPEAK_MS:-60000}"
      SPEAK_MODE: "${SPEAK_MODE:-preempt}"
      LOG_LEVEL: "${LOG_LEVEL:-info}"
    ports:
      - "127.0.0.1:${SERVER_PORT:-8787}:8443"     # 只有宿主机能连
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:8443/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

**`docker-compose.nginx.yml`（覆盖，形态 B 用）**
```yaml
services:
  nginx:
    image: nginx:1.31-alpine
    container_name: hometalker-nginx
    restart: unless-stopped
    depends_on:
      server: { condition: service_healthy }
    environment:
      SITE_ADDR: "${SITE_ADDR:?请在 .env 中设置 SITE_ADDR（域名，不是 IP）}"
      UPSTREAM: "server:${PORT:-8443}"
      CERT_FILE: "/certs/fullchain.pem"
      KEY_FILE:  "/certs/privkey.pem"
      NGINX_ENVSUBST_FILTER: "SITE_ADDR|UPSTREAM|CERT_FILE|KEY_FILE"
    ports:
      - "${HTTPS_PORT:-443}:443"
      - "${HTTP_PORT:-80}:80"
    volumes:
      - ./nginx/templates/default.conf.template:/etc/nginx/templates/default.conf.template:ro
      - ./nginx/certs:/certs:ro
    healthcheck:
      test: ["CMD","wget","-qO-","http://127.0.0.1/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### `.env` 变量表

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITE_ADDR` | `talker.madless.club` | **域名，不是 IP**。证书 SAN + 访问地址 |
| `FAMILY_CODE` | 必填 | 家庭口令，<4 字符 server 拒绝启动 |
| `PORT` | `8443` | server 内部端口 |
| `SERVER_PORT` | `8787` | server 在宿主机暴露的端口（只绑 127.0.0.1） |
| `HTTPS_PORT` | `443` | 形态 B：nginx 容器发布的 HTTPS 端口 |
| `HTTP_PORT` | `80` | 形态 B：nginx 容器发布的 HTTP 端口 |
| `ROOM_NAME` | `home` | 房间名 |
| `MAX_MEMBERS` | `12` | 人数上限 |
| `MAX_SPEAK_MS` | `60000` | 单次发言上限 |
| `SPEAK_MODE` | `preempt` | `preempt` 抢占 / `exclusive` 拒绝 |
| `LOG_LEVEL` | `info` | 日志级别 |

### 证书签发（DNS-01，Cloudflare）

**certbot**（选项名已从官方文档核实）
```bash
sudo apt install certbot python3-certbot-dns-cloudflare
sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null <<'EOF'
dns_cloudflare_api_token = 你的token
EOF
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d talker.madless.club --agree-tos -m 你的邮箱 --non-interactive
# 产物：/etc/letsencrypt/live/talker.madless.club/{fullchain.pem,privkey.pem}
```

**acme.sh**（`CF_Token` 环境变量名已从源码核实）
```bash
curl https://get.acme.sh | sh -s email=你的邮箱 && source ~/.bashrc
export CF_Token='你的token'
~/.acme.sh/acme.sh --issue --dns dns_cf -d talker.madless.club --server letsencrypt
sudo mkdir -p /etc/caddy/certs/talker.madless.club
sudo ~/.acme.sh/acme.sh --install-cert -d talker.madless.club \
  --key-file       <目标>/privkey.pem \
  --fullchain-file <目标>/fullchain.pem \
  --reloadcmd      "systemctl reload nginx"     # 形态B 换成 docker compose exec nginx nginx -s reload
```

**Cloudflare API Token 权限**：`Zone / DNS / Edit`，Zone Resources 选 Specific zone → madless.club。

**证书放哪**
```
形态 A（宿主机 nginx）：/etc/nginx/ssl/talker.madless.club/{fullchain.pem,privkey.pem}
形态 B（项目容器）    ：/home/ubuntu/hometalker/nginx/certs/{fullchain.pem,privkey.pem}
```
- **必须是 fullchain**（叶子 + 中间证书），只给叶子客户端会报 `unable to get local issuer certificate`
- 私钥 `chmod 600`
- 验证链里有几张证书：`openssl crl2pkcs7 -nocrl -certfile fullchain.pem | openssl pkcs7 -print_certs -noout`

### DNS 记录

Cloudflare → madless.club → Add record：

| 字段 | 值 |
|---|---|
| Type | A |
| Name | `talker` |
| IPv4 | `82.156.183.251`（和 madless.club 一致） |
| Proxy | **DNS only（灰云）** |

> 保持灰云。开橙云的话 Cloudflare 会自己管边缘证书（宿主机连证书都不用签），但 WebSocket 会多一跳，源站路径也变了，先别动。

### 迁移步骤

```bash
cd /home/ubuntu/hometalker
git pull
docker compose down                        # 停掉旧的 caddy + server
cp .env.example .env && vi .env            # 新增 SITE_ADDR，改 FAMILY_CODE
# 签证书 → 放到 nginx/certs/（形态 B）或宿主机 nginx 读（形态 A）
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d --build
```

### 验收

```bash
bash scripts/check-deploy.sh               # 9 项自检
curl -sI https://talker.madless.club/api/health
# 手机浏览器打开 https://talker.madless.club
#   → 锁形图标、无任何警告
#   → 进房间按住说话，另一台设备能听到
#   → 不需要装任何证书
```

### `check-deploy.sh` 要查的 9 项

1. `.env` 存在且 `FAMILY_CODE` 非空
2. `SITE_ADDR` 能解析
3. server 容器 running + `/api/health` 返回 ok
4. TLS 握手（带 SNI）成功
5. 证书 SAN 包含 `SITE_ADDR`
6. 证书剩余有效期 > 7 天
7. `http://` 访问返回 301 → https
8. WebSocket 握手 + join 成功（复用 `scripts/smoke.mjs` 的逻辑）
9. 证书链完整（`openssl verify`）

---

## 六、待你确认的两个问题

**Q1：宿主机 :443 的那个 Caddy 怎么办？**
它现在管着 `*.madless.club`（已过期），而且 443 被占着。

- **A. 停掉换成 nginx** → 最干净，但会影响现在跑在 `*.madless.club` 上的其他站点
- **B. 让 Caddy 反代到 `127.0.0.1:8787`** → 零影响，但要改 Caddyfile 加一段
- **C. 形态 B 避开** → 项目 nginx 发布到 `HTTPS_PORT=8443`，不碰宿主机的 443

**Q2：形态 A（宿主机 nginx）还是 B（项目自带 nginx 容器）？**
上次默认按"A + B 都支持"来写（基础 compose 只留 server，另给 `docker-compose.nginx.yml`）。如果只想要一种，可以砍掉另一边。

---

## 七、常用命令速查

### 诊断 TLS（服务器上跑）

```bash
# 明文请求打到 HTTPS 端口 → 会出现 "Client sent an HTTP request to an HTTPS server"
curl -i http://10.255.1.101:8443/api/health

# HTTPS 握手
curl -kv https://10.255.1.101:8443/api/health

# 带 SNI（模拟带域名访问）→ 应该成功
openssl s_client -connect 10.255.1.101:8443 -servername 10.255.1.101 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName

# 不带 SNI（模拟用 IP 访问）→ 预期 alert internal error
openssl s_client -connect 10.255.1.101:8443 </dev/null 2>&1 | grep -E 'alert|issuer='
```

### 跑自测

```bash
# 协议层（需先起服务）
FAMILY_CODE=test1234 node scripts/smoke.mjs

# 服务端行为（exclusive 模式）
SPEAK_MODE=exclusive MAX_SPEAK_MS=1500 node server/dist/index.js &
node scripts/behavior.mjs

# 真实浏览器 E2E（需要 Chrome）
node scripts/browser-e2e.mjs

# 测 WSS
SMOKE_URL=wss://talker.madless.club/ws SMOKE_INSECURE=1 node scripts/smoke.mjs
```

### 本地开发（不用 Docker）

```bash
npm --prefix server install && npm --prefix web install
npm run build
cd server && FAMILY_CODE=dev1234 PUBLIC_DIR=../web/dist node dist/index.js
cd web && npm run dev          # /api 和 /ws 自动代理到 8443
```

### 本机跑不了 Docker 时的替代验证

```bash
# 模拟 Docker 镜像的目录布局
mkdir -p /tmp/app && cp -r server/dist /tmp/app/dist \
  && cp -r server/node_modules /tmp/app/node_modules && cp -r web/dist /tmp/app/public
cd /tmp/app && FAMILY_CODE=x node dist/index.js
# PUBLIC_DIR 默认解析为 dist/../public，和镜像里一致

# 校验 Caddy 配置
caddy validate --config Caddyfile --adapter caddyfile
```

---

## 八、踩过的坑与结论

### 已修的应用 bug（提交在 bd8634f 之前）

1. **口令错误时也把错误口令存进 localStorage** → 改正后仍进不去。改成只在收到 `welcome`（真正进房成功）后才保存。
2. **静态文件缓存永不失效** → 重新部署后服务端仍返回旧 `index.html`，指向已删除的 hash 资源 → **白屏**。改成 mtime + size 校验。
3. **麦克风授权弹窗期间松手会卡在"发言中"** → 加 `speakingRef` 预置位 + 授权返回后的状态复核。

### 踩过的工具坑

| 坑 | 说明 |
|---|---|
| **puppeteer 对非前台页面 `page.click()` 会永久挂起** | 一开始怀疑是应用 bug（按钮被遮挡），实测 `document.elementFromPoint` 返回的就是按钮本身 → 确认是测试工具问题，加 `page.bringToFront()` 解决。**应用本身没问题** |
| **Caddyfile 校验要带 `--adapter caddyfile`** | 直接 `caddy validate --config Caddyfile` 会解析失败 |
| **官方 Caddy 二进制不含任何 DNS provider** | `caddy list-modules | grep dns.providers` = 0。官方 `caddy:2-alpine` 镜像同样不含 → 要签通配符必须自编译 |
| **`caddy list-certificates` 子命令不存在** | 用 `ls /data/caddy/certificates/` 或 `openssl s_client` 代替 |
| **本机 `docker compose` v2 子命令不存在**，只有 `docker-compose` v1.29.2 | 且无 docker 组权限。验证改走「本地 Node + 真实 Chrome + 模拟镜像目录布局」 |
| **Caddy 的 HTTP 400 响应不是 TLS 错误** | 这是「连接不安全」误导提示的根源 —— 浏览器把它当合法 HTTP 页面渲染了 |

### 关键结论

1. **麦克风必须在安全上下文**：`getUserMedia` 只在 HTTPS 或 `localhost` 可用。`http://192.168.x.x` 会被直接禁用 → 表现是「能听不能说」，**没有绕过办法**。
2. **用 IP 访问时浏览器不发 SNI** → 反代可能握手失败。**必须用主机名/域名**。
3. **根 CA 十年有效** → 只要根 CA 不变，换 IP / 换域名都不用重新装手机证书。
4. **iOS 装 CA 必须两步**（装描述文件 + 开「完全信任」），只做一步 Safari 仍然拦截。
5. **Web 方案的天花板**：iOS 无法强制切「听筒」输出（无 `setSinkId`）→ 外放说话人自己会听到回声，靠浏览器 AEC 缓解，**建议戴耳机**。锁屏会冻结页面导致断线（浏览器限制无解），回前台自动重连。
6. **服务端只转发当前说话人的音频帧** → 抢麦切换天然无残留，半双工也是免费的。

---

## 附：项目结构速查

```
hometalker/
├── docker-compose.yml        # caddy + server（← 下次要改成 server only + nginx 覆盖文件）
├── Caddyfile                 # ← 下次要删
├── .env.example
├── DEPLOY.md                 # 部署手册
├── README.md                 # 项目主页
├── docs/images/              # 真实 Chrome 截的界面图
├── server/src/
│   ├── index.ts              # HTTP + WS upgrade + 心跳
│   ├── room.ts               # 麦权状态机（核心）
│   ├── static.ts             # 静态文件 + gzip + mtime 失效校验
│   ├── config.ts             # env 解析校验
│   └── log.ts
├── web/
│   ├── public/worklets/      # capture.js / playback.js（纯 JS）
│   └── src/{App.tsx, net/ws.ts, audio/audio.ts, pages/}
└── scripts/
    ├── smoke.mjs             # 19 项
    ├── behavior.mjs          # 9 项
    ├── browser-e2e.mjs       # 19 项（真实 Chrome）
    ├── screenshots.mjs       # 生成 README 截图
    └── gen-icons.mjs         # 纯 Node 生成 PWA 图标
```
