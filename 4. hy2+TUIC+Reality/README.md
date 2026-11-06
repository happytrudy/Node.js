### 适配翼龙面板node.js环境
  
* Sing-box架构

* uuid自动生成

* UDP+TCP组合
  
* 自动重启：每天凌晨00:03自动执行一次Sing-box重启，清除缓存
  
### 1.使用步骤：

* start.sh+index.js+package.json上传至服务器

* 输入tuic/hy2/vless端口，保存

* 开机

### 2.低配服务器使用说明
（如freecloudpanel：64MB内存+64MB磁盘）：

* 建议只部署tuic/hy2/reality其中1个节点

### 3. TUIC/Hysteria2 证书配置

TUIC 与 Hysteria2 不再使用自签证书，启动前设置：

* `CERT_DOMAIN`：用于 TLS 的真实域名，必须已托管在 Cloudflare。
* `CF_API_TOKEN`：Cloudflare API Token，至少需要对应 Zone 的 DNS 编辑权限及 Zone 读取权限。
* `ACME_EMAIL`：ACME 账户邮箱，可选。

证书由 sing-box `certProvider` 通过 Cloudflare DNS-01 自动申请和续期；仅启用 Reality 时无需配置这些变量。
