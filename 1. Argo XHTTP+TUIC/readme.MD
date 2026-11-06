## 📦 翼龙面板 Node.js 环境部署指南 (内存 > 100MB)

### ✨ 核心特性

* **xHTTP特性**：上下行分离，抗封锁全新升级，h3(UDP)突破晚高峰TCP拥塞。
* **Argo隧道**：固定使用 QUIC；Cloudflare CDN边缘节点可见。
* **自适应**：自动识别容器内存，匹配最佳部署方案。
* **安全性**：自动生成 UUID/32位密码，重启复用。
* **优化**：6级自适应匹配 + 主动内存回收机制。

---

### 1. 固定隧道+TUIC部署流程（不支持临时隧道！）

1. 将 `start.sh`、`index.js` 和 `package.json` 上传至面板服务器根目录。
2. 变量设置区域，填入 **固定隧道域名 (`ARGO_DOMAIN`)** 与 **Token (`ARGO_AUTH`)**。
3. Argo 回源固定使用 QUIC，客户端仅生成 xHTTP H3 节点。
4. 填入TUIC端口号。
5. 开机。

> [!NOTE]
> Argo 已移除 xHTTP HTTP/2 节点，固定使用 xHTTP H3。

### 2. TUIC 证书配置

TUIC 不再使用自签证书，启动前设置以下环境变量：

* `CERT_DOMAIN`：用于 TUIC TLS 的真实域名，必须已托管在 Cloudflare。
* `CF_API_TOKEN`：Cloudflare API Token，至少需要对应 Zone 的 DNS 编辑权限及 Zone 读取权限。
* `ACME_EMAIL`：ACME 账户邮箱，可选。

证书由 sing-box `certProvider` 通过 Cloudflare DNS-01 自动申请和续期。
