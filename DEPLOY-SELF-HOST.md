# 自托管部署方案（韩国服务器镜像）

> 状态：**方案已定型，暂缓实施**（2026-08-29）。当前线上主站仍是 GitHub Pages：
> https://cfyofjackie.github.io/mini-chess-games/
>
> 背景：GitHub Pages（github.io）在国内直连不稳定，需要国内可达的镜像。腾讯云 EdgeOne 国内站
> 因实名认证门槛（需身份证/地址）搁置；决定复用已有韩国服务器自托管。

## 方案要点

- 部署物是**纯静态文件**（`dist/`），无后端、无数据库、无可注入逻辑，攻击面极小
- 与服务器上已有的 **Hermes agent（Docker）严格隔离**：独立 nginx 容器、只读挂载、资源限额、零共享卷/socket
- 只开放必要端口（80/443 或自定义端口），顺带完成一次**全机端口体检**保护 Hermes

## 前置条件

- 服务器：SSH 可登录、Docker 可用（`docker -v`）
- 本地：Node 环境（项目开发机已有）

## 第 1 步：安全体检（保护 Hermes，与是否部署无关，强烈建议做）

在服务器上执行：

```bash
sudo ss -tlnp | grep LISTEN
sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

**高危裸露判读表**（输出中出现即需处理）：

| 端口 | 是什么 | 风险 | 处置 |
|------|--------|------|------|
| 2375/2376 | Docker API | 被扫到 ≈ 服务器送人 | 立即关闭，Docker 必须走 unix socket |
| 6379 | Redis | 未设密码可被写入 crontab | 绑定 127.0.0.1 或加密码 |
| 3306/5432 | MySQL/Postgres | 弱口令爆破 | 只绑内网/127.0.0.1 |
| 8080/9000/9090 等 | 各类管理面板 | 弱口令登入 | 加认证或仅内网访问 |
| 22 | SSH | 密码爆破 | 改密钥登录，禁用密码认证 |

顺带检查 SSH 是否允许密码登录：`sudo sshd -T | grep -i passwordauth`（期望 `no`）。

## 第 2 步：构建并上传（本地开发机）

```bash
cd D:/dev/peg-solitaire
npm run build
ssh 你的用户名@服务器IP "mkdir -p /opt/mini-chess-games"
scp -r dist/* 你的用户名@服务器IP:/opt/mini-chess-games/
```

> 站点构建使用相对路径（`base: './'`）+ hash 路由，放在任何 IP/端口/子路径下都能直接跑。

## 第 3 步：容器部署（在服务器上）

```bash
docker run -d --name mini-chess --restart unless-stopped \
  -p 8080:80 \
  -v /opt/mini-chess-games:/usr/share/nginx/html:ro \
  --memory 256m --cpus 0.5 \
  nginx:alpine
```

隔离说明：
- `:ro` 只读挂载——容器内进程改不了游戏文件，更碰不到别处
- `--memory/--cpus` 资源上限——被刷流量也饿不死 Hermes
- 与 Hermes 容器无任何共享卷、端口、socket

若宿主机 80 端口空闲，可把 `-p 8080:80` 换成 `-p 80:80`。

## 第 4 步：放行端口 + 国内裸连实测

1. 云厂商控制台 → 安全组/防火墙放行所选端口（网页操作）
2. 本地开发机测试（`--noproxy` 强制不走代理，测真实直连）：

```bash
curl --noproxy "*" -o /dev/null -s \
  -w "状态 %{http_code} | 连接耗时 %{time_connect}s | 总耗时 %{time_total}s\n" \
  http://服务器IP:8080/
```

**判读标准**：总耗时 < 1s 很好；1–3s 可玩（晚高峰可能波动）；超时 → 切换备选方案。

## 回滚

```bash
docker rm -f mini-chess
rm -rf /opt/mini-chess-games
```

对服务器上其他一切零影响。

## 日常更新

```bash
npm run build && scp -r dist/* 你的用户名@服务器IP:/opt/mini-chess-games/
```

（静态文件即传即生效，无需重启容器；如后续加了 nginx 配置才需要 `docker restart mini-chess`）

## 备选平台对比（国内可达性视角）

| 平台 | 免实名 | 免费 | 国内直连 | 结论 |
|------|--------|------|----------|------|
| 韩国服务器自托管 | ✅ | 已有 | 待实测（本文档第 4 步） | **首选** |
| EdgeOne Pages 国内站 | ❌ 需实名+地址 | ✅ | ✅ 优 | 因实名门槛搁置 |
| EdgeOne Pages 国际版（edgeone.ai） | ✅ | ✅ | ⚠️ 不确定 | 备选 |
| Cloudflare Pages | ✅ | ✅ | ⚠️ 时好时坏 | 备选 |
| Gitee Pages | — | — | — | 已停服多年，排除 |

## 后续可选增强

- HTTPS：加一个 Caddy 容器（自动签证书），把 `mini-chess` 挂到域名下
- 部署脚本化：把第 2、3 步写成 `scripts/deploy-korea.sh` 一键执行
- 若未来需要服务国内大量用户：备案 + 国内 CDN 才是正解（成本高，现阶段不需要）
