#!/usr/bin/env ts-node
/**
 * Fetches the vendored policy rule schemas (see schemas/policy/README.md) from the spec
 * repo at a pinned ref and diffs them against the committed copies in schemas/policy/.
 * Reports drift without modifying anything — re-vendoring is a manual, reviewed step.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const REPO = 'multiagentcoordinationprotocol/multiagentcoordinationprotocol';
// Intentionally tracks the spec repo's moving default branch, not the commit these
// schemas were vendored from — pinning to the vendor commit would make this check
// tautologically always pass and never actually detect upstream drift.
const REF = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${REF}`;

const FILES: Array<{ local: string; remote: string }> = [
  { local: 'decision-rules.schema.json', remote: 'schemas/json/policy/decision-rules.schema.json' },
  { local: 'quorum-rules.schema.json', remote: 'schemas/json/policy/quorum-rules.schema.json' },
  { local: 'proposal-rules.schema.json', remote: 'schemas/json/policy/proposal-rules.schema.json' },
  { local: 'task-rules.schema.json', remote: 'schemas/json/policy/task-rules.schema.json' },
  { local: 'handoff-rules.schema.json', remote: 'schemas/json/policy/handoff-rules.schema.json' },
  { local: 'policy-descriptor.schema.json', remote: 'schemas/json/macp-policy-descriptor.schema.json' }
];

async function main(): Promise<number> {
  const localDir = path.resolve(process.cwd(), 'schemas/policy');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-schemas-sync-'));

  let drift = false;
  for (const file of FILES) {
    const url = `${RAW_BASE}/${file.remote}`;
    let remoteContent: string;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`failed to fetch ${url}: HTTP ${res.status}`);
        return 2;
      }
      remoteContent = await res.text();
    } catch (err) {
      console.error(`failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }

    const scratchPath = path.join(scratchDir, file.local);
    fs.writeFileSync(scratchPath, remoteContent);

    const localPath = path.join(localDir, file.local);
    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : '';

    if (localContent !== remoteContent) {
      drift = true;
      console.log(`DRIFT: ${file.local} differs from ${REPO}@${REF}`);
    } else {
      console.log(`OK: ${file.local} matches ${REPO}@${REF}`);
    }
  }

  console.log(`\nScratch copies written to ${scratchDir} for manual diffing if needed.`);

  if (drift) {
    console.log(
      '\nDrift detected. Review the scratch copies, then manually update schemas/policy/ and ' +
        "schemas/policy/README.md's pinned ref (and this script's REF constant) if the change should be adopted."
    );
    return 1;
  }

  console.log('\nNo drift — vendored schemas match the pinned ref.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
