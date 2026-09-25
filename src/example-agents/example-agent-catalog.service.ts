import { Injectable, HttpStatus, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ExampleAgentDefinition, ExampleAgentSummary } from '../contracts/example-agents';
import { ParticipantTemplate } from '../contracts/registry';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { AgentManifest } from '../hosting/contracts/manifest.types';

const FRAUD_SCENARIO = 'fraud/high-value-new-device@1.0.0';
const LENDING_SCENARIO = 'lending/loan-underwriting@1.0.0';
const CLAIMS_SCENARIO = 'claims/auto-claim-review@1.0.0';
const ALL_SCENARIOS = [FRAUD_SCENARIO, LENDING_SCENARIO, CLAIMS_SCENARIO];

function loadManifest(relativePath: string): AgentManifest {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new AppException(
      ErrorCode.INVALID_CONFIG,
      `example agent manifest missing: ${relativePath} (resolved: ${absolutePath})`,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as AgentManifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AppException(
      ErrorCode.INVALID_CONFIG,
      `example agent manifest unreadable: ${relativePath} (${message})`,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
}

const EXAMPLE_AGENT_DEFINITIONS: ExampleAgentDefinition[] = [
  {
    agentRef: 'fraud-agent',
    name: 'Fraud Agent',
    role: 'fraud',
    description: 'Evaluates device, chargeback, and identity-risk signals using a LangGraph graph.',
    framework: 'langgraph',
    supportedScenarioRefs: ALL_SCENARIOS,
    bootstrap: {
      strategy: 'external',
      entrypoint: 'agents/langgraph_worker/main.py',
      transportIdentity: 'agent://fraud-agent',
      mode: 'attached',
      launcher: 'python',
      notes: [
        'Backed by a real LangGraph graph that evaluates device trust and chargeback signals.',
        'Falls back gracefully when langgraph is not installed.'
      ]
    },
    manifest: loadManifest('agents/manifests/fraud-agent.json'),
    tags: ['fraud', 'langgraph', 'risk']
  },
  {
    agentRef: 'growth-agent',
    name: 'Growth Agent',
    role: 'growth',
    description: 'Assesses customer value, revenue impact, and experience trade-offs using a LangChain chain.',
    framework: 'langchain',
    supportedScenarioRefs: ALL_SCENARIOS,
    bootstrap: {
      strategy: 'external',
      entrypoint: 'agents/langchain_worker/main.py',
      transportIdentity: 'agent://growth-agent',
      mode: 'attached',
      launcher: 'python',
      notes: [
        'Runs a LangChain chain that analyzes growth impact factors.',
        'Falls back gracefully when langchain is not installed.'
      ]
    },
    manifest: loadManifest('agents/manifests/growth-agent.json'),
    tags: ['growth', 'langchain', 'revenue']
  },
  {
    agentRef: 'compliance-agent',
    name: 'Compliance Agent',
    role: 'compliance',
    description: 'Applies onboarding, policy, and KYC/AML checks using a CrewAI crew.',
    framework: 'crewai',
    supportedScenarioRefs: ALL_SCENARIOS,
    bootstrap: {
      strategy: 'external',
      entrypoint: 'agents/crewai_worker/main.py',
      transportIdentity: 'agent://compliance-agent',
      mode: 'attached',
      launcher: 'python',
      notes: [
        'Demonstrates a CrewAI-style specialist that can raise objections or send evaluations.',
        'Falls back gracefully when crewai is not installed.'
      ]
    },
    manifest: loadManifest('agents/manifests/compliance-agent.json'),
    tags: ['compliance', 'crewai', 'policy']
  },
  {
    agentRef: 'risk-agent',
    name: 'Risk Agent',
    role: 'risk',
    description: 'Coordinates the final recommendation and turns specialist input into a terminal commitment.',
    framework: 'custom',
    supportedScenarioRefs: ALL_SCENARIOS,
    bootstrap: {
      strategy: 'external',
      entrypoint: 'src/example-agents/runtime/risk-decider.worker.ts',
      transportIdentity: 'agent://risk-agent',
      mode: 'attached',
      launcher: 'node',
      notes: [
        'Acts as the decision owner for the showcase session and actively joins the runtime via the control plane.',
        'Uses the custom framework adapter for Node.js-based coordinators.'
      ]
    },
    manifest: loadManifest('agents/manifests/risk-agent.json'),
    tags: ['risk', 'coordinator', 'decision']
  }
];

@Injectable()
export class ExampleAgentCatalogService {
  private readonly logger = new Logger(ExampleAgentCatalogService.name);
  private readonly definitions = new Map<string, ExampleAgentDefinition>(
    EXAMPLE_AGENT_DEFINITIONS.map((definition) => [definition.agentRef, definition])
  );

  constructor() {
    this.logger.log(`loaded ${EXAMPLE_AGENT_DEFINITIONS.length} agent definitions`);
  }

  list(): ExampleAgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  get(agentRef: string): ExampleAgentDefinition {
    const definition = this.definitions.get(agentRef);
    if (!definition) {
      throw new AppException(ErrorCode.AGENT_NOT_FOUND, `example agent not found: ${agentRef}`, HttpStatus.NOT_FOUND);
    }
    return definition;
  }

  summarize(agentRef: string): ExampleAgentSummary {
    const definition = this.get(agentRef);
    return {
      agentRef: definition.agentRef,
      name: definition.name,
      role: definition.role,
      framework: definition.framework,
      description: definition.description,
      transportIdentity: definition.bootstrap.transportIdentity,
      entrypoint: definition.bootstrap.entrypoint,
      bootstrapStrategy: definition.bootstrap.strategy,
      bootstrapMode: definition.bootstrap.mode,
      tags: definition.tags
    };
  }

  summarizeParticipants(participants: ParticipantTemplate[]): ExampleAgentSummary[] {
    return participants.map((participant) => {
      const summary = this.summarize(participant.agentRef);
      return {
        ...summary,
        role: participant.role || summary.role
      };
    });
  }
}
