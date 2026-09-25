import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PolicyDefinition } from '../contracts/policy';
import { PolicyRulesValidator } from './policy-rules-validator';

/**
 * Mirrors `SUPPORTED_SCHEMA_VERSIONS` in macp-runtime's
 * `crates/macp-policy/src/evaluator.rs`. A policy above this version loads
 * and registers cleanly but the runtime denies every commitment under it
 * with "unsupported policy schema version" — a silent-at-authoring-time,
 * loud-at-runtime failure mode this check catches early.
 */
const MAX_SUPPORTED_SCHEMA_VERSION = 3;

@Injectable()
export class PolicyLoaderService {
  private readonly logger = new Logger(PolicyLoaderService.name);
  private readonly policiesDir: string;
  private readonly rulesValidator: PolicyRulesValidator;
  private cache: Map<string, PolicyDefinition> | undefined;

  constructor() {
    this.policiesDir = path.resolve(process.cwd(), 'policies');
    // Constructed internally rather than injected — this repo has no other consumer of
    // PolicyRulesValidator today, and DI would touch app.module.ts plus every
    // `new PolicyLoaderService()` call site across the spec files for no behavioral benefit.
    // See #81 / plan Phase 2.
    this.rulesValidator = new PolicyRulesValidator();
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
    } else if (policy.schema_version > MAX_SUPPORTED_SCHEMA_VERSION) {
      errors.push(
        `schema_version ${policy.schema_version} exceeds the highest version this evaluator supports (${MAX_SUPPORTED_SCHEMA_VERSION}); every commitment under this policy will be denied with "unsupported policy schema version"`
      );
    }
    if (!policy.rules || typeof policy.rules !== 'object') {
      errors.push('rules object is required');
      return errors;
    }

    const { objection_handling } = policy.rules;

    if (objection_handling) {
      // Stricter than the upstream schema, deliberately: the schema defaults an absent
      // veto_threshold to 1 and only reads it when critical_severity_vetoes is true, but
      // requiring it explicitly here makes the intent visible in the policy file itself.
      // Costs nothing — this case is schema-legal either way. Kept per #81 / plan Phase 2;
      // not a redundant check, do not remove alongside the ones below.
      if (
        objection_handling.critical_severity_vetoes &&
        (objection_handling.veto_threshold == null || objection_handling.veto_threshold < 1)
      ) {
        errors.push('veto_threshold must be >= 1 when critical_severity_vetoes is true');
      }
      // Corrected per #81 / plan Phase 2: previously excluded veto_threshold === 0 from this
      // warning, which is exactly what steered authors toward the one value (0) that fails
      // the real upstream schema's `minimum: 1`. Any presence of veto_threshold when vetoes
      // are off is now flagged — the schema-conformant fix is to omit the key entirely.
      if (!objection_handling.critical_severity_vetoes && objection_handling.veto_threshold != null) {
        errors.push('veto_threshold is set but critical_severity_vetoes is false — the threshold is never read');
      }
    }

    // Real upstream schema validation (#81) — supersedes the hand-rolled supermajority-
    // threshold, weighted-weights, minimum_confidence-range, and designated_role checks that
    // used to live here; all four are now exactly covered by the vendored schema instead.
    errors.push(...this.rulesValidator.validateRules(policy.mode, policy.rules));

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
