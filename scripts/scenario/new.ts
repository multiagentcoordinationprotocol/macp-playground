import * as fs from 'node:fs';
import * as path from 'node:path';

export interface NewOptions {
  pack: string;
  scenario: string;
  version: string;
  fromScenarioRef?: string;
  packsRoot: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseScenarioRef(ref: string): { pack: string; scenario: string; version: string } {
  const at = ref.lastIndexOf('@');
  if (at === -1) throw new Error(`invalid --from ref (missing @): ${ref}`);
  const left = ref.slice(0, at);
  const version = ref.slice(at + 1);
  const slash = left.indexOf('/');
  if (slash === -1) throw new Error(`invalid --from ref (missing /): ${ref}`);
  return { pack: left.slice(0, slash), scenario: left.slice(slash + 1), version };
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rewriteFile(filePath: string, replacements: Record<string, string>): void {
  let content = fs.readFileSync(filePath, 'utf-8');
  for (const [k, v] of Object.entries(replacements)) {
    content = content.split(k).join(v);
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

function rewriteTreeFromStarter(dir: string, opts: { pack: string; scenario: string; version: string }): void {
  const replacements: Record<string, string> = {
    __PACK_SLUG__: opts.pack,
    __PACK_NAME__: titleize(opts.pack),
    __SCENARIO_SLUG__: opts.scenario,
    __SCENARIO_NAME__: titleize(opts.scenario),
    __VERSION__: opts.version
  };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) rewriteTreeFromStarter(p, opts);
    else if (p.endsWith('.yaml') || p.endsWith('.yml') || p.endsWith('.json')) rewriteFile(p, replacements);
  }
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

export async function runNew(opts: NewOptions): Promise<number> {
  if (!SLUG_RE.test(opts.pack)) {
    // eslint-disable-next-line no-console
    console.error(`pack slug must match ${SLUG_RE} (kebab-case): ${opts.pack}`);
    return 1;
  }
  if (!SLUG_RE.test(opts.scenario)) {
    // eslint-disable-next-line no-console
    console.error(`scenario slug must match ${SLUG_RE} (kebab-case): ${opts.scenario}`);
    return 1;
  }

  const packsRoot = path.resolve(opts.packsRoot);
  const packDir = path.join(packsRoot, opts.pack);
  const versionDir = path.join(packDir, 'scenarios', opts.scenario, opts.version);

  if (fs.existsSync(versionDir)) {
    // eslint-disable-next-line no-console
    console.error(`refusing to overwrite existing directory: ${versionDir}`);
    return 1;
  }

  fs.mkdirSync(versionDir, { recursive: true });

  if (opts.fromScenarioRef) {
    const src = parseScenarioRef(opts.fromScenarioRef);
    const srcDir = path.join(packsRoot, src.pack, 'scenarios', src.scenario, src.version);
    if (!fs.existsSync(srcDir)) {
      fs.rmdirSync(versionDir);
      // eslint-disable-next-line no-console
      console.error(`source scenario not found: ${srcDir}`);
      return 1;
    }
    copyDirRecursive(srcDir, versionDir);
    // Rewrite scenario.yaml metadata block
    const scenarioYaml = path.join(versionDir, 'scenario.yaml');
    if (fs.existsSync(scenarioYaml)) {
      const content = fs
        .readFileSync(scenarioYaml, 'utf-8')
        .replace(/^(\s*pack:).*$/m, `$1 ${opts.pack}`)
        .replace(/^(\s*scenario:).*$/m, `$1 ${opts.scenario}`)
        .replace(/^(\s*version:).*$/m, `$1 ${opts.version}`);
      fs.writeFileSync(scenarioYaml, content, 'utf-8');
    }
  } else {
    const starter = path.resolve(__dirname, 'templates/starter');
    copyDirRecursive(starter, versionDir);
    rewriteTreeFromStarter(versionDir, opts);
  }

  // Ensure pack.yaml exists (only for greenfield path; --from preserves the source's pack)
  const packYaml = path.join(packDir, 'pack.yaml');
  if (!fs.existsSync(packYaml)) {
    const starterPack = path.resolve(__dirname, 'templates/starter/pack.yaml');
    let content = fs.readFileSync(starterPack, 'utf-8');
    content = content.split('__PACK_SLUG__').join(opts.pack).split('__PACK_NAME__').join(titleize(opts.pack));
    fs.writeFileSync(packYaml, content, 'utf-8');
  }

  // The starter scaffold leaves a pack.yaml under versionDir (because copyDir sweeps the whole starter
  // tree); remove it so it doesn't shadow the real one at the pack root.
  const strayPackYaml = path.join(versionDir, 'pack.yaml');
  if (fs.existsSync(strayPackYaml)) fs.unlinkSync(strayPackYaml);

  // eslint-disable-next-line no-console
  console.log(`scenario:new  scaffolded ${opts.pack}/${opts.scenario}@${opts.version}`);
  // eslint-disable-next-line no-console
  console.log(`              ${versionDir}`);
  return 0;
}
