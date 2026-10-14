FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY src/mailbox/package.json src/mailbox/package.json
COPY container/agent-runner/package.json container/agent-runner/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @mybots/agent-runner --include-workspace-root=false

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY src/mailbox ./src/mailbox
COPY container/agent-runner/package.json ./container/agent-runner/package.json
COPY container/agent-runner/src ./container/agent-runner/src
USER bun
ENTRYPOINT ["bun", "/app/container/agent-runner/src/index.ts"]
