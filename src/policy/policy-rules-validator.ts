import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MODE_SCHEMA_FILES: Record<string, string> = {
  'macp.mode.decision.v1': 'decision-rules.schema.json',
  'macp.mode.quorum.v1': 'quorum-rules.schema.json',
  'macp.mode.proposal.v1': 'proposal-rules.schema.json',
  'macp.mode.task.v1': 'task-rules.schema.json',
  'macp.mode.handoff.v1': 'handoff-rules.schema.json'
};

/**
 * Every scenario pack in this repo runs macp.mode.decision.v1 exclusively, and every
 * policy this repo has ever shipped — including the wildcard-mode one — uses the
 * decision `rules` shape. A mode-agnostic ("*") policy is therefore validated against
 * the decision schema. UNCONFIRMED assumption, logged to ASSUMPTIONS.md — see #81 /
 * plans/policy-rule-schema-validation.md, Phase 1.
 */
const WILDCARD_MODE = '*';
const WILDCARD_MODE_SCHEMA = 'macp.mode.decision.v1';

function loadSchema(schemasDir: string, filename: string): object {
  const raw = fs.readFileSync(path.join(schemasDir, filename), 'utf-8');
  return JSON.parse(raw) as object;
}

/**
 * ajv's own `.message` for additionalProperties is just "must NOT have additional
 * properties" — it never names the offending key. Fold `params.additionalProperty` (and
 * every error's `instancePath`) into the message so a rejection actually points at what
 * to fix (this is the issue's own motivating case: a typo like `veto_threshhold`).
 */
function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((error) => {
    const location = error.instancePath || '(root)';
    if (error.keyword === 'additionalProperties') {
      const extraKey = (error.params as { additionalProperty?: string }).additionalProperty;
      return `${location}: unrecognized key "${extraKey}"`;
    }
    return `${location}: ${error.message}`;
  });
}

/**
 * Validates governance-policy `rules` objects and full policy descriptors against the
 * real upstream JSON schemas vendored into schemas/policy/ (see its README for
 * provenance). Built to catch exactly the class of bug described in #81: an unknown key,
 * an out-of-range schema_version, or a designated_role authority with no designated
 * roles — none of which this repo validated at any tier before this class existed.
 */
export class PolicyRulesValidator {
  private readonly ruleValidators = new Map<string, ValidateFunction>();
  private readonly descriptorValidator: ValidateFunction;

  constructor() {
    // strict: false — the vendored schemas' conditional (if/then) arms trip ajv's
    // default `strict: "log"` mode (38 strictTypes warnings across the 5 files at
    // construction time), which would pollute startup/test output in a repo whose
    // conventions ban console.* logging. allErrors: true so a single validate() call
    // surfaces every violation, not just the first.
    const ajv = new Ajv2020({ allErrors: true, strict: false });

    // Resolved per-instance (matching the PolicyLoaderService.policiesDir precedent),
    // not as a module-level constant — so a test that changes cwd before constructing a
    // new validator actually exercises a different schemas/ directory.
    const schemasDir = path.resolve(process.cwd(), 'schemas/policy');

    for (const [mode, filename] of Object.entries(MODE_SCHEMA_FILES)) {
      this.ruleValidators.set(mode, ajv.compile(loadSchema(schemasDir, filename)));
    }

    this.descriptorValidator = ajv.compile(loadSchema(schemasDir, 'policy-descriptor.schema.json'));
  }

  /** Validates a `rules` object against the rule schema for the given mode. */
  validateRules(mode: string, rules: unknown): string[] {
    const effectiveMode = mode === WILDCARD_MODE ? WILDCARD_MODE_SCHEMA : mode;
    const validate = this.ruleValidators.get(effectiveMode);
    if (!validate) {
      return [`mode "${mode}": no vendored rule schema is registered for it, cannot validate`];
    }
    const valid = validate(rules);
    return valid ? [] : formatErrors(validate.errors);
  }

  /**
   * Validates a whole PolicyDefinition document (policy_id/mode/schema_version/rules/
   * description) against the descriptor schema. This is a separate, independent pass
   * from validateRules() — the descriptor schema requires `description` and types
   * `rules` as an unconstrained object, so it does not itself check rules' shape.
   */
  validateDescriptor(policy: unknown): string[] {
    const valid = this.descriptorValidator(policy);
    return valid ? [] : formatErrors(this.descriptorValidator.errors);
  }
}
