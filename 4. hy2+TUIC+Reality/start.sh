#!/bin/bash
set -e

# ================== 端口设置 ==================

export TUIC_PORT=${TUIC_PORT:-""}                     # 填入tuic节点端口

export HY2_PORT=${HY2_PORT:-""}                       # 填入hy2节点端口

export REALITY_PORT=${REALITY_PORT:-""}               # 填入reality节点端口（UDP/TCP可以共用1个端口）

export CERT_DOMAIN=${CERT_DOMAIN:-""}                 # ACME 证书域名（必须托管在 Cloudflare）
export CF_API_TOKEN=${CF_API_TOKEN:-${CF_DNS_API_TOKEN:-""}} # Cloudflare DNS 编辑 API Token
export ACME_EMAIL=${ACME_EMAIL:-""}                   # ACME 账户邮箱（可选）

# ==============================================


cd "$(dirname "$0")"
export FILE_PATH="${PWD}/.npm"
export DATA_PATH="${PWD}/singbox_data"
mkdir -p "$FILE_PATH" "$DATA_PATH"
rm -f "${FILE_PATH}/cert.pem" "${FILE_PATH}/private.key"
export XDG_DATA_HOME="/tmp/.singbox_data"
export XDG_CACHE_HOME="/tmp/.singbox_cache"
export TMPDIR="/tmp"
rm -rf "${FILE_PATH}"/sb_* ~/.npm/_logs/* ./npm-debug.log* "${DATA_PATH}"/* /tmp/.singbox_* 2>/dev/null || true

UUID_FILE="${FILE_PATH}/uuid.txt"
if [ -f "$UUID_FILE" ]; then
  UUID=$(cat "$UUID_FILE")
  echo -e "\e[1;33m[UUID] 复用固定 UUID: $UUID\e[0m"
else
  UUID=$(cat /proc/sys/kernel/random/uuid)
  echo "$UUID" > "$UUID_FILE"
  chmod 600 "$UUID_FILE"
  echo -e "\e[1;32m[UUID] 首次生成并永久保存: $UUID\e[0m"
fi

[ ! -d "${FILE_PATH}" ] && mkdir -p "${FILE_PATH}"

SINGBOX_VER="1.14.4"

ARCH=$(uname -m)
DOWNLOAD_URL=""

if [[ "$ARCH" == "arm"* ]] || [[ "$ARCH" == "aarch64" ]]; then
  DOWNLOAD_URL="https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-arm64.tar.gz"
elif [[ "$ARCH" == "amd64"* ]] || [[ "$ARCH" == "x86_64" ]]; then
  DOWNLOAD_URL="https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-amd64.tar.gz"
elif [[ "$ARCH" == "s390x" ]]; then
  DOWNLOAD_URL="https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-s390x.tar.gz"
else
  echo "不支持的架构: $ARCH"
  exit 1
fi

download_file() {
  local URL=$1
  local FILENAME=$2
  if command -v curl >/dev/null 2>&1; then
    curl -L -sS -o "$FILENAME" "$URL" && echo -e "\e[1;32m下载 $FILENAME (curl)\e[0m"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$FILENAME" "$URL" && echo -e "\e[1;32m下载 $FILENAME (wget)\e[0m"
  else
    echo -e "\e[1;31m未找到 curl 或 wget\e[0m"
    exit 1
  fi
}

SINGBOX_BIN="${FILE_PATH}/sb_core"
SINGBOX_VERSION_FILE="${FILE_PATH}/singbox.version"
if [ ! -f "$SINGBOX_VERSION_FILE" ] || [ "$(cat "$SINGBOX_VERSION_FILE" 2>/dev/null)" != "$SINGBOX_VER" ]; then
  rm -f "$SINGBOX_BIN"
fi
if [ ! -f "$SINGBOX_BIN" ]; then
  echo -e "\e[1;33m[下载] 未检测到 Sing-box 核心，正在下载最新版本 v${SINGBOX_VER}...\e[0m"
  download_file "$DOWNLOAD_URL" "${FILE_PATH}/singbox.tar.gz"
  tar -zxvf "${FILE_PATH}/singbox.tar.gz" -C "${FILE_PATH}" --strip-components=1 "sing-box-${SINGBOX_VER}-linux-"*/sing-box >/dev/null 2>&1 || \
  tar -zxvf "${FILE_PATH}/singbox.tar.gz" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1 >/dev/null 2>&1
  mv "${FILE_PATH}/sing-box" "$SINGBOX_BIN" 2>/dev/null || true
  rm -f "${FILE_PATH}/singbox.tar.gz"
  chmod +x "$SINGBOX_BIN"
  printf '%s\n' "$SINGBOX_VER" > "$SINGBOX_VERSION_FILE"
  chmod 600 "$SINGBOX_VERSION_FILE"
else
  echo -e "\e[1;32m[核心] 已存在 Sing-box 核心，跳过下载\e[0m"
fi

if [ "$REALITY_PORT" != "" ] && [ "$REALITY_PORT" != "0" ]; then
  KEY_FILE="${FILE_PATH}/key.txt"
  if [ -f "$KEY_FILE" ]; then
    echo -e "\e[1;33m[密钥] 检测到已有密钥，复用...\e[0m"
    private_key=$(grep "PrivateKey:" "$KEY_FILE" | awk '{print $2}')
    public_key=$(grep "PublicKey:" "$KEY_FILE" | awk '{print $2}')
  else
    echo -e "\e[1;33m[密钥] 首次生成 Reality 密钥对...\e[0m"
    output=$("$SINGBOX_BIN" generate reality-keypair)
    echo "$output" > "$KEY_FILE"
    private_key=$(echo "$output" | awk '/PrivateKey:/ {print $2}')
    public_key=$(echo "$output" | awk '/PublicKey:/ {print $2}')
    chmod 600 "$KEY_FILE"
    echo -e "\e[1;32m[密钥] 密钥已保存，重启后保持不变\e[0m"
  fi
fi

if { [ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ]; } || { [ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ]; }; then
  if [ -z "$CERT_DOMAIN" ] || [ -z "$CF_API_TOKEN" ]; then
    echo "缺少 CERT_DOMAIN 或 CF_API_TOKEN，TUIC/Hysteria2 无法启用 ACME DNS-01 证书" >&2
    exit 1
  fi
  mkdir -p "${FILE_PATH}/certificates"
fi

CERTIFICATE_PROVIDER_JSON=""
if { [ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ]; } || { [ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ]; }; then
  ACME_EMAIL_JSON=""
  if [ -n "$ACME_EMAIL" ]; then
    ACME_EMAIL_JSON=$(printf ',\n    "email": "%s"' "$ACME_EMAIL")
  fi
  CERTIFICATE_PROVIDER_JSON=$(cat <<CERT_PROVIDER_EOF
  "certificate_providers": [{
    "type": "acme",
    "tag": "acme",
    "domain": ["$CERT_DOMAIN"],
    "data_directory": "${FILE_PATH}/certificates",
    "disable_http_challenge": true,
    "disable_tls_alpn_challenge": true,
    "dns01_challenge": {
      "provider": "cloudflare",
      "api_token": "$CF_API_TOKEN"
    }${ACME_EMAIL_JSON}
  }],
CERT_PROVIDER_EOF
)
fi

INBOUNDS=()

if [ -n "$TUIC_PORT" ] && [ "$TUIC_PORT" != "0" ]; then
  INBOUNDS+=("{
    \"type\": \"tuic\",
    \"listen\": \"0.0.0.0\",
    \"listen_port\": $TUIC_PORT,
    \"users\": [{\"uuid\": \"$UUID\", \"password\": \"admin\"}],
    \"congestion_control\": \"bbr\",
    \"tls\": {\"enabled\": true, \"alpn\": [\"h3\"], \"certificate_provider\": \"acme\"}
  }")
fi

if [ -n "$HY2_PORT" ] && [ "$HY2_PORT" != "0" ]; then
  INBOUNDS+=("{
    \"type\": \"hysteria2\",
    \"listen\": \"0.0.0.0\",
    \"listen_port\": $HY2_PORT,
    \"users\": [{\"password\": \"$UUID\"}],
    \"masquerade\": \"https://bing.com\",
    \"tls\": {\"enabled\": true, \"alpn\": [\"h3\"], \"certificate_provider\": \"acme\"}
  }")
fi

if [ -n "$REALITY_PORT" ] && [ "$REALITY_PORT" != "0" ]; then
  INBOUNDS+=("{
    \"type\": \"vless\",
    \"listen\": \"0.0.0.0\",
    \"listen_port\": $REALITY_PORT,
    \"users\": [{\"uuid\": \"$UUID\", \"flow\": \"xtls-rprx-vision\"}],
    \"tls\": {
      \"enabled\": true,
      \"server_name\": \"www.nazhumi.com\",
      \"reality\": {
        \"enabled\": true,
        \"handshake\": {\"server\": \"www.nazhumi.com\", \"server_port\": 443},
        \"private_key\": \"$private_key\",
        \"short_id\": [\"\"]
      }
    }
  }")
fi

IFS=','
cat > "${FILE_PATH}/config.json" <<EOF
{
  "log": { "level": "warn" },
  "dns": {
    "servers": [{"type": "local", "tag": "local-sys-dns"}],
    "strategy": "ipv4_only"
  },
  ${CERTIFICATE_PROVIDER_JSON}
  "inbounds": [
    ${INBOUNDS[*]}
  ],
  "outbounds": [{"type": "direct"}]
}
EOF
chmod 600 "${FILE_PATH}/config.json"

if ! "$SINGBOX_BIN" check -c "${FILE_PATH}/config.json"; then
  echo "[错误] Sing-box 配置校验失败，请修正上方具体错误后重启。" >&2
  exit 1
fi

"$SINGBOX_BIN" run -c "${FILE_PATH}/config.json" &
SINGBOX_PID=$!
echo "[SING-BOX] 启动完成 PID=$SINGBOX_PID"

IP=$(curl -s --max-time 2 ipv4.ip.sb || curl -s --max-time 1 api.ipify.org || echo "IP_ERROR")
ISP=$(curl -s --max-time 2 https://speed.cloudflare.com/meta | awk -F'"' '{print $26"-"$18}' || echo "0.0")

# ================== 生成订阅 ==================
> "${FILE_PATH}/list.txt"
[ "$TUIC_PORT" != "" ] && [ "$TUIC_PORT" != "0" ] && echo "tuic://${UUID}:admin@${IP}:${TUIC_PORT}?sni=${CERT_DOMAIN}&alpn=h3&congestion_control=bbr#tuic_easyshare" >> "${FILE_PATH}/list.txt"
[ "$HY2_PORT" != "" ] && [ "$HY2_PORT" != "0" ] && echo "hysteria2://${UUID}@${IP}:${HY2_PORT}/?sni=${CERT_DOMAIN}#hy2_easyshare" >> "${FILE_PATH}/list.txt"
[ "$REALITY_PORT" != "" ] && [ "$REALITY_PORT" != "0" ] && echo "vless://${UUID}@${IP}:${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.nazhumi.com&fp=firefox&pbk=${public_key}&type=tcp#reality_easyshare" >> "${FILE_PATH}/list.txt"

base64 "${FILE_PATH}/list.txt" | tr -d '\n' > "${FILE_PATH}/sub.txt"
cat "${FILE_PATH}/list.txt"
echo -e "\n\e[1;32m${FILE_PATH}/sub.txt 已保存\e[0m"

schedule_restart() {
  echo "[定时重启:Sing-box] 已启动（北京时间 00:03）"
  LAST_RESTART_DAY=-1

  while true; do
    now_ts=$(date +%s)
    beijing_ts=$((now_ts + 28800))
    H=$(( (beijing_ts / 3600) % 24 ))
    M=$(( (beijing_ts / 60) % 60 ))
    D=$(( beijing_ts / 86400 ))

    if [ "$H" -eq 0 ] && [ "$M" -eq 3 ] && [ "$D" -ne "$LAST_RESTART_DAY" ]; then
      echo "[定时重启:Sing-box] 到达 00:03 → 重启 sing-box"
      LAST_RESTART_DAY=$D

      kill "$SINGBOX_PID" 2>/dev/null || true
      sleep 3

      rm -rf ~/.npm/_logs/* ./npm-debug.log* "${DATA_PATH}"/* /tmp/.singbox_* 2>/dev/null || true

      "$SINGBOX_BIN" run -c "${FILE_PATH}/config.json" &
      SINGBOX_PID=$!

      echo "[Sing-box重启完成] 新 PID: $SINGBOX_PID"
    fi

    sleep 30
  done
}

schedule_restart
