#!/usr/bin/env ts-node
/**
 * Stages the REGISTRABLE policy set — every `policies/*.json` except the reserved
 * `policy.default` — into a directory a runtime can mount as `MACP_POLICIES_DIR`.
 *
 * Two consumers, deliberately sharing this one filter so they cannot diverge:
 *   - CI's `runtime-policy-admission` job, which runs the pinned runtime image with
 *     `MACP_POLICIES_DRY_RUN=1` over the staged directory;
 *   - the read-only registry variant in `docker-compose.fullstack.yml`, which binds the
 *     staged directory instead of `./policies`. Mounting `./policies` directly preloads
 *     `policy.default.json`, which the runtime refuses, and a preload rejection aborts
 *     startup.
 *
 * Files are copied byte-for-byte under their original names, so the runtime's dry-run
 * output names the same files a reviewer sees in `policies/`.
 *
 * Usage: npm run policies:stage -- <out-dir>   (default: .policies-registrable)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESERVED_POLICY_ID } from '../src/policy/policy-loader.service';

function main(): number {
  const srcDir = path.resolve(process.cwd(), 'policies');
  const outDir = path.resolve(process.cwd(), process.argv[2] ?? '.policies-registrable');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let staged = 0;
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(srcDir, file), 'utf-8');
    // A file that does not parse is staged anyway: the runtime's verdict on it is exactly
    // what the admission gate exists to report, so it must not be filtered out here.
    let policyId: unknown;
    try {
      policyId = (JSON.parse(raw) as { policy_id?: unknown }).policy_id;
    } catch {
      policyId = undefined;
    }
    if (policyId === RESERVED_POLICY_ID) continue;
    fs.writeFileSync(path.join(outDir, file), raw);
    staged++;
  }

  console.error(`staged ${staged} registrable polic${staged === 1 ? 'y' : 'ies'} into ${outDir}`);
  return staged > 0 ? 0 : 1;
}

process.exit(main());
