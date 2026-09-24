import { ExampleAgentDefinition, ExampleAgentSummary } from '../../src/contracts/example-agents';
import { ParticipantTemplate } from '../../src/contracts/registry';
import { ExampleAgentCatalogService } from '../../src/example-agents/example-agent-catalog.service';
import { AgentManifest } from '../../src/hosting/contracts/manifest.types';

const STUB_ENTRYPOINT = 'test/fixtures/agents/stub-worker.js';

/**
 * e2e/integration-mock tests exercise the real ProcessExampleAgentHostProvider
 * and LaunchSupervisor.confirmSpawn() (PG-1's spawn-confirmation gate) but
 * must not depend on the production Python workers actually running — those
 * require macp_sdk + langgraph/langchain/crewai + an LLM key, none of which
 * this fast tier installs (only the docker-built image installs
 * agents/requirements.txt; see the repo Dockerfile). Redirect every
 * definition's entrypoint/manifest at the dependency-free Node stub so a
 * real spawn genuinely succeeds — everything else (name/role/description/
 * tags/framework/transportIdentity) is left untouched so catalog and
 * agent-profile assertions still see production-shaped data.
 */
function stubManifest(real: AgentManifest): AgentManifest {
  const isNode = real.framework === 'custom';
  return {
    ...real,
    entrypoint: {
      type: isNode ? 'node_file' : 'python_file',
      value: STUB_ENTRYPOINT
    },
    host: {
      cwd: '.',
      startupTimeoutMs: 5000,
      ...(isNode ? {} : { python: process.execPath })
    },
    frameworkConfig: undefined
  };
}

function stubDefinition(real: ExampleAgentDefinition): ExampleAgentDefinition {
  return {
    ...real,
    bootstrap: {
      ...real.bootstrap,
      entrypoint: STUB_ENTRYPOINT
    },
    manifest: real.manifest ? stubManifest(real.manifest) : real.manifest
  };
}

class StubExampleAgentCatalog {
  private readonly definitions: Map<string, ExampleAgentDefinition>;

  constructor() {
    const real = new ExampleAgentCatalogService();
    this.definitions = new Map(real.list().map((definition) => [definition.agentRef, stubDefinition(definition)]));
  }

  list(): ExampleAgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  get(agentRef: string): ExampleAgentDefinition {
    const definition = this.definitions.get(agentRef);
    if (!definition) {
      // Reuses production's AGENT_NOT_FOUND shape/message for an agentRef
      // this stub was never seeded with.
      return new ExampleAgentCatalogService().get(agentRef);
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
      return { ...summary, role: participant.role || summary.role };
    });
  }
}

export function buildStubExampleAgentCatalog(): ExampleAgentCatalogService {
  return new StubExampleAgentCatalog() as unknown as ExampleAgentCatalogService;
}
