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

# Install Python agent framework dependencies (LangGraph, LangChain, CrewAI, macp-sdk-python)
COPY agents/requirements.txt /tmp/agent-requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/agent-requirements.txt \
  && rm /tmp/agent-requirements.txt

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

RUN mkdir -p /home/appuser/.local/share && chown -R appuser:appgroup /home/appuser

USER appuser
ENV NODE_ENV=production
ENV PORT=3000
ENV PACKS_DIR=/app/packs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3000/healthz', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/main.js"]
