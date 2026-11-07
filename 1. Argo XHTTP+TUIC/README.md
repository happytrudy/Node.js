# xHTTP + TUIC 部署

此目录使用 sing-box v1.14.4 内置的 `cloudflared` 入站运行固定隧道，不再下载或启动独立的 cloudflared 程序。Xray 继续提供本地 xHTTP 回源，TUIC 和 ACME 证书由 sing-box 处理。

## 固定隧道设置

设置以下环境变量后启动 `start.sh`：

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `ARGO_PORT` | Xray 本地回源端口 | `8001` |
| `ARGO_DOMAIN` | 固定隧道的公网域名 | 无 |
| `ARGO_AUTH` | Cloudflare 固定隧道的 Connector Token | 无 |
| `ARGO_PROTOCOL` | 隧道协议：`http2` 或 `quic` | `quic` |
| `ARGO_CONNECTIONS` | 隧道连接数，必须为正整数 | `1` |

在 Cloudflare 固定隧道的公网域名配置中，将服务指向 `http://127.0.0.1:8001`；修改 `ARGO_PORT` 后，服务端口也需同步修改。`ARGO_AUTH` 使用完整的 Connector Token，不是 DNS API Token。

只有端口、域名和 Token 均配置完整时才启用固定隧道，不提供临时隧道。隧道边缘连接使用 IPv4。原有 xHTTP H3 订阅格式保留。

## TUIC 设置

设置 `TUIC_PORT` 以启用 TUIC，并提供 `CERT_DOMAIN` 和 `CF_API_TOKEN`；`ACME_EMAIL` 可选。证书通过 Cloudflare DNS-01 自动申请和续期，不使用自签证书。只启用固定隧道时无需配置这些证书变量。

## 日志和进程

sing-box 的 DNS 策略保持 `prefer_ipv4`，日志级别保持 `panic`。启动前仍执行 `sing-box check`。固定隧道随 sing-box 进程一起启动和恢复，不再单独监控 cloudflared 进程，也不再解析其边缘节点日志。更新后重启脚本，会清理此目录工作路径中的旧 `bot` 二进制文件。
