import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PolicyDefinition } from '../contracts/policy';

@Injectable()
export class PolicyLoaderService {
  private readonly logger = new Logger(PolicyLoaderService.name);
  private readonly policiesDir: string;
  private cache: Map<string, PolicyDefinition> | undefined;

  constructor() {
    this.policiesDir = path.resolve(process.cwd(), 'policies');
  }

  loadPolicy(policyId: string): PolicyDefinition | undefined {
    this.ensureLoaded();
    return this.cache!.get(policyId);
  }

  listAvailablePolicies(): PolicyDefinition[] {
    this.ensureLoaded();
    return [...this.cache!.values()];
  }

  listRegistrablePolicies(): PolicyDefinition[] {
    return this.listAvailablePolicies().filter((p) => p.policy_id !== 'policy.default');
  }

  validatePolicy(policy: PolicyDefinition): string[] {
    const errors: string[] = [];
    if (!policy.policy_id) {
      errors.push('policy_id is required');
    }
    if (!policy.schema_version || policy.schema_version < 1) {
      errors.push('schema_version must be >= 1');
    }
    if (!policy.rules || typeof policy.rules !== 'object') {
      errors.push('rules object is required');
      return errors;
    }

    const { voting, objection_handling, evaluation, commitment } = policy.rules;

    if (voting) {
      if (voting.algorithm === 'supermajority' && (voting.threshold == null || voting.threshold <= 0.5)) {
        errors.push('supermajority algorithm requires threshold > 0.5');
      }
      if (voting.algorithm === 'weighted' && (!voting.weights || Object.keys(voting.weights).length === 0)) {
        errors.push('weighted algorithm requires a non-empty weights map');
      }
    }

    if (objection_handling) {
      if (objection_handling.veto_threshold != null && objection_handling.veto_threshold < 1) {
        errors.push('veto_threshold must be >= 1');
      }
    }

    if (evaluation) {
      if (
        evaluation.minimum_confidence != null &&
        (evaluation.minimum_confidence < 0 || evaluation.minimum_confidence > 1)
      ) {
        errors.push('minimum_confidence must be between 0 and 1');
      }
    }

    if (commitment) {
      if (
        commitment.authority === 'designated_role' &&
        (!commitment.designated_roles || commitment.designated_roles.length === 0)
      ) {
        errors.push('designated_role authority requires a non-empty designated_roles array');
      }
    }

    return errors;
  }

  private ensureLoaded(): void {
    if (this.cache) return;
    this.cache = new Map();

    if (!fs.existsSync(this.policiesDir)) {
      this.logger.warn(`policies directory not found: ${this.policiesDir}`);
      return;
    }

    const files = fs.readdirSync(this.policiesDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.policiesDir, file), 'utf-8');
        const policy = JSON.parse(raw) as PolicyDefinition;
        if (!policy.policy_id) {
          this.logger.warn(`skipping policy file ${file}: missing policy_id`);
          continue;
        }

        const validationErrors = this.validatePolicy(policy);
        if (validationErrors.length > 0) {
          this.logger.warn(`policy ${policy.policy_id} has validation warnings: ${validationErrors.join('; ')}`);
        }

        this.cache.set(policy.policy_id, policy);
      } catch (err) {
        this.logger.warn(`failed to load policy file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.log(`loaded ${this.cache.size} policies from ${this.policiesDir}`);
  }
}
