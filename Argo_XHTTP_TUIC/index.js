"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const readline = require("node:readline");
const { spawn, execFileSync } = require("node:child_process");

// ========= shoes TUIC + Argo XHTTP 固定隧道配置 =========
const TUIC_PORT = ""; // TUIC UDP 直连端口，留空表示关闭
const ARGO_DOMAIN = ""; // Cloudflare Tunnel Public Hostname
const ARGO_AUTH = ""; // Cloudflare Named Tunnel Token
const CERT_DOMAIN = ""; // TUIC 证书域名，必须托管在 Cloudflare
const CF_API_TOKEN = ""; // Zone:Read + DNS:Edit API Token
// ========= 配置结束 =========

const ROOT = __dirname;
const ARGO_PORT = "8001";
const ARGO_PROTOCOL = "quic";
const ARGO_CONNECTIONS = "1";
const ACME_DIRECTORY_URL = "https://acme-v02.api.letsencrypt.org/directory";
const DATA_DIR = path.join(ROOT, ".tmp");
const SHOES_BIN = path.join(ROOT, "shoes-x86_64-unknown-linux-musl");
const CLOUDFLARED_BIN = path.join(DATA_DIR, "cloudflared");
const CONFIG_PATH = path.join(DATA_DIR, "shoes.yaml");
const URL_PATH = path.join(ROOT, "sub.txt");
const UUID = "";
const TUIC_PASSWORD = "";
const XHTTP_PATH = "";
const CFIP = "www.teamviewer.com";
const CFPORT = "443";
const SERVER_IP = "";
const ARCHIVE_URL = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
const EDGE_NAMES = {
  HKG: "香港", TPE: "台湾", NRT: "东京", HND: "东京", KIX: "大阪", ICN: "韩国",
  SIN: "新加坡", BKK: "泰国", MNL: "菲律宾", SGN: "越南", LAX: "洛杉矶",
  DFW: "达拉斯", SJC: "圣何塞", SEA: "西雅图", JFK: "纽约", ORD: "芝加哥",
  LHR: "伦敦", FRA: "法兰克福", CDG: "巴黎", AMS: "阿姆斯特丹", HEL: "赫尔辛基",
};

const log = (message) => process.stdout.write(`${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
let shoesChild;
let tunnelChild;
let retryTimers = new Set();

function value(env, name, fallback = "") {
  return String(env[name] ?? fallback).trim();
}

function parsePort(raw, name, { optional = false } = {}) {
  const input = String(raw ?? "").trim();
  if (optional && (input === "" || input === "0")) return null;
  if (!/^\d+$/.test(input)) throw new Error(`${name} must be an integer port`);
  const port = Number(input);
  if (port < 1 || port > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

function validateDnsName(host, name) {
  if (!host || host.length > 253 || host.startsWith("*.") || host.endsWith(".")) {
    throw new Error(`${name} must be a concrete DNS hostname`);
  }
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2 || labels.some((label) =>
    label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error(`${name} must be a valid DNS hostname`);
  }
  return host.toLowerCase();
}

function validUuid(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

function buildConfig(env, { filePath, uuid, tuicPassword } = {}) {
  const fileRoot = path.resolve(filePath || value(env, "FILE_PATH", ".tmp"));
  const certDomain = value(env, "CERT_DOMAIN");
  const cfToken = value(env, "CF_API_TOKEN");
  const directoryUrl = value(env, "ACME_DIRECTORY_URL", "https://acme-v02.api.letsencrypt.org/directory");
  const tuicPort = parsePort(value(env, "TUIC_PORT"), "TUIC_PORT", { optional: true });
  const argoPort = parsePort(value(env, "ARGO_PORT", "8001"), "ARGO_PORT");
  const argoDomain = value(env, "ARGO_DOMAIN");
  const argoToken = value(env, "ARGO_AUTH");
  if (Boolean(argoDomain) !== Boolean(argoToken)) throw new Error("ARGO_DOMAIN and ARGO_AUTH must be set together");
  const enableTuic = tuicPort !== null;
  const enableArgo = Boolean(argoDomain && argoToken);
  if (!enableTuic && !enableArgo) throw new Error("Set TUIC_PORT and/or both ARGO_DOMAIN and ARGO_AUTH");

  let clientUuid = uuid || value(env, "UUID") || crypto.randomUUID();
  if (!validUuid(clientUuid)) throw new Error("UUID must be a valid UUID v4");
  clientUuid = clientUuid.toLowerCase();
  let password = tuicPassword || value(env, "TUIC_PASSWORD");
  if (enableTuic && !password) password = crypto.randomBytes(24).toString("base64url");
  if (enableTuic && /[\r\n]/.test(password)) throw new Error("TUIC_PASSWORD must not contain newlines");

  const config = [];
  if (enableTuic) {
    validateDnsName(certDomain, "CERT_DOMAIN");
    if (!cfToken) throw new Error("TUIC requires CF_API_TOKEN");
    let directory;
    try { directory = new URL(directoryUrl); } catch { throw new Error("ACME_DIRECTORY_URL must be an absolute URL"); }
    if (!/^https?:$/.test(directory.protocol)) throw new Error("ACME URLs must use HTTP(S)");
    config.push({
      certificate_source: "tuic-acme", type: "acme", domains: [certDomain],
      directory_url: directoryUrl, state_dir: path.join(fileRoot, "certificates"),
      challenge: { type: "dns01", provider: "cloudflare", api_token: cfToken },
    });
    config.push({
      address: `[::]:${tuicPort}`, transport: "quic",
      quic_settings: { certificate_source: "tuic-acme" },
      protocol: { type: "tuic", uuid: clientUuid, password, zero_rtt_handshake: false },
      rules: ["allow-all-direct"],
    });
  }
  if (enableArgo) {
    validateDnsName(argoDomain, "ARGO_DOMAIN");
    const xhttpPath = value(env, "XHTTP_PATH") || `/${clientUuid}-xhttp`;
    if (!xhttpPath.startsWith("/") || /[\s\r\n?#]/.test(xhttpPath)) throw new Error("XHTTP_PATH must start with / and contain no whitespace, query, or fragment");
    const argoProtocol = value(env, "ARGO_PROTOCOL", "quic").toLowerCase();
    if (argoProtocol !== "quic") throw new Error("ARGO_PROTOCOL must be quic");
    const argoConnections = Number(value(env, "ARGO_CONNECTIONS", "1"));
    if (!Number.isInteger(argoConnections) || argoConnections < 1 || argoConnections > 4) throw new Error("ARGO_CONNECTIONS must be an integer from 1 to 4");
    config.push({
      address: `127.0.0.1:${argoPort}`,
      protocol: { type: "xhttp", path: xhttpPath, mode: "auto", protocol: { type: "vless", user_id: clientUuid } },
      rules: ["allow-all-direct"],
    });
  }
  return {
    config, uuid: clientUuid, tuicPassword: password, enableTuic, enableArgo,
    tuicPort, argoPort, argoDomain: enableArgo ? validateDnsName(argoDomain, "ARGO_DOMAIN") : "",
    xhttpPath: value(env, "XHTTP_PATH") || `/${clientUuid}-xhttp`,
    certDomain: enableTuic ? validateDnsName(certDomain, "CERT_DOMAIN") : "",
    argoToken, argoProtocol: value(env, "ARGO_PROTOCOL", "quic").toLowerCase(),
    argoConnections: Number(value(env, "ARGO_CONNECTIONS", "1")),
  };
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function ensureShoesExecutable() {
  if (!fs.existsSync(SHOES_BIN)) {
    throw new Error(`内置 shoes 程序不存在：${SHOES_BIN}`);
  }
  try {
    fs.chmodSync(SHOES_BIN, 0o755);
    const mode = fs.statSync(SHOES_BIN).mode & 0o777;
    if ((mode & 0o111) === 0) throw new Error("执行位设置后仍未生效");
    log(`[shoes] 已设置可执行权限：${SHOES_BIN} (${mode.toString(8)})`);
  } catch (error) {
    throw new Error(`设置 shoes 可执行权限失败：${error.code || error.message}；${SHOES_BIN}`);
  }
}

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

function readOrCreateSecret(file, envValue, create) {
  const supplied = String(envValue || "").trim();
  if (supplied) return supplied;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const generated = create();
  writePrivate(file, `${generated}\n`);
  return generated;
}

function getIdentity() {
  const uuid = readOrCreateSecret(path.join(DATA_DIR, "uuid.txt"), UUID, () => crypto.randomUUID());
  const password = readOrCreateSecret(path.join(DATA_DIR, "tuic_password.txt"), TUIC_PASSWORD, () => crypto.randomBytes(24).toString("base64url"));
  return { uuid, password };
}

function hostPort(raw, defaultPort) {
  const port = Number.parseInt(String(raw || defaultPort), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CFPORT must be between 1 and 65535");
  return port;
}

function fetchPublicIp() {
  const override = String(SERVER_IP || "").trim();
  if (override) return Promise.resolve(override);
  const requestIp = (url) => new Promise((resolve, reject) => {
    https.get(url, { timeout: 4000, headers: { "User-Agent": "Argo_XHTTP_TUIC/shoes" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => response.statusCode === 200 && body.trim() ? resolve(body.trim()) : reject(new Error("public IP lookup failed")));
    }).on("timeout", function onTimeout() { this.destroy(new Error("public IP lookup timed out")); }).on("error", reject);
  });
  return requestIp("https://api.ipify.org")
    .catch(() => requestIp("https://ipv4.icanhazip.com"))
    .catch(() => "127.0.0.1");
}

function followRedirect(url, response, remaining = 8) {
  if (remaining <= 0) {
    response.resume();
    return Promise.reject(new Error("too many redirects while downloading cloudflared"));
  }
  const location = response.headers.location;
  response.resume();
  if (!location) throw new Error(`download failed: HTTP ${response.statusCode}`);
  const next = new URL(location, url);
  if (next.protocol !== "https:") throw new Error("download redirect must remain HTTPS");
  return downloadCloudflared(next, remaining - 1);
}

function downloadCloudflared(url, remaining = 8) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "Argo_XHTTP_TUIC/shoes" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        followRedirect(url, response, remaining).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`cloudflared download returned HTTP ${response.statusCode}`));
        return;
      }
      const output = fs.createWriteStream(`${CLOUDFLARED_BIN}.part`, { mode: 0o700 });
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 100 * 1024 * 1024) request.destroy(new Error("cloudflared download exceeds 100 MiB"));
      });
      response.pipe(output);
      output.on("finish", () => output.close(() => {
        try {
          fs.renameSync(`${CLOUDFLARED_BIN}.part`, CLOUDFLARED_BIN);
          fs.chmodSync(CLOUDFLARED_BIN, 0o700);
          resolve();
        } catch (error) { reject(error); }
      }));
      output.on("error", reject);
    });
    request.on("error", (error) => {
      try { fs.rmSync(`${CLOUDFLARED_BIN}.part`, { force: true }); } catch {}
      reject(error);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("cloudflared download timed out")));
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED_BIN)) return;
  log("正在下载 Cloudflared（shoes 已内置，不会下载 shoes）...");
  await downloadCloudflared(new URL(ARCHIVE_URL));
}

function scheduleRetry(callback, delay, label) {
  if (stopping) return;
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    Promise.resolve().then(callback).catch((error) => log(`[${label}] ${error.message}`));
  }, delay);
  retryTimers.add(timer);
}

function attachLogs(child, label, { lines = false } = {}) {
  if (lines) {
    const reader = readline.createInterface({ input: child.stderr });
    reader.on("line", (line) => {
      const clean = line.replace(/\u001b\[[0-9;]*m/g, "");
      const region = clean.match(/(?:location|region)["=:\s]+([a-zA-Z0-9]{3,4})/i)
        || clean.match(/Registered tunnel connection.*?\b([A-Z0-9]{3,4})\b/i);
      if (region) {
        const code = region[1].toUpperCase();
        const name = EDGE_NAMES[code.replace(/[0-9]/g, "")] || code;
        log(`[Argo] 已连接 Cloudflare 边缘节点 ${code}（${name}）`);
      }
    });
  } else {
    child.stdout?.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  }
  child.on("error", (error) => log(`[${label}] 进程启动失败：${error.message}`));
}

function spawnShoes(configPath) {
  if (stopping) return;
  if (!fs.existsSync(SHOES_BIN)) throw new Error(`内置 shoes 程序不存在：${SHOES_BIN}`);
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("当前内置 shoes 是 x86_64-unknown-linux-musl 版本，只能在 Linux x86_64 运行");
  }
  log("启动内置 shoes ...");
  shoesChild = spawn(SHOES_BIN, [configPath], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  attachLogs(shoesChild, "shoes");
  shoesChild.on("exit", (code, signal) => {
    shoesChild = undefined;
    if (stopping) return;
    log(`[警告] shoes 已退出（code=${code}, signal=${signal}），3 秒后重启`);
    scheduleRetry(() => spawnShoes(configPath), 3000, "shoes");
  });
}

function checkShoes(configPath) {
  try {
    fs.chmodSync(SHOES_BIN, 0o755);
  } catch (error) {
    throw new Error(`无法设置 shoes 执行权限：${error.code || error.message}；路径 ${SHOES_BIN}`);
  }
  log(`[shoes] 校验配置：${configPath}`);
  try {
    const output = execFileSync(SHOES_BIN, ["check", configPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env,
      timeout: 30000, maxBuffer: 1024 * 1024,
    });
    if (output.trim()) log(`[shoes check] ${output.trim()}`);
    log("[shoes] 配置校验通过");
  } catch (error) {
    if (error.stdout) log(`[shoes check stdout] ${String(error.stdout).trim()}`);
    if (error.stderr) log(`[shoes check stderr] ${String(error.stderr).trim()}`);
    const details = `code=${error.code ?? "none"}, exit=${error.status ?? "none"}, signal=${error.signal ?? "none"}`;
    const hint = error.code === "EACCES"
      ? "服务器禁止执行该文件（请检查文件权限和挂载目录是否 noexec）"
      : error.code === "ENOENT"
        ? "找不到 shoes 可执行文件或其执行环境"
        : error.signal ? "shoes 在校验期间被信号终止，尚不能判定为配置错误" : "请检查上方 shoes 的具体错误";
    throw new Error(`shoes 校验未完成：${details}；${hint}；程序 ${SHOES_BIN}`);
  }
}

function spawnTunnel(settings) {
  if (stopping) return;
  const args = [
    "tunnel", "--no-autoupdate", "--retries", "5", "--grace-period", "1s",
    "--protocol", settings.argoProtocol, "--ha-connections", String(settings.argoConnections), "run",
  ];
  log("启动 Cloudflare 固定隧道（QUIC）...");
  tunnelChild = spawn(CLOUDFLARED_BIN, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, TUNNEL_TOKEN: settings.argoToken },
  });
  attachLogs(tunnelChild, "cloudflared", { lines: true });
  tunnelChild.on("exit", (code, signal) => {
    tunnelChild = undefined;
    if (stopping) return;
    log(`[警告] cloudflared 已退出（code=${code}, signal=${signal}），3 秒后重连`);
    scheduleRetry(() => spawnTunnel(settings), 3000, "cloudflared");
  });
}

function buildLinks(settings, publicIp, cfIp, cfPort) {
  const links = [];
  if (settings.enableTuic) {
    const query = new URLSearchParams({ sni: settings.certDomain, alpn: "h3", congestion_control: "bbr", udp_relay_mode: "native" });
    links.push(`tuic://${encodeURIComponent(settings.uuid)}:${encodeURIComponent(settings.tuicPassword)}@${uriHost(publicIp)}:${settings.tuicPort}?${query.toString()}#TUIC-shoes`);
  }
  if (settings.enableArgo) {
    const query = new URLSearchParams({
      encryption: "none", security: "tls", alpn: "h3", sni: settings.argoDomain,
      fp: "chrome", type: "xhttp", mode: "auto", host: settings.argoDomain, path: settings.xhttpPath,
    });
    links.push(`vless://${settings.uuid}@${uriHost(cfIp)}:${cfPort}?${query.toString()}#Argo-XHTTP-shoes`);
  }
  return links;
}

function uriHost(host) {
  const value = String(host).trim();
  if (!value || /[\s/@?#]/.test(value)) throw new Error("CFIP/SERVER_IP must be an IP address or DNS hostname");
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function writeSubscription(links) {
  const text = `${Buffer.from(links.join("\n")).toString("base64")}\n`;
  ensurePrivateDir(path.dirname(URL_PATH));
  writePrivate(URL_PATH, text);
  log(`[链接] Base64 订阅已写入 ${URL_PATH}`);
  log("===================== Base64 subscription =====================");
  log(text.trim());
  log("===============================================================");
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`[退出] 收到 ${signal}，停止子进程`);
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers.clear();
  const children = [shoesChild, tunnelChild].filter(Boolean);
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  await Promise.race([Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve)))), sleep(5000)]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  process.exit(0);
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("该工程内置 x86_64-unknown-linux-musl 版 shoes，只支持 Linux x86_64");
  }
  const hasTuic = Boolean(String(TUIC_PORT).trim());
  const hasArgoDomain = Boolean(String(ARGO_DOMAIN).trim());
  const hasArgoToken = Boolean(String(ARGO_AUTH).trim());
  if (hasArgoDomain !== hasArgoToken) throw new Error("ARGO_DOMAIN 和 ARGO_AUTH 必须同时配置");
  if (!hasTuic && !hasArgoDomain) throw new Error("请在 index.js 顶部配置 TUIC_PORT，或同时配置 ARGO_DOMAIN 与 ARGO_AUTH");
  ensureShoesExecutable();
  ensurePrivateDir(DATA_DIR);
  const identity = getIdentity();
  const settings = buildConfig({
    TUIC_PORT,
    CERT_DOMAIN,
    CF_API_TOKEN,
    ACME_DIRECTORY_URL,
    TUIC_PASSWORD,
    UUID,
    ARGO_PORT,
    ARGO_DOMAIN,
    ARGO_AUTH,
    ARGO_PROTOCOL,
    ARGO_CONNECTIONS,
    XHTTP_PATH,
  }, {
    filePath: DATA_DIR,
    uuid: identity.uuid,
    tuicPassword: identity.password,
  });
  if (settings.enableTuic) {
    const source = settings.config.find((entry) => entry.type === "acme");
    source.terms_of_service = await fetchAcmeTerms(source.directory_url);
  }
  const configText = `${JSON.stringify(settings.config, null, 2)}\n`;
  writePrivate(CONFIG_PATH, configText);
  checkShoes(CONFIG_PATH);

  if (settings.enableArgo && !settings.argoToken) throw new Error("ARGO_AUTH must be a Cloudflare named-tunnel token");
  if (settings.enableArgo) await ensureCloudflared();
  const publicIp = settings.enableTuic ? await fetchPublicIp() : "";
  const cfIp = String(CFIP || "www.teamviewer.com").trim();
  const cfPort = hostPort(CFPORT, 443);
  const links = buildLinks(settings, publicIp, cfIp, cfPort);

  log(`[初始化] shoes 配置已写入：${CONFIG_PATH}`);
  if (settings.enableTuic) log(`[TUIC] QUIC 监听端口 ${settings.tuicPort}；证书由 shoes Cloudflare DNS-01 provider 管理`);
  if (settings.enableArgo) log(`[Argo] xHTTP/VLESS 回源 127.0.0.1:${settings.argoPort}，路径 ${settings.xhttpPath}`);
  writeSubscription(links);

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  spawnShoes(CONFIG_PATH);
  if (settings.enableArgo) spawnTunnel(settings);
  process.stdin.resume();
}

function fetchAcmeTerms(directoryUrl) {
  return new Promise((resolve, reject) => {
    const request = https.get(directoryUrl, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`读取 ACME directory 失败：HTTP ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error("ACME directory 响应过大"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const terms = JSON.parse(body).meta?.termsOfService;
          if (terms !== undefined && (typeof terms !== "string" || new URL(terms).protocol !== "https:")) {
            throw new Error("ACME directory 返回无效条款地址");
          }
          if (terms) log(`[ACME] 自动使用 CA 当前服务条款：${terms}`);
          resolve(terms);
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    const timer = setTimeout(() => request.destroy(new Error("读取 ACME directory 超时")), 15000);
    request.on("close", () => clearTimeout(timer));
  });
}

module.exports = { buildConfig, parsePort, validUuid, fetchAcmeTerms, checkShoes };

if (require.main === module) {
  main().catch((error) => {
    log(`[启动失败] ${error.message}`);
    process.exitCode = 1;
  });
}
