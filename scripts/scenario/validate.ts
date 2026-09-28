import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadYamlWithIncludes } from '../../src/registry/include-resolver';
import { createScenarioAjv } from '../../src/compiler/ajv-factory';
import { extractSchemaDefaults } from '../../src/compiler/template-resolver';
import { ScenarioVersionFile, ScenarioTemplateFile } from '../../src/contracts/registry';
import { ExampleAgentCatalogService } from '../../src/example-agents/example-agent-catalog.service';

export interface ValidateOptions {
  target: string;
  packsRoot: string;
}

export interface ValidateReport {
  errors: string[];
  warnings: string[];
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g;

function resolveScenarioPath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return path.join(target, 'scenario.yaml');
  }
  return target;
}

function collectPlaceholders(node: unknown, paths: Set<string>): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    PLACEHOLDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_RE.exec(node)) !== null) {
      paths.add(match[1]);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => collectPlaceholders(item, paths));
    return;
  }
  if (typeof node === 'object') {
    Object.values(node as Record<string, unknown>).forEach((v) => collectPlaceholders(v, paths));
  }
}

function pathExists(obj: Record<string, unknown> | undefined, dottedPath: string): boolean {
  if (!obj) return false;
  const parts = dottedPath.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur !== undefined;
}

export async function runValidate(opts: ValidateOptions): Promise<number> {
  const report: ValidateReport = { errors: [], warnings: [] };
  const packsRoot = path.resolve(opts.packsRoot);
  const scenarioPath = path.resolve(resolveScenarioPath(opts.target));

  if (!fs.existsSync(scenarioPath)) {
    report.errors.push(`scenario file not found: ${scenarioPath}`);
    printReport(report, scenarioPath);
    return 1;
  }

  let scenario: ScenarioVersionFile;
  try {
    scenario = loadYamlWithIncludes(scenarioPath, packsRoot) as ScenarioVersionFile;
  } catch (err) {
    report.errors.push(`load failed: ${err instanceof Error ? err.message : String(err)}`);
    printReport(report, scenarioPath);
    return 1;
  }

  if (scenario?.apiVersion !== 'scenarios.macp.dev/v1') {
    report.errors.push(`apiVersion must be "scenarios.macp.dev/v1", got: ${scenario?.apiVersion}`);
  }
  if (scenario?.kind !== 'ScenarioVersion') {
    report.errors.push(`kind must be "ScenarioVersion", got: ${scenario?.kind}`);
  }
  if (!scenario?.metadata?.pack || !scenario?.metadata?.scenario || !scenario?.metadata?.version) {
    report.errors.push('metadata must include pack, scenario, and version');
  }

  const ajv = createScenarioAjv();
  const inputSchema = scenario?.spec?.inputs?.schema as Record<string, unknown> | undefined;
  if (!inputSchema) {
    report.errors.push('spec.inputs.schema is required');
  } else {
    try {
      ajv.compile(inputSchema);
    } catch (err) {
      report.errors.push(
        `spec.inputs.schema is not valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Validate each fixture if present
  const scenarioDir = path.dirname(scenarioPath);
  const fixturesDir = path.join(scenarioDir, 'fixtures');
  const fixtures: Array<{ name: string; data: Record<string, unknown> }> = [];
  if (fs.existsSync(fixturesDir) && fs.statSync(fixturesDir).isDirectory() && inputSchema) {
    const validate = ajv.compile(inputSchema);
    const schemaDefaults = extractSchemaDefaults(inputSchema);
    for (const file of fs.readdirSync(fixturesDir)) {
      if (!file.endsWith('.json')) continue;
      const fixturePath = path.join(fixturesDir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as Record<string, unknown>;
        const merged = { ...schemaDefaults, ...raw };
        if (!validate(merged)) {
          report.errors.push(
            `fixture ${file} fails JSON Schema: ${ajv.errorsText(validate.errors, { separator: '; ' })}`
          );
        } else {
          fixtures.push({ name: file, data: merged });
        }
      } catch (err) {
        report.errors.push(`fixture ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Validate each template
  const templatesDir = path.join(scenarioDir, 'templates');
  if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
    for (const file of fs.readdirSync(templatesDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const templatePath = path.join(templatesDir, file);
      try {
        const tmpl = loadYamlWithIncludes(templatePath, packsRoot) as ScenarioTemplateFile;
        if (tmpl?.kind !== 'ScenarioTemplate') {
          report.warnings.push(`templates/${file} kind is "${tmpl?.kind}", expected "ScenarioTemplate"`);
        }
        if (tmpl?.spec?.overrides?.launch && inputSchema) {
          // Re-validate merged inputs using template defaults
          const merged = { ...extractSchemaDefaults(inputSchema), ...(tmpl.spec.defaults ?? {}) };
          const validate = ajv.compile(inputSchema);
          if (!validate(merged)) {
            report.warnings.push(
              `templates/${file} defaults fail schema: ${ajv.errorsText(validate.errors, { separator: '; ' })}`
            );
          }
        }
        // Warn on partial commitments override
        const overrideCommitments = tmpl?.spec?.overrides?.launch?.commitments;
        if (Array.isArray(overrideCommitments)) {
          report.warnings.push(
            `templates/${file} overrides commitments — note arrays REPLACE entirely (not merged element-wise)`
          );
        }
      } catch (err) {
        report.errors.push(`templates/${file} load failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Placeholder reachability check
  const placeholders = new Set<string>();
  collectPlaceholders(scenario?.spec?.launch?.contextTemplate, placeholders);
  collectPlaceholders(scenario?.spec?.launch?.metadataTemplate, placeholders);
  collectPlaceholders(scenario?.spec?.launch?.kickoffTemplate, placeholders);
  collectPlaceholders(scenario?.spec?.launch?.commitments, placeholders);

  if (placeholders.size > 0 && inputSchema) {
    const schemaDefaults = extractSchemaDefaults(inputSchema);
    const sourcesToCheck: Array<Record<string, unknown>> = [
      { inputs: schemaDefaults },
      ...fixtures.map((f) => ({ inputs: f.data }))
    ];
    for (const ph of placeholders) {
      const reachable = sourcesToCheck.some((src) => pathExists(src, ph));
      if (!reachable) {
        report.errors.push(`placeholder {{ ${ph} }} is not satisfied by schema defaults or any fixture`);
      }
    }
  }

  // agentRef integrity
  const catalog = new ExampleAgentCatalogService();
  const knownAgentRefs = new Set(catalog.list().map((a) => a.agentRef));
  const participants = scenario?.spec?.launch?.participants ?? [];
  for (const p of participants) {
    if (!knownAgentRefs.has(p.agentRef)) {
      report.errors.push(`participant ${p.id} agentRef "${p.agentRef}" is not in the example-agent catalog`);
    }
  }

  // Commitment description warning. `typeof`-guarded, not truthiness-guarded — see the matching
  // comment in scripts/scenario/lint.ts: `scenario` is an unvalidated cast over arbitrary YAML, so
  // a non-string `description` must produce a report entry, never a TypeError that kills the run.
  const commitments = scenario?.spec?.launch?.commitments ?? [];
  for (const c of commitments) {
    if (typeof c.description !== 'string' || !c.description.trim()) {
      report.warnings.push(`commitment ${c.id} has no description`);
    }
  }

  printReport(report, scenarioPath);
  return report.errors.length > 0 ? 1 : 0;
}

function printReport(report: ValidateReport, scenarioPath: string): void {
  // eslint-disable-next-line no-console -- the validation report on stdout is this command's output
  console.log(`scenario:validate  ${scenarioPath}`);
  for (const w of report.warnings) {
    // eslint-disable-next-line no-console -- warnings belong on stdout with the rest of the report
    console.log(`  WARN  ${w}`);
  }
  for (const e of report.errors) {
    console.error(`  FAIL  ${e}`);
  }
  if (report.errors.length === 0 && report.warnings.length === 0) {
    // eslint-disable-next-line no-console -- terminal verdict on stdout
    console.log('  OK');
  } else if (report.errors.length === 0) {
    // eslint-disable-next-line no-console -- terminal verdict on stdout
    console.log(`  PASS (${report.warnings.length} warning(s))`);
  } else {
    console.error(`  FAILED (${report.errors.length} error(s), ${report.warnings.length} warning(s))`);
  }
}
