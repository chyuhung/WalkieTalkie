#!/usr/bin/env bash
# 生成自签证书（用于 iOS 网页版对讲，无需域名）
# 用法：
#   bash gen-certs.sh [IP1] [IP2] ...
# 示例：
#   bash gen-certs.sh 8.134.203.172 192.168.1.100
# 生成到 /etc/nginx/certs/，并在当前目录留下 walkielog.crt 供 iOS 安装
set -euo pipefail

CERT_DIR="/etc/nginx/certs"
CERT_NAME="${CERT_NAME:-walkielog}"
DAYS="${DAYS:-365}"
OUT_CRT="${OUT_CRT:-./walkielog.crt}"

IPS=("$@")
if [ ${#IPS[@]} -eq 0 ]; then
  echo "用法: bash gen-certs.sh <IP1> [IP2] ...  （至少一个服务器 IP）"
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "缺少 openssl"; exit 1; }
mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

# 构造 SAN 列表
SAN_ARGS=""
for ip in "${IPS[@]}"; do
  SAN_ARGS="${SAN_ARGS}IP:${ip},"
done
# 去掉末尾逗号
SAN_ARGS=$(echo "$SAN_ARGS" | sed 's/,$//')

openssl req -x509 -newkey rsa:2048 \
  -keyout "$CERT_NAME.key" \
  -out "$CERT_NAME.crt" \
  -days "$DAYS" \
  -nodes \
  -subj "/C=CN/O=WalkieTalkie/CN=${IPS[0]}" \
  -addext "subjectAltName=${SAN_ARGS}" \
  >/dev/null 2>&1

chmod 600 "$CERT_NAME.key"
chmod 644 "$CERT_NAME.crt"

# 复制到当前工作目录供 iOS 安装
cp "$CERT_NAME.crt" "$OUT_CRT"

echo "✔ 证书已生成："
echo "  私钥: $CERT_DIR/$CERT_NAME.key"
echo "  证书: $CERT_DIR/$CERT_NAME.crt"
echo "  安装用: $OUT_CRT"
echo ""
echo "下一步："
echo "  1) apt install nginx；把 nginx-https.conf 放入 /etc/nginx/conf.d/"
echo "  2) nginx -t && systemctl reload nginx"
echo "  3) iOS 安装 $OUT_CRT 并开启「完全信任」（详见 README）"