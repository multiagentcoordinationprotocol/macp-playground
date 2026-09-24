import { Inject, Injectable } from '@nestjs/common';
import {
  ExampleAgentDefinition,
  ExampleAgentRunContext,
  HostedExampleAgent,
  ParticipantAgentBinding
} from '../contracts/example-agents';
import { CompileLaunchResult } from '../contracts/launch';
import { ExampleAgentCatalogService } from '../example-agents/example-agent-catalog.service';
import { EXAMPLE_AGENT_HOST_PROVIDER, ExampleAgentHostProvider } from './example-agent-host.provider';

@Injectable()
export class HostingService {
  constructor(
    private readonly exampleAgents: ExampleAgentCatalogService,
    @Inject(EXAMPLE_AGENT_HOST_PROVIDER)
    private readonly hostProvider: ExampleAgentHostProvider
  ) {}

  async resolve(compiled: CompileLaunchResult): Promise<HostedExampleAgent[]> {
    const hostedAgents = await this.materializeHostedAgents(compiled, async (definition, binding) =>
      this.hostProvider.resolve(definition, binding)
    );

    this.applyHostedAgents(compiled, hostedAgents);
    return hostedAgents;
  }

  async attach(compiled: CompileLaunchResult, context: ExampleAgentRunContext): Promise<HostedExampleAgent[]> {
    // PG-2: the initiator is the only participant whose SessionStart actually
    // opens the session on the runtime — every other participant subscribes
    // to a session that doesn't exist until then. Scenario-declaration order
    // (packs/_shared/participants/*.yaml) happens to always put the initiator
    // last, which reliably raced non-initiator agents into a session-not-found
    // crash on their first connect (see #90 for observed failure logs).
    // Spawning the initiator's binding first — before any non-initiator agent
    // is spawned — closes most of that window; a transient NOT_FOUND on the
    // remainder is retried client-side (macp-sdk-python#75).
    const hostedAgents = await this.materializeHostedAgents(
      compiled,
      async (definition, binding) => {
        if (!this.hostProvider.attach) {
          return this.hostProvider.resolve(definition, binding);
        }
        return this.hostProvider.attach(definition, binding, context);
      },
      compiled.scenarioMeta.initiatorParticipantId
    );

    this.applyHostedAgents(compiled, hostedAgents);
    return hostedAgents;
  }

  private async materializeHostedAgents(
    compiled: CompileLaunchResult,
    resolver: (
      definition: ExampleAgentDefinition,
      binding: CompileLaunchResult['participantBindings'][number]
    ) => Promise<HostedExampleAgent>,
    initiatorParticipantId?: string
  ): Promise<HostedExampleAgent[]> {
    const bindings = compiled.participantBindings;
    const hostedByParticipantId = new Map<string, HostedExampleAgent>();

    for (const binding of this.orderForSpawn(bindings, initiatorParticipantId)) {
      const definition = this.exampleAgents.get(binding.agentRef);
      hostedByParticipantId.set(binding.participantId, await resolver(definition, binding));
    }

    // Response order always mirrors scenario-declaration order, regardless of
    // spawn order — callers (API responses, existing tests) key off position.
    return bindings.map((binding) => hostedByParticipantId.get(binding.participantId)!);
  }

  /** Moves the initiator's binding to the front so it is spawned before any non-initiator participant. */
  private orderForSpawn(
    bindings: ParticipantAgentBinding[],
    initiatorParticipantId?: string
  ): ParticipantAgentBinding[] {
    if (!initiatorParticipantId) {
      return bindings;
    }
    const initiatorIndex = bindings.findIndex((binding) => binding.participantId === initiatorParticipantId);
    if (initiatorIndex <= 0) {
      return bindings;
    }
    return [bindings[initiatorIndex], ...bindings.slice(0, initiatorIndex), ...bindings.slice(initiatorIndex + 1)];
  }

  private applyHostedAgents(compiled: CompileLaunchResult, hostedAgents: HostedExampleAgent[]): void {
    compiled.runDescriptor.session.metadata = {
      ...(compiled.runDescriptor.session.metadata ?? {}),
      hostedParticipants: hostedAgents.map((agent) => ({
        participantId: agent.participantId,
        agentRef: agent.agentRef,
        transportIdentity: agent.transportIdentity,
        framework: agent.framework,
        entrypoint: agent.entrypoint,
        bootstrapStrategy: agent.bootstrapStrategy,
        bootstrapMode: agent.bootstrapMode,
        status: agent.status,
        participantMetadata: agent.participantMetadata ?? {}
      }))
    };
  }
}
