import * as fs from 'node:fs';
import * as path from 'node:path';
import { IntegrationTestClient } from '../helpers/integration-test-client';

/**
 * Every shipped scenario/template, driven end to end against a RUNNING stack:
 * playground `/examples/run` → hosted agents → runtime session → control-plane run, polled to a
 * terminal state. The rest of the integration tier stops at launch (`/examples/run` returns
 * before the session resolves), so this is the only test that sees a session finish.
 *
 * Opt-in, never in CI: it needs a deployed stack and, with `PLAYGROUND_ALLOW_LLM` set on that
 * stack, spends LLM tokens. Point it at either target with the same variables:
 *
 *   SCENARIO_E2E_PLAYGROUND_URL         playground base URL (local fullstack compose, or Railway)
 *   SCENARIO_E2E_PLAYGROUND_API_KEY     optional, sent as x-api-key when the playground sets AUTH_API_KEYS
 *   SCENARIO_E2E_CONTROL_PLANE_URL      control-plane base URL the playground registers runs with
 *   SCENARIO_E2E_CONTROL_PLANE_API_KEY  control-plane API key
 *   SCENARIO_E2E_RUN_TIMEOUT_MS         optional per-run wait, default 240000
 *   SCENARIO_E2E_AGENT_EXECUTION        optional `llm` | `deterministic`: every non-showcase launch
 *                                       must resolve to this mode, so an LLM run that silently fell
 *                                       back to deterministic agents (an LLM launch limit) fails
 *
 * Each launch names its own client in X-MACP-Client-IP (198.18.0.0/15, the benchmarking range), so
 * one pass of the suite does not trip the playground's per-IP LLM burst limit. It still counts
 * against the global daily and monthly LLM caps.
 *
 * Scenarios come from this checkout's `packs/`, so the target should run the same commit.
 */
const PLAYGROUND_URL = process.env.SCENARIO_E2E_PLAYGROUND_URL ?? '';
// Empty means unset (Doppler and CI both export blank variables).
const PLAYGROUND_API_KEY =
  (process.env.SCENARIO_E2E_PLAYGROUND_API_KEY ?? '').trim() === ''
    ? undefined
    : process.env.SCENARIO_E2E_PLAYGROUND_API_KEY;
const CONTROL_PLANE_URL = process.env.SCENARIO_E2E_CONTROL_PLANE_URL ?? '';
const CONTROL_PLANE_API_KEY = process.env.SCENARIO_E2E_CONTROL_PLANE_API_KEY ?? '';
const RUN_TIMEOUT_MS = Number(process.env.SCENARIO_E2E_RUN_TIMEOUT_MS ?? 240_000);
const EXPECT_AGENT_EXECUTION = (process.env.SCENARIO_E2E_AGENT_EXECUTION ?? '').trim();
const enabled = PLAYGROUND_URL !== '' && CONTROL_PLANE_URL !== '';
const describeLive = enabled ? describe : describe.skip;

/**
 * Every shipped template must end `completed`, with deterministic and LLM agents alike. A
 * `cancelled` run means the risk-decider's commit was policy-denied (it cancels via the
 * CancelSession RPC rather than leave the session to expire), which for a shipped demo is a bug:
 * the deterministic lending run used to be cancelled because its specialists evaluated under
 * lending.conservative's confidence floor. A template whose point is a governed cancellation
 * opts in here by label (`pack/scenario@version:template`); none does today.
 */
const EXPECTED_STATUS: Record<string, 'completed' | 'cancelled'> = {};

function expectedStatus(combo: Combo): 'completed' | 'cancelled' {
  return EXPECTED_STATUS[label(combo)] ?? 'completed';
}

interface Combo {
  pack: string;
  scenario: string;
  version: string;
  template: string;
}

function discoverCombos(): Combo[] {
  const packsDir = path.resolve(__dirname, '../../packs');
  const combos: Combo[] = [];
  for (const pack of fs.readdirSync(packsDir)) {
    const scenariosDir = path.join(packsDir, pack, 'scenarios');
    if (pack.startsWith('_') || !fs.existsSync(scenariosDir)) continue;
    for (const scenario of fs.readdirSync(scenariosDir)) {
      for (const version of fs.readdirSync(path.join(scenariosDir, scenario))) {
        const templatesDir = path.join(scenariosDir, scenario, version, 'templates');
        const templates = fs.existsSync(templatesDir)
          ? fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'))
          : ['default.yaml'];
        for (const file of templates) combos.push({ pack, scenario, version, template: file.replace(/\.yaml$/, '') });
      }
    }
  }
  return combos.sort((a, b) => label(a).localeCompare(label(b)));
}

function label(c: Combo): string {
  return `${c.pack}/${c.scenario}@${c.version}:${c.template}`;
}

async function cp<T>(route: string): Promise<T> {
  const res = await fetch(`${CONTROL_PLANE_URL}${route}`, {
    headers: { authorization: `Bearer ${CONTROL_PLANE_API_KEY}` }
  });
  if (!res.ok) throw new Error(`control-plane GET ${route} -> ${res.status}`);
  return (await res.json()) as T;
}

interface RunEvent {
  type: string;
}

async function waitForTerminal(runId: string): Promise<string> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let status = '';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    status = (await cp<{ status: string }>(`/runs/${runId}`)).status;
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
  }
  return `timeout(last=${status})`;
}

describeLive('Scenario outcomes against a running stack (integration, opt-in)', () => {
  const client = new IntegrationTestClient(PLAYGROUND_URL, PLAYGROUND_API_KEY);
  const combos = discoverCombos();

  it('discovers the shipped scenario templates', () => {
    expect(combos.length).toBeGreaterThanOrEqual(8);
  });

  it.each(combos.map((c) => [label(c), c] as const))(
    '%s reaches its expected terminal state through the control-plane',
    async (_label, combo) => {
      const clientIp = `198.18.0.${combos.indexOf(combo) + 1}`;
      const schema = (await client.getLaunchSchema(combo.pack, combo.scenario, combo.version, combo.template)) as {
        defaults?: Record<string, unknown>;
      };
      const result = (await client.runExample(
        {
          scenarioRef: `${combo.pack}/${combo.scenario}@${combo.version}`,
          templateId: combo.template,
          mode: 'sandbox',
          inputs: schema.defaults ?? {},
          bootstrapAgents: true,
          tags: ['scenario-e2e'],
          runLabel: `scenario-e2e ${label(combo)}`
        },
        { 'x-macp-client-ip': clientIp }
      )) as {
        hostedAgents: unknown[];
        sessionId?: string;
        controlPlaneRun?: { runId: string };
        compiled: { scenarioMeta: { agentExecution?: string; agentExecutionFallback?: unknown } };
      };

      expect(result.hostedAgents).toHaveLength(4);
      expect(result.controlPlaneRun?.runId).toBeDefined();
      if (combo.template === 'showcase') expect(result.compiled.scenarioMeta.agentExecution).toBe('deterministic');
      else if (EXPECT_AGENT_EXECUTION) {
        expect(result.compiled.scenarioMeta.agentExecutionFallback).toBeUndefined();
        expect(result.compiled.scenarioMeta.agentExecution).toBe(EXPECT_AGENT_EXECUTION);
      }

      const runId = result.controlPlaneRun!.runId;
      const status = await waitForTerminal(runId);
      const events = await cp<RunEvent[] | { events: RunEvent[] }>(`/runs/${runId}/events?limit=500`);
      const types = new Set((Array.isArray(events) ? events : events.events).map((e) => e.type));

      expect(status).toBe(expectedStatus(combo));
      if (status === 'completed') expect(types.has('decision.finalized')).toBe(true);
      expect(types.has('run.failed')).toBe(false);

      if (combo.template === 'suspend-demo') {
        // Initiator-driven SuspendSession/ResumeSession RPCs (never Send: runtime 0.14 refuses
        // SessionSuspend/SessionResume envelopes on Send as FORBIDDEN). The specialists' Votes
        // must land before the suspension, so the commit after resume meets quorum.
        expect(types.has('run.suspended')).toBe(true);
        expect(types.has('run.resumed')).toBe(true);
      }
    },
    RUN_TIMEOUT_MS + 60_000
  );
});
