import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RunExampleRequest, RunExampleResult } from '../contracts/launch';
import { AppConfigService } from '../config/app-config.service';
import { CompilerService } from '../compiler/compiler.service';
import { HostingService } from '../hosting/hosting.service';
import { ControlPlaneRunClient } from './control-plane-run-client.service';

@Injectable()
export class ExampleRunService {
  private readonly logger = new Logger(ExampleRunService.name);

  constructor(
    private readonly compiler: CompilerService,
    private readonly hosting: HostingService,
    private readonly config: AppConfigService,
    private readonly controlPlaneClient: ControlPlaneRunClient
  ) {}

  async run(request: RunExampleRequest): Promise<RunExampleResult> {
    const compiled = await this.compiler.compile(request);
    this.applyRequestOverrides(compiled, request);
    const shouldBootstrap = request.bootstrapAgents ?? this.config.autoBootstrapExampleAgents;
    const resolvedAgents = shouldBootstrap ? await this.hosting.resolve(compiled) : [];

    if (!shouldBootstrap) {
      return { compiled, hostedAgents: resolvedAgents };
    }

    const sessionId = compiled.sessionId || randomUUID();
    compiled.sessionId = sessionId;
    compiled.runDescriptor.session.sessionId = sessionId;

    const session = compiled.runDescriptor.session;

    // Snapshot the descriptor before firing anything: `hosting.attach` below
    // mutates `compiled.runDescriptor.session.metadata` in place (adding
    // `hostedParticipants`) once agent processes are resolved. Submitting the
    // *same* object those two branches were racing on worked only by
    // accident of evaluation order (submitRun's fetch() args, including
    // JSON.stringify, are built synchronously before attach's first await)
    // — a fragile invariant nothing enforced. A deep clone removes the
    // shared mutable state entirely, so the two branches are safe under any
    // future reordering or added `await` in either one.
    const submissionDescriptor = structuredClone(compiled.runDescriptor);

    // CP-1 submission runs concurrently with agent bootstrap — it is a
    // best-effort observer registration, never a gate on the actual session,
    // which opens over direct agent→runtime gRPC regardless of this result.
    // Promise.allSettled (not Promise.all): even an unexpected throw from the
    // control-plane client must not block or fail agent bootstrap.
    // Note this bounds, but does not eliminate, added latency: allSettled
    // still awaits both branches, so a slow/unreachable control-plane holds
    // up this HTTP response for up to controlPlaneTimeoutMs even though
    // bootstrap itself already finished. Bootstrap correctness is unaffected
    // either way — only how long the caller waits for the response.
    const [controlPlaneSettled, hostedAgentsSettled] = await Promise.allSettled([
      this.controlPlaneClient.submitRun(submissionDescriptor),
      this.hosting.attach(compiled, {
        runId: sessionId,
        sessionId,
        scenarioRef: compiled.display.scenarioRef,
        modeName: session.modeName,
        modeVersion: session.modeVersion,
        configurationVersion: session.configurationVersion,
        policyVersion: session.policyVersion,
        policyHints: compiled.scenarioMeta.policyHints,
        ttlMs: session.ttlMs,
        sessionContext: compiled.scenarioMeta.sessionContext,
        participants: session.participants.map((p) => p.id),
        initiatorParticipantId: compiled.scenarioMeta.initiatorParticipantId,
        initiator: compiled.initiator
      })
    ]);

    if (hostedAgentsSettled.status === 'rejected') {
      throw hostedAgentsSettled.reason;
    }
    const hostedAgents = hostedAgentsSettled.value;

    let controlPlaneRun: RunExampleResult['controlPlaneRun'];
    if (controlPlaneSettled.status === 'fulfilled' && controlPlaneSettled.value) {
      controlPlaneRun = controlPlaneSettled.value;
    } else if (controlPlaneSettled.status === 'rejected') {
      const reason = controlPlaneSettled.reason instanceof Error ? controlPlaneSettled.reason.message : 'unknown error';
      this.logger.warn(`control_plane_submit_unexpected_throw sessionId=${sessionId} reason=${reason}`);
    }

    this.logger.log(
      `Scenario launched: sessionId=${sessionId} scenario=${compiled.display.scenarioRef} agents=${hostedAgents.length}`
    );

    return {
      compiled,
      hostedAgents,
      sessionId,
      ...(controlPlaneRun ? { controlPlaneRun } : {})
    };
  }

  private applyRequestOverrides(compiled: RunExampleResult['compiled'], request: RunExampleRequest): void {
    if (request.tags && request.tags.length > 0) {
      const existingTags = compiled.runDescriptor.execution?.tags ?? [];
      const merged = [...new Set([...existingTags, ...request.tags])];
      compiled.runDescriptor.execution = {
        ...(compiled.runDescriptor.execution ?? {}),
        tags: merged
      };
    }

    if (request.requester) {
      compiled.runDescriptor.execution = {
        ...(compiled.runDescriptor.execution ?? {}),
        requester: request.requester
      };
    }

    if (request.runLabel) {
      compiled.runDescriptor.session.metadata = {
        ...(compiled.runDescriptor.session.metadata ?? {}),
        runLabel: request.runLabel
      };
    }
  }
}
