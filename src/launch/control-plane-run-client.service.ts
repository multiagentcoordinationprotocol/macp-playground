import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RunDescriptor, RunDescriptorResponse } from '../contracts/run-descriptor';

/**
 * Submits a `RunDescriptor` to the control-plane's CP-1 contract
 * (`POST /runs`) for scenario-agnostic observer registration. This is purely
 * additive to the direct-agent-auth flow: the runtime session is opened by
 * the initiator agent over its own gRPC channel regardless of whether this
 * call succeeds (RFC-MACP-0004 §4) — the control-plane never forges
 * envelopes and is never required for a session to run.
 *
 * Best-effort and non-fatal by design: every expected failure mode (unset
 * `controlPlaneUrl`, network error, timeout, non-2xx response) returns
 * `null` and logs a `warn`, mirroring `emitSessionContext` in
 * `risk-decider.worker.ts`. Never throws for these — the caller must not
 * let a control-plane hiccup block or delay agent bootstrap.
 */
@Injectable()
export class ControlPlaneRunClient {
  private readonly logger = new Logger(ControlPlaneRunClient.name);

  constructor(private readonly config: AppConfigService) {}

  async submitRun(descriptor: RunDescriptor): Promise<RunDescriptorResponse | null> {
    const base = this.config.controlPlaneUrl;
    if (!base) {
      this.logger.warn('control_plane_submit_skipped reason=controlPlaneUrl_unset');
      return null;
    }

    const url = `${base.replace(/\/+$/, '')}/runs`;
    const sessionId = descriptor.session.sessionId;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(descriptor),
        signal: AbortSignal.timeout(this.config.controlPlaneTimeoutMs)
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown network error';
      this.logger.warn(`control_plane_submit_failed sessionId=${sessionId} reason=network:${reason}`);
      return null;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      this.logger.warn(
        `control_plane_submit_failed sessionId=${sessionId} reason=http_${response.status} body=${bodyText.slice(0, 200)}`
      );
      return null;
    }

    let parsed: RunDescriptorResponse;
    try {
      parsed = (await response.json()) as RunDescriptorResponse;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid JSON';
      this.logger.warn(`control_plane_submit_failed sessionId=${sessionId} reason=parse:${reason}`);
      return null;
    }

    if (!parsed || typeof parsed.runId !== 'string' || !parsed.runId) {
      this.logger.warn(`control_plane_submit_failed sessionId=${sessionId} reason=missing_runId`);
      return null;
    }

    this.logger.log(
      `control_plane_submit_success sessionId=${sessionId} runId=${parsed.runId} status=${parsed.status}`
    );
    return parsed;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.controlPlaneApiKey) {
      headers['authorization'] = `Bearer ${this.config.controlPlaneApiKey}`;
    }
    return headers;
  }
}
