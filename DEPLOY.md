# Docker 部署文档

> 本文是 HomeTalker 的**完整部署手册**。想快速了解项目本身请看 [README.md](README.md)。

---

## 目录

- [部署概览](#部署概览)
- [前置条件](#前置条件)
- [部署步骤](#部署步骤)
- [给手机装证书](#给手机装证书)
- [给电脑装证书](#给电脑装证书windows--macos--linux)
- [局域网设置](#局域网设置)
- [配置项](#配置项)
- [日常运维](#日常运维)
- [更新](#更新)
- [备份与迁移](#备份与迁移)
- [卸载](#卸载)
- [排障](#排障)
- [进阶玩法](#进阶玩法)

---

## 部署概览

```
                    家庭 Wi-Fi（同一个子网）
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  iPhone  │   │  Android │   │  iPad    │
   │  浏览器   │   │  浏览器   │   │  浏览器   │
   └────┬─────┘   └────┬─────┘   └────┬─────┘
        │  https://192.168.1.50       │
        └──────────────┬──────────────┘
                       │ WSS
              ┌────────▼─────────┐
              │  内网服务器        │
              │  ┌──────────────┐ │
              │  │ caddy :443   │ │  TLS 终止（本地 CA 签发）
              │  └──────┬───────┘ │
              │  ┌──────▼───────┐ │
              │  │ server :8443 │ │  口令校验 / 麦权 / 音频转发
              │  └──────────────┘ │
              └───────────────────┘
```

两个容器：

| 容器 | 作用 | 端口 | 状态 |
|---|---|---|---|
| `caddy` | TLS 终止、静态资源反代、WebSocket 反代 | `443`（对外） | 有状态：证书存在 volume 里 |
| `server` | 家庭口令校验、麦权状态机、音频转发、静态文件 | `8443`（仅容器内） | **完全无状态** |

**资源占用**：10 人房间 server 内存 < 100 MB、CPU < 3%。整套（含 Caddy）内存 < 200 MB，CPU 空闲时接近 0。树莓派 3B+ 毫无压力。

---

## 前置条件

- [ ] 一台能跑 Docker 的 Linux 机器（NAS / 树莓派 / 迷你主机 / 任意 x86 或 arm64 主机）
- [ ] Docker 20.10+ 和 Docker Compose v2（`docker compose version` 能输出即可）
- [ ] 服务器在家庭 Wi-Fi 里有**固定 IP**
- [ ] 路由器**没占用 443 端口**（占用的话看[端口冲突](#443-端口被路由器占了)）
- [ ] 一台 iPhone 或 Android 手机

检查环境：

```bash
docker --version
docker compose version
ip -4 addr show scope global | grep inet     # 找到你的内网 IP
```

---

## 部署步骤

### 第 1 步：克隆

```bash
git clone https://github.com/wangqiang1988/hometalker.git
cd hometalker
```

### 第 2 步：配置

```bash
cp .env.example .env
vi .env
```

**最少要改两项**：

```ini
SITE_ADDR=192.168.1.50      # 你服务器的固定 IP（写进证书，填错手机打不开）
FAMILY_CODE=你的家庭口令     # 至少 4 个字符
```

> `FAMILY_CODE` 没设置时 server 会**拒绝启动**并打印错误。这是故意的 —— 避免忘记设口令导致任何连上你家 Wi-Fi 的人都能进房间收听。

完整配置项见[配置项](#配置项)。

### 第 3 步：启动

```bash
docker compose up -d --build
```

首次构建约 1~3 分钟（要拉 node:20-alpine 和 caddy:2-alpine 镜像）。

验证：

```bash
docker compose ps                        # 两个服务都应该是 Up
docker compose logs -f server            # 看到 "房间 "home" 已启动，监听 :8443"
curl -k https://192.168.1.50/api/health  # {"ok":true,"room":"home","online":0,...}
```

### 第 4 步：导出根证书

Caddy 用自己的本地 CA 给你的 IP 签证书。手机要信任这个 CA 才能正常访问。

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./rootCA.crt
```

把 `rootCA.crt` 通过微信 / AirDrop / 网盘发给家里人。

> **根 CA 有效期 10 年。** 只要根 CA 不变，以后换 IP 或换域名**都不用重新装证书** —— 只需改 `.env` 的 `SITE_ADDR` 再 `docker compose restart caddy`。

### 第 5 步：给手机装证书

见下一节。

### 第 6 步：添加到主屏幕（可选但强烈建议）

**iPhone**（用 Safari）：

1. 打开 `https://192.168.1.50`
2. 底部「分享」按钮 → **添加到主屏幕**

**Android**（用 Chrome）：

1. 打开 `https://192.168.1.50`
2. 右上角菜单 → **添加到主屏幕 / 安装应用**

之后从桌面图标打开，就是**全屏无地址栏**的 App 体验，还有独立图标。

---

## 给手机装证书

> **这一步不能跳过。** 不装证书的话，浏览器会拦截页面（iOS 上连"继续访问"的选项都没有），或者页面能开但**麦克风被禁用**（表现是能听不能说）。

### iPhone / iPad

> ⚠️ **两步都要做。** 只做第一步，Safari 仍然会拦截。

**第一步：安装描述文件**

1. 把 `rootCA.crt` 传到手机（AirDrop / 微信文件传输助手 / 邮件 / 网盘）
2. 在手机上**打开这个文件**，会提示「已下载描述文件」
3. 打开 **设置 → 通用 → VPN 与设备管理**
4. 在「已下载描述文件」里点 **Caddy Local Authority**
5. 右上角「安装」→ 输锁屏密码 → 再点「安装」

**第二步：开启完全信任**

1. 打开 **设置 → 通用 → 关于本机 → 证书信任设置**
2. 找到 **Caddy Local Authority**，把右侧开关**打开**
3. 顶部出现「完全信任的根证书已启用」就对了

> 第二步是 iOS 特有的。装了描述文件但没开完全信任，Safari 依然会拒绝。

### Android

1. 把 `rootCA.crt` 传到手机
2. 打开 **设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书**
   - 部分机型在 **设置 → 安全 → 更多安全设置 → 加密与凭据 → 安装证书**
   - 小米/红米：**设置 → 更多设置 → 安全 → 加密与凭据**
   - 三星：**设置 → 安全 → 加密与凭据**
3. 在文件管理器里选中 `rootCA.crt` → 确认安装
4. 输入锁屏密码

> ⚠️ 一定要选 **「CA 证书」**，不要选「VPN 和应用」或「WLAN 证书」—— 选错类型 Chrome 不会信任它。

### 给电脑装证书（Windows / macOS / Linux）

在电脑上调试时也要装，否则 Chrome 同样会报证书错误。

**Windows**

1. 双击 `rootCA.crt` → 「安装证书」
2. 选 **「本地计算机」**（需要管理员权限）→ 下一步
3. 选 **「将所有证书放入下列存储」** → 浏览 → 选 **「受信任的根证书颁发机构」**
4. 完成 → 重启浏览器

> ⚠️ **一定要选「受信任的根证书颁发机构」**。放进「个人」证书库 Chrome 不信任。

**macOS**

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ./rootCA.crt
```

**Linux（Debian/Ubuntu）**

```bash
sudo cp rootCA.crt /usr/local/share/ca-certificates/hometalker.crt
sudo update-ca-certificates
```

**Linux（Firefox）** —— Firefox 用自己的证书库，要单独导入：

```bash
# 先建库（没有的话）
mkdir -p ~/.pki/nssdb && certutil -N -d sql:$HOME/.pki/nssdb --empty-password
certutil -A -n "Caddy Local Authority" -t "C,C" \
  -i rootCA.crt -d sql:$HOME/.pki/nssdb
```

### 验证

在手机浏览器打开 `https://192.168.1.50`：

| 现象 | 结论 |
|---|---|
| 地址栏**没有**「不安全」提示，页面正常显示 | ✅ 证书装对了 |
| 提示 `ERR_CERT_AUTHORITY_INVALID` | ❌ 根 CA 没装好，或（iOS）没开完全信任 |
| 提示 `ERR_CERT_COMMON_NAME_INVALID` | ❌ `SITE_ADDR` 改过但没重启 caddy |
| 页面正常但按说话没反应 | ⚠️ 麦克风权限被拒，看[排障](#排障) |

---

## 局域网设置

### 服务器要有固定 IP

证书里写的是 IP，所以 DHCP 租约一换证书就失效了。二选一：

**方案 A：路由器做 DHCP 保留（推荐）**

在路由器管理页（一般是 `http://192.168.1.1`）找到「DHCP 服务器 → 地址保留 / 静态分配 / IP-MAC 绑定」，把服务器的 MAC 和固定 IP 绑上。

**方案 B：服务器上手动配静态 IP**

```bash
# Debian/Ubuntu (netplan)
sudo nano /etc/netplan/01-netplan.yaml
```

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: no
      addresses: [192.168.1.50/24]
      gateway: 192.168.1.1
      nameservers: {addresses: [192.168.1.1]}
```

```bash
sudo netplan apply
```

改完 IP 后：

```bash
vi .env                                    # SITE_ADDR 改成新 IP
docker compose restart caddy               # Caddy 会自动重签证书
```

**手机不用重装证书**（根 CA 没变）。

### 必须全在同一个子网，且没被隔离

- ❌ 关掉路由器的 **AP 隔离 / 客户端隔离 / 访客网络隔离**
- ❌ 别让一部分人连主 Wi-Fi、另一部分连访客网络
- 5 GHz 和 2.4 GHz 属于同一个 LAN，一般没问题；但如果路由器做了**频段隔离**（同 SSID 分不同网段）也要关掉
- 检查方法：在手机上打开 `http://<服务器IP>:8443`（明文 HTTP）—— 如果能返回 JSON，说明网络通；如果连不上就是网络层被隔离了

### 443 端口被路由器占了？

很多路由器的管理界面用 443。改 `.env`：

```ini
HTTPS_PORT=8443
```

```bash
docker compose up -d
```

手机访问 `https://192.168.1.50:8443`（端口号不参与证书校验，不影响 HTTPS）。

---

## 配置项

全部在 `.env` 里。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SITE_ADDR` | `192.168.1.50` | 内网 IP 或域名。**写进证书 SAN**，必须是手机能访问到的地址 |
| `FAMILY_CODE` | **必填** | 家庭口令，至少 4 个字符。未设置则拒绝启动 |
| `ROOM_NAME` | `home` | 房间显示名 |
| `PORT` | `8443` | server 内部监听端口（只在容器网络内） |
| `HTTPS_PORT` | `443` | 对外暴露的 HTTPS 端口 |
| `MAX_MEMBERS` | `12` | 房间人数上限 |
| `MAX_SPEAK_MS` | `60000` | 单次发言最长时长（毫秒），超时自动放麦 |
| `SPEAK_MODE` | `preempt` | `preempt` 抢占（默认）/ `exclusive` 拒绝并提示 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

改完重启：

```bash
docker compose restart server     # 改 FAMILY_CODE / ROOM_NAME / SPEAK_MODE 等
docker compose restart caddy      # 改 SITE_ADDR / HTTPS_PORT 时也要重启这个
```

---

## 日常运维

```bash
# 查看状态
docker compose ps

# 实时日志
docker compose logs -f
docker compose logs -f server        # 只看服务端
docker compose logs -f caddy         # 只看代理

# 健康检查
curl -k https://192.168.1.50/api/health
# {"ok":true,"room":"home","online":3,"uptime":86400}

# 重启
docker compose restart

# 停止（保留数据）
docker compose stop

# 重新构建并启动（改了代码之后）
docker compose up -d --build

# 查看资源占用
docker stats --no-stream
```

### 日志里能看到什么

```
19:07:22 INFO  [server] 房间 "home" 已启动，监听 :8443
19:07:25 INFO  [room] 妈妈 进入房间，当前 1 人
19:07:30 INFO  [room] 麦权变更: 无 -> <id> (acquired)
19:08:02 WARN  [room] IP 192.168.1.77 口令错误
19:08:05 INFO  [room] 爸爸 离开房间，当前 1 人
```

`LOG_LEVEL=debug` 会额外打印静态文件请求，适合排查"打不开页面"。

---

## 更新

```bash
cd hometalker
git pull
docker compose up -d --build
```

**server 是无状态的**（内存里只有当前在线成员），重启不丢数据，也不需要备份。唯一需要留着的是 `.env`。

> 重新部署后手机上如果白屏，强制刷新一下页面（Safari：长按刷新按钮 / Chrome：菜单 → 重新加载），或删掉 PWA 重新添加。服务端已经做了基于 mtime 的缓存失效校验，不会再发旧资源。

---

## 备份与迁移

需要备份的东西只有两个：

```bash
# 1. 配置（含家庭口令）
cp .env ~/hometalker.env.bak

# 2. 证书（换服务器时可以直接搬过去，手机不用重装）
docker compose cp caddy:/data/caddy/pki ./caddy-pki.bak
```

**迁移到新机器**：

最省事的做法是**重新签一张**：

```bash
# 新机器上
git clone https://github.com/wangqiang1988/hometalker.git
cd hometalker
cp ~/hometalker.env.bak .env
docker compose up -d --build
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./rootCA.crt
```

根 CA 变了，家人需要**重新装一次** `rootCA.crt`（步骤见[给手机装证书](#给手机装证书)）。反正只需要做一次。

如果不想让家人重装，可以把旧的 PKI 一起搬过去：

```bash
# 旧机器：备份
docker compose cp caddy:/data/caddy/pki ./caddy-pki.bak

# 新机器：恢复（把 pki 目录"内容"覆盖到容器的 /data/caddy/pki）
docker compose up -d
docker compose cp ./caddy-pki.bak/pki/. caddy:/data/caddy/pki/
docker compose restart caddy
```

恢复后根 CA 与原来完全一致，**家人不用重装证书**。

---

## 卸载

```bash
docker compose down            # 停止并删除容器
docker compose down -v         # 同时删掉 volume（证书也没了，手机证书失效）
rm -rf hometalker              # 删目录
```

> 删掉 volume 之后根 CA 也没了，手机上装的证书就失效了，需要重新装。

---

## 排障

### 先看浏览器到底在说什么

不同的问题，Chrome / Safari 显示的文案完全不同。**先认文案，再对症下药**（下表是实测结果）：

| 浏览器显示 | 实际原因 | 怎么办 |
|---|---|---|
| **「与 xxx 的连接不安全。该网站不支持 HTTPS。」** | 用了 `http://` 而不是 `https://`。Caddy 在 HTTPS 端口收到明文请求会返回一个合法的 HTTP 400 页面，浏览器把它当普通网页渲染 | 改成 `https://` |
| **「隐私设置错误 / 您的连接不是私密连接」** `NET::ERR_CERT_AUTHORITY_INVALID` | 根 CA 没装到设备上 | 见[给手机装证书](#给手机装证书)。**iOS 一定要开「完全信任」** |
| **「无法访问此网站」** `ERR_SSL_PROTOCOL_ERROR` | **用 IP 访问导致握手失败**。浏览器访问 IP 时不发送 SNI，反代匹配不到证书策略 | 改用主机名或域名，见[用域名代替 IP](#用域名代替-ip) |
| **「此网站无法提供安全连接」** `ERR_CERT_DATE_INVALID` | 设备时间不对 | 设置里开启自动联网校时 |
| 页面能开但**按说话没反应** | 麦克风权限被拒，或当前不是安全上下文 | 见[页面能开，但按说话没反应](#页面能开但按说话没反应) |

快速判断当前页面是不是安全上下文（决定麦克风能不能用）：

```bash
# 在浏览器控制台执行
window.isSecureContext      // 必须是 true，否则麦克风不可用
navigator.mediaDevices?.getUserMedia   // 非安全上下文下是 undefined
```

### 打不开页面

```bash
docker compose ps                    # 容器在跑吗
docker compose logs --tail=50        # 看报错
curl -k https://192.168.1.50/api/health   # 服务本身通吗
```

| 现象 | 原因 / 解决 |
|---|---|
| `curl` 不通，容器没起来 | `docker compose logs` 看错误。常见：`FAMILY_CODE` 没设置（server 拒绝启动） |
| `curl` 不通但容器正常 | 端口映射 / 防火墙。用 `docker compose port caddy 443` 确认映射 |
| 容器起来又退出 | `SITE_ADDR` 填了非法值，或 `FAMILY_CODE` 少于 4 个字符 |
| 手机打不开，电脑能打开 | 手机没在同一子网，或路由器开了 AP 隔离 |

### 页面显示「不安全」或证书错误

| 现象 | 原因 / 解决 |
|---|---|
| 「该网站不支持 HTTPS」 | 协议写错了，改用 `https://` |
| `ERR_CERT_AUTHORITY_INVALID` | 根 CA 没装好。**iOS 检查第二步「完全信任」有没有开** |
| `ERR_CERT_COMMON_NAME_INVALID` | `SITE_ADDR` 改了但没 `docker compose restart caddy` |
| `ERR_CERT_DATE_INVALID` | 手机时间不对。设置里自动联网校时 |
| `ERR_SSL_PROTOCOL_ERROR`（用 IP 访问） | 浏览器不发 SNI，握手失败。**改用主机名** |
| 换了 IP 之后打不开 | 改 `.env` 的 `SITE_ADDR` → `docker compose restart caddy` → 手机**不用**重装证书 |

### 页面能开，但按说话没反应

1. **麦克风权限被拒** —— 点地址栏的权限图标（或锁形图标）→ 允许 → 刷新页面
2. **浏览器不支持 AudioWorklet** —— 老版本浏览器，换新版
3. **不是 HTTPS** —— 只有 `https://` 和 `http://localhost` 能开麦

### 听不到别人说话

1. 手机**媒体音量**是不是静音了（静音键）？特别是 iPhone 侧边静音拨片
2. 设置里的**收听音量**滑到最大
3. 看**蓝色电平条**有没有动 —— 不动说明服务端没转发；动但不响说明是音量/输出设备问题
4. 说话人是不是戴了耳机，导致外放没声音（耳机是正常的，摘掉试试）
5. 是不是半双工被对方占着 —— 看状态条显示谁在说

### 一直显示「断线，重连中…」

```bash
docker compose logs --tail=30 server
```

1. 服务端挂了 / 重启中
2. Wi-Fi 断了，或手机切了网络
3. 服务器 IP 变了但 `.env` 没改
4. 路由器 AP 隔离

### 说话有回声

说话人戴耳机，或把手机放远一点。浏览器 AEC 能压掉大部分回声，但消不干净。

### 提示「口令错误次数过多」

连续输错 10 次会锁 60 秒。等一分钟就好，服务端重启也会立即解除。

### 其他

| 现象 | 原因 / 解决 |
|---|---|
| 重新部署后白屏 | 强制刷新页面，或删掉 PWA 重新添加 |
| 说话人看不到自己 | 成员列表只显示**其他人**，自己看状态条 |
| 别人说话我听不到，但我说话别人听得到 | 检查收听音量 + 蓝色电平条 |
| 发言中途自动停了 | 到了 `MAX_SPEAK_MS`（默认 60 秒）自动放麦，界面会提示 |
| 加到主屏幕后没有图标 | iOS 必须用 Safari 添加；Android 用 Chrome 菜单里的「安装应用」 |

---

## 进阶玩法

### 用域名代替 IP

**推荐做法，某些环境下是必需做法。**

> **为什么必须用主机名？** 浏览器访问 **IP 地址时不发送 SNI**（TLS 协议规定 SNI 里只能放 DNS 名）。
> Caddy 需要靠 SNI 匹配证书策略，空 SNI 匹配不上就直接握手失败，浏览器报 `ERR_SSL_PROTOCOL_ERROR`。
> 表现就是「用 IP 完全打不开，用域名一切正常」。

1. 在内网 DNS（路由器、AdGuard Home、Pi-hole）里加一条静态解析：`talk.home` → `192.168.1.50`
   - ⚠️ **Android Chrome 不解析 `.local`**，用 `.home` `.lan` `.internal` 这类自定义后缀，或干脆用你已有的域名
2. `.env` 里改成 `SITE_ADDR=talk.home`
3. `docker compose restart caddy`

Caddy 会自动给新域名签一张证书，**根 CA 没变，手机不用重装**。

自己验证一下握手是否正常：

```bash
# 带 SNI（用域名访问）→ 应该成功
openssl s_client -connect talk.home:443 -servername talk.home </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName

# 不带 SNI（用 IP 访问）→ 预期 alert internal error，这就是 IP 访问失败的原因
openssl s_client -connect 192.168.1.50:443 </dev/null 2>&1 | grep -E 'alert|issuer='
```

### 出门也能用（Tailscale）

如果想在单位/外面也能用：

1. 服务器和家人都装 [Tailscale](https://tailscale.com)（免费版够用）
2. 家里设备通过 Tailscale 的 `100.x.x.x` 地址访问
3. 证书用 Tailscale 自己的域名（`xxx.ts.net`），**连根 CA 都不用装** —— 它是公开信任的证书

> 注意：用 Tailscale 域名时 `SITE_ADDR` 要填 `xxx.ts.net`。此时要改 **`Caddyfile`** 里的 `tls internal` 为 `tls { issuer acme }`，让 Caddy 走 ACME 自动签 Let's Encrypt 证书（公开信任），这样连根 CA 都不用装了。
>
> ```caddy
> # Caddyfile
> https://{$SITE_ADDR} {
> 	tls { issuer acme }     # 原来是 tls internal
> 	reverse_proxy server:{$PORT}
> }
> ```

### 暴露到公网（不推荐但可行）

**本项目没有为公网做加固**（无限速、无 IP 白名单、无审计）。真要开放：

- 在前面加一层反向代理做限流和 IP 白名单
- 一定要用公网可信证书（`tls { issuer acme }`），不要用本地 CA
- 考虑换成 Tailscale / WireGuard，只让家人能访问

---

## 附：完整 `.env` 示例

```ini
# ===== 必填 =====
SITE_ADDR=192.168.1.50
FAMILY_CODE=换成你的口令

# ===== 常用可调 =====
# ROOM_NAME=home
# HTTPS_PORT=443
# MAX_MEMBERS=12
# MAX_SPEAK_MS=60000
# SPEAK_MODE=preempt
# LOG_LEVEL=info
```
