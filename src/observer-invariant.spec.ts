/**
 * Observer-only invariant (RFC-MACP-0001 §5.3 + direct-agent-auth plan §Invariants 5).
 *
 * The macp-playground service must never emit envelopes on behalf of an agent.
 * Writes go over gRPC directly from the agent to the runtime via
 * `macp-sdk-typescript` / `macp_sdk` — never via HTTP to the control-plane.
 *
 * This test fails CI if anyone re-introduces the legacy HTTP-write path or
 * a hand-rolled envelope builder. If you need to add a case-justified
 * exception (e.g. a doc explaining why a symbol name collides), add the file
 * to `INVARIANT_EXEMPT_FILES`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname);

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(sendMessage|send_message)\s*\(/,
    reason: 'HTTP-bridge write path; agents must emit via macp-sdk directly (ES-8).'
  },
  {
    pattern: /buildProtoEnvelope\s*\(/,
    reason: 'Hand-rolled envelope builder removed in ES-8; use DecisionSession mode helpers.'
  },
  {
    pattern: /MacpMessageBuilder\b/,
    reason: 'Legacy message builder removed in ES-8.'
  },
  {
    pattern: /POST\s+\/runs\/[^/]+\/(messages|signal|context)\b/i,
    reason: 'Control-plane write routes deleted in CP-5..7; they return 410 Gone.'
  },
  {
    pattern: /from\s+['"][^'"]*\/control-plane\/[^'"]*['"]/,
    reason: 'The local control-plane HTTP client was removed with direct-agent-auth; agents talk to the runtime over gRPC.'
  },
  {
    pattern: /['"]\/runtime\/policies(?:\/|['"])/,
    reason: 'Policy CRUD endpoints on the control-plane were removed; policies ship inline via bootstrap policyHints.'
  }
];

// Files allowed to reference the forbidden symbols (for example, this file itself).
const INVARIANT_EXEMPT_FILES = new Set<string>([path.resolve(__dirname, 'observer-invariant.spec.ts')]);

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
    } else if (entry.isFile() && (abs.endsWith('.ts') || abs.endsWith('.tsx'))) {
      out.push(abs);
    }
  }
  return out;
}

describe('observer-only invariant (RFC-MACP-0001 §5.3)', () => {
  // Production sources only — tests are allowed to reference the forbidden
  // symbols in mocks / assertions proving they don't appear.
  const files = walk(SRC)
    .filter((f) => !INVARIANT_EXEMPT_FILES.has(f))
    .filter((f) => !/\.spec\.ts$/.test(f) && !/\.test\.ts$/.test(f));

  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    it(`rejects pattern ${pattern} in src/ (${reason})`, () => {
      const violations: string[] = [];
      for (const file of files) {
        const contents = fs.readFileSync(file, 'utf-8');
        const lines = contents.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (pattern.test(lines[i])) {
            const relativePath = path.relative(SRC, file);
            violations.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
