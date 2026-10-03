/**
 * Shape check for `launch.extensions` (RFC-MACP-0001 §10.3: protobuf `bytes` are base64 strings in
 * JSON). Pack YAML is not type-checked on load, so this is the one place the contract is enforced.
 * It returns the problem rather than throwing so the compiler (which throws a `COMPILATION_ERROR`)
 * and the scenario CLI (which reports a finding) can share it.
 *
 * `undefined` / `null` mean "absent". Base64 validity is deliberately not checked: the SDK falls
 * back to raw UTF-8 for a string that does not decode.
 */
export function describeExtensionsProblem(extensions: unknown): string | undefined {
  if (extensions === undefined || extensions === null) return undefined;
  if (typeof extensions !== 'object' || Array.isArray(extensions)) {
    // `extensions:` with no value parses to '' under JSON_SCHEMA (see CLAUDE.md), so this is the bare-key case too.
    return `launch.extensions must be a mapping of string values, got ${Array.isArray(extensions) ? 'array' : JSON.stringify(extensions)}`;
  }
  for (const [key, value] of Object.entries(extensions)) {
    if (typeof value !== 'string') {
      return `launch.extensions.${key} must be a base64-encoded string (RFC-MACP-0001 §10.3), got ${value === null ? 'null' : typeof value}`;
    }
  }
  return undefined;
}
