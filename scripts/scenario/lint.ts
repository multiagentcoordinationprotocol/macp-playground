import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadYamlWithIncludes } from '../../src/registry/include-resolver';
import { ScenarioVersionFile, PackFile, ScenarioTemplateFile } from '../../src/contracts/registry';
import { ExampleAgentCatalogService } from '../../src/example-agents/example-agent-catalog.service';
import { PolicyDefinition } from '../../src/contracts/policy';
import { PolicyRulesValidator } from '../../src/policy/policy-rules-validator';

export interface LintOptions {
  target: string;
  packsRoot: string;
}

interface LintFinding {
  level: 'error' | 'warn';
  file: string;
  message: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const POLICIES_DIR_NAME = 'policies';

function listPackDirs(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [];

  // Detect: is this the packs root or a single pack?
  const packYaml = path.join(target, 'pack.yaml');
  if (fs.existsSync(packYaml)) return [target];

  const out: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const dir = path.join(target, entry.name);
    if (fs.existsSync(path.join(dir, 'pack.yaml'))) out.push(dir);
  }
  return out;
}

function listScenarioVersionDirs(packDir: string): string[] {
  const scenariosRoot = path.join(packDir, 'scenarios');
  if (!fs.existsSync(scenariosRoot)) return [];
  const out: string[] = [];
  for (const slug of fs.readdirSync(scenariosRoot)) {
    const sDir = path.join(scenariosRoot, slug);
    if (!fs.statSync(sDir).isDirectory()) continue;
    for (const ver of fs.readdirSync(sDir)) {
      const vDir = path.join(sDir, ver);
      if (fs.statSync(vDir).isDirectory() && fs.existsSync(path.join(vDir, 'scenario.yaml'))) {
        out.push(vDir);
      }
    }
  }
  return out;
}

function discoverIncludes(filePath: string, hits: Set<string>): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const re = /!include\s+([^\s\n]+)/g;
  let m: RegExpExecArray | null;
  const dir = path.dirname(filePath);
  while ((m = re.exec(content)) !== null) {
    const resolved = path.resolve(dir, m[1]);
    hits.add(resolved);
  }
}

function gatherAllIncludes(versionDir: string): Set<string> {
  const hits = new Set<string>();
  const scenarioYaml = path.join(versionDir, 'scenario.yaml');
  if (fs.existsSync(scenarioYaml)) discoverIncludes(scenarioYaml, hits);
  const templatesDir = path.join(versionDir, 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const f of fs.readdirSync(templatesDir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        discoverIncludes(path.join(templatesDir, f), hits);
      }
    }
  }
  // recurse into included files too
  for (const inc of Array.from(hits)) {
    if (inc.endsWith('.yaml') || inc.endsWith('.yml')) {
      if (fs.existsSync(inc)) discoverIncludes(inc, hits);
    }
  }
  return hits;
}

function lintPack(
  packDir: string,
  packsRoot: string,
  knownAgentRefs: Set<string>,
  knownPolicies: Map<string, PolicyDefinition>,
  rulesValidator: PolicyRulesValidator,
  validatedPolicyIds: Set<string>
): LintFinding[] {
  const findings: LintFinding[] = [];
  const packYaml = path.join(packDir, 'pack.yaml');
  let pack: PackFile;
  try {
    pack = loadYamlWithIncludes(packYaml, packsRoot) as PackFile;
  } catch (err) {
    findings.push({ level: 'error', file: packYaml, message: `failed to load: ${err instanceof Error ? err.message : String(err)}` });
    return findings;
  }

  if (!SLUG_RE.test(pack.metadata?.slug ?? '')) {
    findings.push({ level: 'error', file: packYaml, message: `pack slug must be kebab-case: "${pack.metadata?.slug}"` });
  }

  for (const versionDir of listScenarioVersionDirs(packDir)) {
    const scenarioYaml = path.join(versionDir, 'scenario.yaml');
    let scenario: ScenarioVersionFile;
    try {
      scenario = loadYamlWithIncludes(scenarioYaml, packsRoot) as ScenarioVersionFile;
    } catch (err) {
      findings.push({ level: 'error', file: scenarioYaml, message: `failed to load: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    const slug = scenario?.metadata?.scenario;
    if (slug && !SLUG_RE.test(slug)) {
      findings.push({ level: 'error', file: scenarioYaml, message: `scenario slug must be kebab-case: "${slug}"` });
    }

    // Commitment description rule
    for (const c of scenario?.spec?.launch?.commitments ?? []) {
      if (!c.description || !c.description.trim()) {
        findings.push({ level: 'error', file: scenarioYaml, message: `commitment "${c.id}" missing description` });
      }
    }

    // policyVersion existence
    const policyVersion = scenario?.spec?.launch?.policyVersion;
    if (policyVersion && policyVersion !== 'policy.default' && !knownPolicies.has(policyVersion)) {
      findings.push({ level: 'warn', file: scenarioYaml, message: `policyVersion "${policyVersion}" not found in /${POLICIES_DIR_NAME}` });
    }

    // policyVersion rules-schema conformance (#81) — runs against policy.default.json too,
    // even though the existence check above skips it (that check exists because
    // policy.default is a reserved runtime built-in, not because its file's shape is exempt
    // from validation). Deduped per policy_id across the whole lint run (via
    // validatedPolicyIds, shared across all lintPack() calls) so a policy referenced by many
    // scenarios/packs is only checked and reported once.
    if (policyVersion) {
      const referencedPolicy = knownPolicies.get(policyVersion);
      if (referencedPolicy && !validatedPolicyIds.has(policyVersion)) {
        validatedPolicyIds.add(policyVersion);
        const schemaErrors = rulesValidator.validateRules(referencedPolicy.mode, referencedPolicy.rules);
        for (const schemaError of schemaErrors) {
          findings.push({
            level: 'error',
            file: scenarioYaml,
            message: `policyVersion "${policyVersion}" fails rules-schema validation: ${schemaError}`
          });
        }
      }
    }

    // agentRef existence
    for (const p of scenario?.spec?.launch?.participants ?? []) {
      if (!knownAgentRefs.has(p.agentRef)) {
        findings.push({ level: 'error', file: scenarioYaml, message: `participant "${p.id}" agentRef "${p.agentRef}" not in catalog` });
      }
    }

    // Template partial-array warning
    const templatesDir = path.join(versionDir, 'templates');
    if (fs.existsSync(templatesDir)) {
      for (const f of fs.readdirSync(templatesDir)) {
        if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
        const tp = path.join(templatesDir, f);
        try {
          const tmpl = loadYamlWithIncludes(tp, packsRoot) as ScenarioTemplateFile;
          const overrideCommit = tmpl?.spec?.overrides?.launch?.commitments;
          if (Array.isArray(overrideCommit) && overrideCommit.length < (scenario?.spec?.launch?.commitments?.length ?? 0)) {
            findings.push({
              level: 'warn',
              file: tp,
              message: `commitments override has fewer items than scenario — arrays REPLACE entirely (not merged)`
            });
          }
        } catch (err) {
          findings.push({ level: 'error', file: tp, message: `failed to load: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }

    // Orphan check: data/ and fixtures/ files not referenced by any include
    const includedPaths = gatherAllIncludes(versionDir);
    for (const sub of ['data', 'fixtures']) {
      const subDir = path.join(versionDir, sub);
      if (!fs.existsSync(subDir)) continue;
      for (const f of fs.readdirSync(subDir)) {
        if (sub === 'fixtures') continue; // fixtures don't need to be !include'd
        const filePath = path.join(subDir, f);
        if (!fs.statSync(filePath).isFile()) continue;
        if (!includedPaths.has(filePath)) {
          findings.push({ level: 'warn', file: filePath, message: `data file is not referenced by any !include` });
        }
      }
    }
  }

  return findings;
}

function loadKnownPolicies(repoRoot: string): Map<string, PolicyDefinition> {
  const dir = path.join(repoRoot, POLICIES_DIR_NAME);
  const out = new Map<string, PolicyDefinition>();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as PolicyDefinition;
      if (json.policy_id) out.set(json.policy_id, json);
    } catch {
      // ignore
    }
  }
  return out;
}

export async function runLint(opts: LintOptions): Promise<number> {
  const packsRoot = path.resolve(opts.packsRoot);
  const target = path.resolve(opts.target);
  const repoRoot = path.dirname(packsRoot);
  const catalog = new ExampleAgentCatalogService();
  const knownAgentRefs = new Set(catalog.list().map((a) => a.agentRef));
  const knownPolicies = loadKnownPolicies(repoRoot);
  const rulesValidator = new PolicyRulesValidator();
  const validatedPolicyIds = new Set<string>();

  const packDirs = listPackDirs(target);
  if (packDirs.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`no packs found under ${target}`);
    return 1;
  }

  let errors = 0;
  let warns = 0;
  for (const packDir of packDirs) {
    const findings = lintPack(packDir, packsRoot, knownAgentRefs, knownPolicies, rulesValidator, validatedPolicyIds);
    for (const f of findings) {
      const tag = f.level === 'error' ? 'FAIL' : 'WARN';
      const stream = f.level === 'error' ? console.error : console.log;
      // eslint-disable-next-line no-console
      stream(`  ${tag}  ${path.relative(process.cwd(), f.file)}: ${f.message}`);
      if (f.level === 'error') errors++;
      else warns++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`scenario:lint  ${packDirs.length} pack(s) — ${errors} error(s), ${warns} warning(s)`);
  return errors > 0 ? 1 : 0;
}
