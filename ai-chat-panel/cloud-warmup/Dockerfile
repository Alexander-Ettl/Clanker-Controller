FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_VERSION
ARG CODEX_VERSION
RUN test -n "$CLAUDE_VERSION" && test -n "$CODEX_VERSION" && npm install -g "@anthropic-ai/claude-code@$CLAUDE_VERSION" "@openai/codex@$CODEX_VERSION"
WORKDIR /app
COPY cloud-warmup-plan.js ./lib/cloud-warmup-plan.js
COPY runner.js ./cloud-warmup/runner.js
USER node
CMD ["node", "cloud-warmup/runner.js"]
