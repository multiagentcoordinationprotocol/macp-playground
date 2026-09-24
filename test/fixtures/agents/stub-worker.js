#!/usr/bin/env node
// Zero-dependency stand-in for the real langgraph/langchain/crewai/custom
// workers, spawned only by e2e and integration-mock tests (see
// test/fixtures/stub-example-agent-catalog.ts). Those tiers exercise the
// real ProcessExampleAgentHostProvider/LaunchSupervisor spawn-confirmation
// path (PG-1) but must not depend on macp_sdk + framework packages + an LLM
// key actually being installed/configured — only the docker-built image
// installs agents/requirements.txt (see the repo Dockerfile). This script
// just stays alive until the supervisor sends SIGTERM/SIGKILL on teardown.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1 << 30);
