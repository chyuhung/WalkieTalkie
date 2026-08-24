# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS builder

ARG GOPROXY=https://goproxy.cn,https://goproxy.io,direct
ENV GOPROXY=${GOPROXY}

WORKDIR /app

# ── 依赖（只随 go.mod/go.sum 变化而失效；模块缓存跨构建复用）──
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

# ── Go 源码 → 编译（只随 .go 文件变化而失效；编译缓存跨构建复用）──
COPY main.go .
COPY handlers/ handlers/
COPY hub/ hub/
COPY middleware/ middleware/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o walkietalkie .

# ── 静态资源与配置（不影响编译缓存）──
COPY templates/ templates/
COPY static/ static/
COPY config.yaml .

# ─────────────────────────────────────
FROM alpine:3.20

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/walkietalkie .
COPY --from=builder /app/config.yaml .
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/static ./static

EXPOSE 8083

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8083/api/health || exit 1

CMD ["./walkietalkie"]