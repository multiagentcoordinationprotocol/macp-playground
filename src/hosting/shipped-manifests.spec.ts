import * as fs from 'node:fs';
import * as path from 'node:path';

const MANIFESTS_DIR = path.resolve(__dirname, '..', '..', 'agents', 'manifests');

/**
 * A shipped manifest that names its own interpreter silently beats EXAMPLE_AGENT_PYTHON_PATH /
 * EXAMPLE_AGENT_NODE_PATH (see ProcessExampleAgentHostProvider), which is how those env vars came to be
 * documented and parsed but ignored. Leave `host.python` / `host.node` unset so the deployment decides.
 */
describe('shipped agent manifests', () => {
  const files = fs.readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.json'));

  it('finds the manifests', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files)('%s does not pin an interpreter', (file) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MANIFESTS_DIR, file), 'utf8')) as {
      host?: { python?: string; node?: string };
    };
    expect(manifest.host?.python).toBeUndefined();
    expect(manifest.host?.node).toBeUndefined();
  });
});
