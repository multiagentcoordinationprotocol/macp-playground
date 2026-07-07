import { Injectable, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { createScenarioAjv } from './ajv-factory';
import { CompileLaunchRequest, CompileLaunchResult, InitiatorPayload } from '../contracts/launch';
import { RunDescriptor } from '../contracts/run-descriptor';
import { ParticipantAgentBinding } from '../contracts/example-agents';
import { ScenarioVersionFile, ScenarioTemplateFile, KickoffTemplate } from '../contracts/registry';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RegistryIndexService } from '../registry/registry-index.service';
import { parseScenarioRef, extractSchemaDefaults, deepMerge, substitute } from './template-resolver';

function inferMessageType(kickoff: KickoffTemplate): string {
  if (kickoff.messageType) return kickoff.messageType;
  switch (kickoff.kind) {
    case 'proposal':
      return 'Proposal';
    case 'context':
      return 'Signal';
    case 'broadcast':
      return 'Signal';
    case 'request':
    default:
      return 'Signal';
  }
}

@Injectable()
export class CompilerService {
  private readonly ajv: Ajv;

  constructor(private readonly registryIndex: RegistryIndexService) {
    this.ajv = createScenarioAjv();
  }

  async compile(request: CompileLaunchRequest): Promise<CompileLaunchResult> {
    const { packSlug, scenarioSlug, version } = parseScenarioRef(request.scenarioRef);

    const scenario = await this.registryIndex.getScenarioVersion(packSlug, scenarioSlug, version);

    const schemaDefaults = extractSchemaDefaults(scenario.spec.inputs.schema);
    let resolvedDefaults = { ...schemaDefaults };
    let runtime = { ...(scenario.spec.runtime ?? { kind: 'rust', version: 'v1' }) };
    let launch = { ...scenario.spec.launch };
    let execution = { ...(scenario.spec.execution ?? {}) };

    if (request.templateId) {
      const template = await this.registryIndex.getTemplate(packSlug, scenarioSlug, version, request.templateId);
      resolvedDefaults = this.mergeDefaults(resolvedDefaults, template);
      runtime = this.mergeRuntime(runtime, template);
      launch = this.mergeLaunch(launch, template);
      execution = this.mergeExecution(execution, template);
    }

    const mergedInputs = {
      ...resolvedDefaults,
      ...request.inputs
    };

    this.validateInputs(scenario, mergedInputs);

    const substitutionVars = { inputs: mergedInputs };
    const context = launch.contextTemplate
      ? (substitute(launch.contextTemplate, substitutionVars) as Record<string, unknown>)
      : undefined;

    const metadataFromTemplate = launch.metadataTemplate
      ? (substitute(launch.metadataTemplate, substitutionVars) as Record<string, unknown>)
      : {};

    const kickoffTemplate = launch.kickoffTemplate
      ? (substitute(launch.kickoffTemplate, substitutionVars) as KickoffTemplate[])
      : undefined;

    const participantBindings: ParticipantAgentBinding[] = launch.participants.map((participant) => ({
      participantId: participant.id,
      role: participant.role,
      agentRef: participant.agentRef
    }));

    const initiatorParticipantId =
      launch.initiatorParticipantId ?? kickoffTemplate?.[0]?.from ?? launch.participants[0]?.id;

    const sessionId = randomUUID();
    const participantIds = launch.participants.map((participant) => participant.id);

    const tags = Array.from(
      new Set(['example', packSlug, scenarioSlug, ...(execution.tags ?? []), ...(scenario.metadata.tags ?? [])])
    );

    const firstKickoff = kickoffTemplate?.[0];
    const initiator: InitiatorPayload | undefined = initiatorParticipantId
      ? {
          participantId: initiatorParticipantId,
          sessionStart: {
            intent: String(metadataFromTemplate.intent ?? `${packSlug}/${scenarioSlug}`),
            participants: participantIds,
            ttlMs: launch.ttlMs,
            maxSuspendMs: launch.maxSuspendMs,
            modeVersion: launch.modeVersion,
            configurationVersion: launch.configurationVersion,
            policyVersion: launch.policyVersion,
            contextId: launch.contextId,
            extensions: launch.extensions
          },
          kickoff: firstKickoff
            ? {
                messageType: inferMessageType(firstKickoff),
                payloadType: firstKickoff.payloadEnvelope?.proto?.typeName,
                payload: (firstKickoff.payload ??
                  firstKickoff.payloadEnvelope?.json ??
                  firstKickoff.payloadEnvelope?.proto?.value ??
                  {}) as Record<string, unknown>
              }
            : undefined
        }
      : undefined;

    const runDescriptor: RunDescriptor = {
      mode: request.mode ?? 'sandbox',
      runtime: {
        kind: runtime.kind,
        version: runtime.version
      },
      session: {
        sessionId,
        modeName: launch.modeName,
        modeVersion: launch.modeVersion,
        configurationVersion: launch.configurationVersion,
        policyVersion: launch.policyVersion,
        ttlMs: launch.ttlMs,
        participants: participantIds.map((id) => ({ id })),
        metadata: {
          source: 'macp-playground',
          sourceRef: request.scenarioRef,
          scenarioRef: request.scenarioRef,
          templateId: request.templateId ?? 'default',
          environment: process.env.NODE_ENV ?? 'development',
          ...metadataFromTemplate
        }
      },
      execution: {
        idempotencyKey: execution.idempotencyKey,
        tags,
        requester: {
          actorId: execution.requester?.actorId ?? 'macp-playground',
          actorType: execution.requester?.actorType ?? 'service'
        }
      }
    };

    return {
      sessionId,
      mode: request.mode ?? 'sandbox',
      initiator,
      runDescriptor,
      scenarioMeta: {
        policyHints: launch.policyHints,
        sessionContext: context,
        initiatorParticipantId
      },
      display: {
        title: scenario.metadata.name,
        scenarioRef: request.scenarioRef,
        templateId: request.templateId,
        expectedDecisionKinds: scenario.spec.outputs?.expectedDecisionKinds
      },
      participantBindings
    };
  }

  private mergeDefaults(
    resolvedDefaults: Record<string, unknown>,
    template: ScenarioTemplateFile
  ): Record<string, unknown> {
    if (!template.spec.defaults) return resolvedDefaults;
    return { ...resolvedDefaults, ...template.spec.defaults };
  }

  private mergeRuntime(
    runtime: { kind: string; version?: string },
    template: ScenarioTemplateFile
  ): { kind: string; version?: string } {
    if (!template.spec.overrides?.runtime) return runtime;
    return { ...runtime, ...template.spec.overrides.runtime };
  }

  private mergeLaunch(
    launch: ScenarioVersionFile['spec']['launch'],
    template: ScenarioTemplateFile
  ): ScenarioVersionFile['spec']['launch'] {
    if (!template.spec.overrides?.launch) return launch;
    return deepMerge(launch, template.spec.overrides.launch) as ScenarioVersionFile['spec']['launch'];
  }

  private mergeExecution(
    execution: NonNullable<ScenarioVersionFile['spec']['execution']>,
    template: ScenarioTemplateFile
  ): NonNullable<ScenarioVersionFile['spec']['execution']> {
    if (!template.spec.overrides?.execution) return execution;
    return deepMerge(execution, template.spec.overrides.execution) as NonNullable<
      ScenarioVersionFile['spec']['execution']
    >;
  }

  private validateInputs(scenario: ScenarioVersionFile, inputs: Record<string, unknown>): void {
    const validate = this.ajv.compile(scenario.spec.inputs.schema);
    if (!validate(inputs)) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, 'Input validation failed', HttpStatus.BAD_REQUEST, {
        errors: validate.errors
      });
    }
  }
}
