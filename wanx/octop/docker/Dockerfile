# syntax=docker/dockerfile:1
# =============================================================================
# Octop — 多阶段 Docker 构建
#
# 阶段 1: 构建 React/TypeScript 前端
# 阶段 2: Python 运行时 + 预构建前端
#
# 用法（在仓库根目录执行，构建上下文为根目录）:
#   docker build -f octop/docker/Dockerfile -t octop:latest .
#   docker run -d -p 8088:8088 -v octop-data:/data/.octop -e HOME=/data octop:latest
#
# 国内加速（可选，需 BuildKit，octop/docker/docker_build.sh 默认已开启）:
#   PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple \
#   PIP_TRUSTED_HOST=mirrors.cloud.tencent.com \
#   NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/ \
#   APT_MIRROR=mirrors.cloud.tencent.com \
#   bash octop/docker/docker_build.sh
#
# 或直接传 build-arg:
#   docker build \
#     -f octop/docker/Dockerfile \
#     --build-arg PIP_INDEX_URL=https://mirrors.cloud.tencent.com/pypi/simple \
#     --build-arg PIP_TRUSTED_HOST=mirrors.cloud.tencent.com \
#     --build-arg NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/ \
#     --build-arg APT_MIRROR=mirrors.cloud.tencent.com \
#     --build-arg NODE_MAX_OLD_SPACE_SIZE=1024 \
#     -t octop:latest .
#
# 或使用 Compose:
#   docker compose -f octop/docker/docker-compose.yml up -d
# =============================================================================

# ---------------------------------------------------------------------------
# 阶段 1 — 前端构建
# ---------------------------------------------------------------------------
FROM node:20-slim AS frontend-builder

ARG NPM_REGISTRY=
# Node heap ceiling for the vite build. Lower this (e.g. 1024) on low-memory
# build hosts (< 4G RAM) to avoid OOM kills — the value only caps the max,
# it is not pre-allocated.
ARG NODE_MAX_OLD_SPACE_SIZE=2048
WORKDIR /build/dashboard

COPY octop/dashboard/package.json octop/dashboard/package-lock.json ./
COPY vendor/ /vendor/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu; \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi; \
    npm ci --no-audit \
    || { echo "npm ci failed — retrying clean"; rm -rf node_modules; npm ci --no-audit; }; \
    test -x node_modules/.bin/vite

COPY octop/dashboard/ ./

RUN mkdir -p ../src/octop/dashboard

# 镜像构建跳过完整 tsc；生产打包由 vite/esbuild 完成（使用 lockfile 中的 vite，不用 npx）
RUN NODE_ENV=production NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE}" npm run build:docker


# Pinned WANX Builder and dev-kit, assembled from the canonical Host SDK source.
FROM node:22-bookworm-slim AS builder-kit
ARG WANX_REQUIRE_RELEASE_SNAPSHOT=0
WORKDIR /build
COPY package.json ./
COPY tools/build-app-kit.mjs ./tools/build-app-kit.mjs
COPY apps/personal-client/host-sdk/ ./apps/personal-client/host-sdk/
COPY apps/builder/package.json apps/builder/package-lock.json ./apps/builder/
COPY apps/builder/vendor/ ./apps/builder/vendor/
COPY apps/builder/backend/ ./apps/builder/backend/
COPY apps/builder/core/ ./apps/builder/core/
COPY apps/builder/codex/ ./apps/builder/codex/
COPY apps/builder/dsh/ ./apps/builder/dsh/
COPY apps/builder/tools/ ./apps/builder/tools/
COPY apps/builder/examples/ ./apps/builder/examples/
COPY apps/builder/templates/ ./apps/builder/templates/
COPY apps/builder/integration/ ./apps/builder/integration/
COPY apps/builder/foundation-runtime/ ./apps/builder/foundation-runtime/
# Consume the assembled release archive when it is present in the build context.
# Clean source builds use the same content pins as the release build.
RUN --mount=type=bind,source=.,target=/context,readonly --mount=type=cache,target=/root/.npm \
    kit_version="$(node -p "require('./apps/builder/vendor/dev-kit-source.json').kitVersion")" && \
    if [ "$WANX_REQUIRE_RELEASE_SNAPSHOT" = 1 ] || [ -e "/context/.wanx-app-kit/$kit_version" ]; then \
      export WANX_APP_KIT_DIR="/context/.wanx-app-kit/$kit_version"; \
    fi && npm run build:builder-runtime

FROM builder-kit AS builder-runtime
WORKDIR /build/apps/builder
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --no-audit

# ---------------------------------------------------------------------------
# 阶段 2 — Python 运行时
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

LABEL maintainer="OrcaKit Team"
LABEL org.opencontainers.image.title="Octop"
LABEL org.opencontainers.image.description="Smarter self-hosted AI assistant — multi-user, multi-agent."
LABEL org.opencontainers.image.source="https://github.com/TencentCloud/orca"
LABEL org.opencontainers.image.licenses="MIT"
LABEL io.centuarai.wanx.host-metrics="proc-v1"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/data \
    OCTOP_BIND_HOST=0.0.0.0 \
    OCTOP_PORT=8088 \
    OCTOP_LOG_LEVEL=info \
    OCTOP_HOST_PROC=/run/wanx-host/proc \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=
ARG APT_MIRROR=

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    if [ -n "$APT_MIRROR" ]; then \
        printf 'Types: deb\nURIs: https://%s/debian\nSuites: trixie trixie-updates\nComponents: main contrib non-free non-free-firmware\n\nTypes: deb\nURIs: https://%s/debian-security\nSuites: trixie-security\nComponents: main contrib non-free non-free-firmware\n' \
            "$APT_MIRROR" "$APT_MIRROR" > /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
        curl \
        git \
        libreoffice-writer \
        libreoffice-impress \
        fonts-noto-cjk \
        bubblewrap \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.7 /uv /uvx /bin/

COPY --from=builder-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=builder-runtime /usr/local/lib/node_modules/npm/ /usr/local/lib/node_modules/npm/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV WANX_STUDIO_ROOT=/apps/builder WANX_APP_DEV_KIT_ROOT=/opt/wanx-app-dev-kit WANX_DEVKIT_NPM_CACHE=/opt/wanx-builder-npm-cache
COPY --from=builder-runtime /build/.wanx-builder-runtime/dev-kit/ /opt/wanx-app-dev-kit/
WORKDIR /app

# 先安装锁定依赖，仅改源码时可复用此层缓存
COPY octop/pyproject.toml octop/uv.lock octop/README.md octop/LICENSE ./
COPY shared/packages/local-data-gate /shared/packages/local-data-gate
COPY server/bridge /server/bridge
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$PIP_INDEX_URL" ]; then \
        export UV_INDEX_URL="$PIP_INDEX_URL"; \
        if [ -n "$PIP_TRUSTED_HOST" ]; then export UV_INSECURE_HOST="$PIP_TRUSTED_HOST"; fi; \
    fi \
    && uv sync --frozen --no-install-project --no-dev --extra browser

ENV PATH="/app/.venv/bin:$PATH" \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

COPY octop/src/ ./src/
COPY octop/_build.py ./
COPY apps/builder/backend/wanx_studio /apps/builder/backend/wanx_studio
COPY --from=builder-runtime /build/apps/builder/ /apps/builder/
COPY --from=frontend-builder /build/src/octop/dashboard/ ./src/octop/dashboard/

COPY octop/.env.example ./
COPY octop/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN --mount=type=cache,target=/root/.cache/uv \
    if [ -n "$PIP_INDEX_URL" ]; then \
        export UV_INDEX_URL="$PIP_INDEX_URL"; \
        if [ -n "$PIP_TRUSTED_HOST" ]; then export UV_INSECURE_HOST="$PIP_TRUSTED_HOST"; fi; \
    fi \
    && uv sync --frozen --no-dev --extra browser \
    && apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/* /tmp/*

# Validate installed routing and standard expert generation/build/package before export.
RUN python -m wanx_studio.release_check --pipeline
ENV WANX_DEVKIT_NPM_OFFLINE=1
RUN --network=none python -m wanx_studio.release_check --pipeline
RUN mkdir -p /data/.octop

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD ["sh", "-c", "curl -f http://localhost:${OCTOP_PORT:-8088}/api/health || exit 1"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD []
