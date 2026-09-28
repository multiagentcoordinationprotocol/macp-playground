# syntax=docker/dockerfile:1
FROM node:26-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
ARG NODE_AUTH_TOKEN
RUN echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src/ src/
RUN npm run build

FROM node:26-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv gcc python3-dev libffi-dev \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r appgroup \
  && useradd -r -g appgroup appuser

# Install Python agent framework dependencies (LangGraph, LangChain, CrewAI, macp-sdk-python).
#
# `-c agent-constraints.txt` pins the full transitive closure. requirements.txt pins only the six
# direct dependencies, which leaves everything underneath them floating — so a bad `instructor`,
# `litellm` or `pydantic` release could break this build with no change in the repo at all. The
# constraints file is generated against THIS base image (Debian trixie system Python), not a clean
# venv, because `--break-system-packages` means /usr/lib/python3/dist-packages participates in the
# resolution; a venv-generated file would not match what installs here. Regenerate it in a
# node:26-slim container whenever requirements.txt changes.
COPY agents/requirements.txt /tmp/agent-requirements.txt
COPY agents/constraints.txt /tmp/agent-constraints.txt
RUN pip3 install --no-cache-dir --break-system-packages -c /tmp/agent-constraints.txt -r /tmp/agent-requirements.txt \
  && rm /tmp/agent-requirements.txt /tmp/agent-constraints.txt

COPY package.json package-lock.json* .npmrc ./
ARG NODE_AUTH_TOKEN
RUN echo "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts --omit=dev && \
    npm cache clean --force && \
    rm -f .npmrc

COPY --from=builder /app/dist dist/
COPY packs/ packs/
COPY agents/ agents/
COPY policies/ policies/
COPY schemas/ schemas/

RUN mkdir -p /home/appuser/.local/share && chown -R appuser:appgroup /home/appuser

USER appuser
ENV NODE_ENV=production
ENV PORT=3000
ENV PACKS_DIR=/app/packs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3000/healthz', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/main.js"]
