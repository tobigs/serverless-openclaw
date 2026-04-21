# Stage 1: Build
FROM --platform=linux/arm64 node:22-slim AS builder

WORKDIR /build

# Copy workspace root files for workspace resolution
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src/ packages/shared/src/
COPY packages/container/package.json packages/container/tsconfig.json packages/container/
COPY packages/container/src/ packages/container/src/

RUN npm pkg delete scripts.prepare && \
    npm ci
RUN npm run build --workspace=packages/shared --workspace=packages/container

# Stage 2: Runtime
FROM --platform=linux/arm64 node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl git awscli && \
    rm -rf /var/lib/apt/lists/*

# Install uv (provides uvx) — used to fetch MCP servers like workspace-mcp on demand
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Install OpenClaw CLI (version configurable via build arg)
ARG OPENCLAW_VERSION=2026.2.13
RUN npm install -g openclaw@${OPENCLAW_VERSION} @aws-sdk/client-s3 && \
    npm cache clean --force

# Create non-root user
RUN groupadd -r openclaw && useradd -r -g openclaw -m openclaw

# Pre-generate openclaw config (skip onboard at runtime)
RUN mkdir -p /home/openclaw/.openclaw && \
    echo '{"gateway":{"port":18789,"mode":"local"}}' > /home/openclaw/.openclaw/openclaw.json && \
    chown -R openclaw:openclaw /home/openclaw/.openclaw

WORKDIR /app

# Copy production dependencies with --chown to avoid extra layer
COPY --from=builder --chown=openclaw:openclaw /build/packages/container/dist/ /app/dist/
COPY --from=builder --chown=openclaw:openclaw /build/node_modules/ /app/node_modules/
# Overwrite workspace symlink with real shared package
RUN rm -rf /app/node_modules/@serverless-openclaw/shared
COPY --from=builder --chown=openclaw:openclaw /build/packages/shared/dist/ /app/node_modules/@serverless-openclaw/shared/dist/
COPY --from=builder --chown=openclaw:openclaw /build/packages/shared/package.json /app/node_modules/@serverless-openclaw/shared/
COPY --chown=openclaw:openclaw packages/container/package.json /app/
COPY --chown=openclaw:openclaw packages/container/start-openclaw.sh /app/

RUN chmod +x /app/start-openclaw.sh && \
    mkdir -p /data/workspace && \
    chown openclaw:openclaw /data/workspace

USER openclaw

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["/app/start-openclaw.sh"]
