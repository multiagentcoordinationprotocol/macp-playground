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

const WILDCARD_MODE = '*';

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
  // Top-level rules key (e.g. "commitment", "voting") -> the sub-schema validators of
  // every mode that recognizes it. Built for wildcard-mode validation — see
  // validateWildcardRules(). None of the 5 vendored schemas use $ref/$defs, so slicing
  // out a `properties[key]` sub-schema and compiling it standalone is safe.
  private readonly topLevelKeyOwners = new Map<string, ValidateFunction[]>();

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
      const schema = loadSchema(schemasDir, filename) as { properties?: Record<string, object> };
      this.ruleValidators.set(mode, ajv.compile(schema));

      for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
        const owners = this.topLevelKeyOwners.get(key) ?? [];
        owners.push(ajv.compile(subSchema));
        this.topLevelKeyOwners.set(key, owners);
      }
    }

    this.descriptorValidator = ajv.compile(loadSchema(schemasDir, 'policy-descriptor.schema.json'));
  }

  /** Validates a `rules` object against the rule schema for the given mode. */
  validateRules(mode: string, rules: unknown): string[] {
    if (mode === WILDCARD_MODE) {
      return this.validateWildcardRules(rules);
    }
    const validate = this.ruleValidators.get(mode);
    if (!validate) {
      return [`mode "${mode}": no vendored rule schema is registered for it, cannot validate`];
    }
    const valid = validate(rules);
    return valid ? [] : formatErrors(validate.errors);
  }

  /**
   * A "*" (wildcard-mode) policy is bound to whichever mode's session actually starts —
   * the runtime validates it against every standards-track mode's rules schema, not just
   * Decision's (macp-runtime crates/macp-policy/src/registry.rs:369-414, closing a
   * fail-open defect fixed in runtime commit 298c0f4: a Decision-only wildcard dispatch —
   * this validator's original approach — let a quorum `threshold` field through with no
   * check of any kind).
   *
   * Unlike a mode-specific policy, a wildcard policy legitimately carries top-level keys
   * only *some* modes recognize (this repo's own policy.default.json uses Decision's
   * voting/objection_handling/evaluation shape; `commitment` is recognized by all 5,
   * `acceptance` by proposal and handoff). Whole-object validation against all 5 schemas
   * at once doesn't work here: it would either reject every legitimate mode-specific key
   * as "unrecognized" by the other 4 schemas, or — if additionalProperties errors are
   * blanket-suppressed to work around that — silently swallow a genuine typo too (an
   * earlier version of this method did exactly that; caught by
   * policy-rules-validator.spec.ts's own `broken`/`veto_threshhold` case).
   *
   * So this validates **per top-level key**, not per whole object: each key present in
   * `rules` is checked against every mode's sub-schema that declares it (topLevelKeyOwners,
   * built at construction time), and passes if it's valid against *at least one* of them —
   * "legitimate under some mode this wildcard could bind to." A key no schema declares at
   * all is a real, unconditional error. This also naturally reproduces real typo-catching
   * inside a key only one mode owns (e.g. `objection_handling.veto_threshhold`): since
   * only Decision declares `objection_handling`, that's the only candidate, and Decision's
   * own sub-schema still rejects the typo.
   */
  private validateWildcardRules(rules: unknown): string[] {
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      // Not a validatable object at all — delegate to one whole-schema validator for a
      // sensible top-level type error; every mode's schema agrees rules must be an object.
      const validate = this.ruleValidators.get('macp.mode.decision.v1')!;
      const valid = validate(rules);
      return valid ? [] : formatErrors(validate.errors);
    }

    const errors: string[] = [];
    for (const key of Object.keys(rules as Record<string, unknown>)) {
      const owners = this.topLevelKeyOwners.get(key);
      if (!owners || owners.length === 0) {
        errors.push(`(root): unrecognized key "${key}"`);
        continue;
      }

      const value = (rules as Record<string, unknown>)[key];
      const acceptedByAtLeastOneMode = owners.some((validate) => validate(value));
      if (acceptedByAtLeastOneMode) {
        continue;
      }

      // No candidate mode accepted this key's value — report the first owner's errors
      // (deterministic: MODE_SCHEMA_FILES' declaration order), with instancePath rebased
      // from the sub-schema's root onto this key's actual position in `rules`.
      const firstOwnerErrors = owners[0].errors ?? [];
      const rebased = firstOwnerErrors.map((error) => ({ ...error, instancePath: `/${key}${error.instancePath}` }));
      errors.push(...formatErrors(rebased));
    }
    return errors;
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
