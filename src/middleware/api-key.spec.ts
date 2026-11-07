import { isValidApiKey } from './api-key';

describe('isValidApiKey', () => {
  const keys = ['console-key', 'test-key'];

  it('accepts any configured key', () => {
    expect(isValidApiKey('console-key', keys)).toBe(true);
    expect(isValidApiKey('test-key', keys)).toBe(true);
  });

  it('rejects a wrong, prefix, longer, empty or non-string key', () => {
    for (const presented of ['wrong', 'console', 'console-key-extra', '', undefined, null, ['console-key'], 42]) {
      expect(isValidApiKey(presented, keys)).toBe(false);
    }
  });

  it('matches nothing when no key is configured', () => {
    expect(isValidApiKey('console-key', [])).toBe(false);
  });
});
