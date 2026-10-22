# The brain as one image for AWS ECS: the CLI, the MCP server, git and Claude Code (which
# src/ai/runner.ts spawns as `claude`). Everything it keeps goes under BRAIN_DATA (default /data):
# mount a volume there (EFS on ECS), or the store and clones go when the container does.
# See docs/development.md, "Docker and AWS".

FROM node:22-bookworm-slim

# Pinned so a rebuild doesn't change how wikis are written; bump it on purpose.
ARG CLAUDE_CODE_VERSION=2.1.296

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY bin ./bin
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/brain-entrypoint
# `brain` and `brain-mcp` through node, not the .mjs shebangs: a Windows checkout gives them CRLF.
RUN chmod 755 /usr/local/bin/brain-entrypoint \
 && printf '#!/bin/sh\nexec node /app/bin/brain.mjs "$@"\n' > /usr/local/bin/brain \
 && printf '#!/bin/sh\nexec node /app/bin/brain-mcp.mjs "$@"\n' > /usr/local/bin/brain-mcp \
 && chmod 755 /usr/local/bin/brain /usr/local/bin/brain-mcp \
 && mkdir -p /data && chown node:node /data

USER node
# Registered for the node user, so `claude` run in the container (and brain doctor) can ask the
# brain. Hosted agents reach it over HTTP instead, once that transport is built.
RUN claude mcp add --scope user citation-brain -- node /app/bin/brain-mcp.mjs

ENV BRAIN_DATA=/data \
    NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
VOLUME ["/data"]

ENTRYPOINT ["brain-entrypoint"]
CMD ["brain", "doctor"]
