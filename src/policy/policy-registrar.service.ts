import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Auth, MacpClient } from 'macp-sdk-typescript';
import type { PolicyDescriptor as SdkPolicyDescriptor } from 'macp-sdk-typescript';
import { AppConfigService } from '../config/app-config.service';
import { AuthTokenMinterService } from '../auth/auth-token-minter.service';
import { PolicyLoaderService } from './policy-loader.service';
import type { PolicyDefinition } from '../contracts/policy';

const REGISTRAR_SENDER = 'macp-playground';

@Injectable()
export class PolicyRegistrarService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PolicyRegistrarService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly loader: PolicyLoaderService,
    private readonly minter: AuthTokenMinterService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.registerPoliciesOnLaunch) {
      this.logger.log('REGISTER_POLICIES_ON_LAUNCH=false — skipping policy registration');
      return;
    }

    if (!this.config.runtimeAddress) {
      this.logger.warn('MACP_RUNTIME_ADDRESS unset — skipping policy registration; launches will fail');
      return;
    }

    const policies = this.loader.listRegistrablePolicies();
    if (policies.length === 0) {
      this.logger.warn('no policies to register');
      return;
    }

    let token: string;
    try {
      const minted = await this.minter.mintToken(REGISTRAR_SENDER, {
        can_manage_mode_registry: true,
        is_observer: false,
        allowed_modes: ['*']
      });
      token = minted.token;
    } catch (err) {
      this.logger.error(
        `policy registration aborted: failed to mint admin JWT — launches will fail with UNKNOWN_POLICY_VERSION. ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const client = new MacpClient({
      address: this.config.runtimeAddress,
      secure: this.config.runtimeTls,
      allowInsecure: this.config.runtimeAllowInsecure,
      auth: Auth.bearer(token, { expectedSender: REGISTRAR_SENDER })
    });

    const counts = { registered: 0, already: 0, managedByRuntime: 0, missing: 0, failed: 0 };
    const missingPolicyIds: string[] = [];
    // Once the runtime reports a read-only registry (v0.5.0 with MACP_POLICIES_DIR
    // set), mutating RPCs are pointless — switch to verify-only for the remainder.
    let readOnlyRegistry = false;

    for (const policy of policies) {
      if (readOnlyRegistry) {
        await this.verifyManagedPolicy(client, policy, counts, missingPolicyIds);
        continue;
      }

      const descriptor = this.toDescriptor(policy);
      try {
        const result = await client.registerPolicy(descriptor);
        if (result.ok) {
          counts.registered += 1;
          this.logger.log(`policy_registered policy_id=${policy.policy_id} mode=${policy.mode}`);
        } else if (this.isAlreadyRegisteredError(result.error)) {
          counts.already += 1;
          this.logger.log(`policy_already_registered policy_id=${policy.policy_id}`);
        } else if (this.isReadOnlyRegistryError(result.error)) {
          readOnlyRegistry = true;
          this.logger.log(
            `policy registry is read-only (runtime MACP_POLICIES_DIR) — switching to verification; ` +
              `set REGISTER_POLICIES_ON_LAUNCH=false to skip this probe`
          );
          await this.verifyManagedPolicy(client, policy, counts, missingPolicyIds);
        } else {
          counts.failed += 1;
          this.logger.warn(`policy_register_failed policy_id=${policy.policy_id} error=${result.error ?? 'unknown'}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (this.isReadOnlyRegistryError(message)) {
          readOnlyRegistry = true;
          this.logger.log(
            `policy registry is read-only (runtime MACP_POLICIES_DIR) — switching to verification; ` +
              `set REGISTER_POLICIES_ON_LAUNCH=false to skip this probe`
          );
          await this.verifyManagedPolicy(client, policy, counts, missingPolicyIds);
        } else {
          counts.failed += 1;
          this.logger.warn(`policy_register_exception policy_id=${policy.policy_id} ${message}`);
        }
      }
    }

    if (readOnlyRegistry && missingPolicyIds.length > 0) {
      this.logger.error(
        `policy registry is read-only and ${missingPolicyIds.length} required ` +
          `${missingPolicyIds.length === 1 ? 'policy is' : 'policies are'} MISSING from the runtime — ` +
          `launches referencing ${missingPolicyIds.length === 1 ? 'it' : 'them'} will fail UNKNOWN_POLICY_VERSION. ` +
          `Mount these descriptors into the runtime's MACP_POLICIES_DIR: ${missingPolicyIds
            .map((id) => `${id}.json`)
            .join(', ')}`
      );
    }

    this.logger.log(
      `policy_registration_complete registered=${counts.registered} already=${counts.already} ` +
        `managed_by_runtime=${counts.managedByRuntime} missing=${counts.missing} failed=${counts.failed} ` +
        `read_only=${readOnlyRegistry} total=${policies.length}`
    );
  }

  /**
   * Verify (read-only) that a policy is already present in a runtime that owns
   * its registry via MACP_POLICIES_DIR. Uses `getPolicy`, which throws (NOT_FOUND)
   * when the policy is absent.
   */
  private async verifyManagedPolicy(
    client: MacpClient,
    policy: PolicyDefinition,
    counts: { managedByRuntime: number; missing: number; failed: number },
    missingPolicyIds: string[]
  ): Promise<void> {
    try {
      const descriptor = await client.getPolicy(policy.policy_id);
      if (descriptor?.policyId === policy.policy_id) {
        counts.managedByRuntime += 1;
        this.logger.log(`policy_managed_by_runtime policy_id=${policy.policy_id}`);
      } else {
        counts.missing += 1;
        missingPolicyIds.push(policy.policy_id);
        this.logger.warn(`policy_missing_in_runtime policy_id=${policy.policy_id}`);
      }
    } catch (err) {
      counts.missing += 1;
      missingPolicyIds.push(policy.policy_id);
      this.logger.warn(
        `policy_missing_in_runtime policy_id=${policy.policy_id} ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private toDescriptor(policy: PolicyDefinition): SdkPolicyDescriptor {
    return {
      policyId: policy.policy_id,
      mode: policy.mode,
      description: policy.description ?? '',
      rules: JSON.stringify(policy.rules),
      schemaVersion: policy.schema_version
    };
  }

  private isAlreadyRegisteredError(error: string | undefined): boolean {
    if (!error) return false;
    return error.toLowerCase().includes('already');
  }

  /**
   * Detect a read-only policy registry. A runtime started with MACP_POLICIES_DIR
   * (v0.5.0) rejects mutating policy RPCs with FAILED_PRECONDITION, referencing
   * the read-only / file-managed registry.
   */
  private isReadOnlyRegistryError(error: string | undefined): boolean {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return (
      normalized.includes('failed_precondition') ||
      normalized.includes('read-only') ||
      normalized.includes('read only') ||
      normalized.includes('policies_dir') ||
      normalized.includes('policies dir') ||
      normalized.includes('file-managed') ||
      normalized.includes('managed by the runtime')
    );
  }
}
