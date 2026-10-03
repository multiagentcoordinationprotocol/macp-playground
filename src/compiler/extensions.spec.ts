import { describeExtensionsProblem } from './extensions';

describe('describeExtensionsProblem', () => {
  it.each([undefined, null, {}, { 'x-trace': 'dHJhY2U=' }])('accepts %p', (value) => {
    expect(describeExtensionsProblem(value)).toBeUndefined();
  });

  it.each([
    [{ n: 1 }, 'launch.extensions.n must be a base64-encoded string (RFC-MACP-0001 §10.3), got number'],
    [{ o: { a: 1 } }, 'launch.extensions.o must be a base64-encoded string (RFC-MACP-0001 §10.3), got object'],
    [{ z: null }, 'launch.extensions.z must be a base64-encoded string (RFC-MACP-0001 §10.3), got null']
  ])('names the offending key for %p', (value, message) => {
    expect(describeExtensionsProblem(value)).toBe(message);
  });

  it.each([
    ['', 'launch.extensions must be a mapping of string values, got ""'],
    ['abc', 'launch.extensions must be a mapping of string values, got "abc"'],
    [['a'], 'launch.extensions must be a mapping of string values, got array']
  ])('rejects the non-mapping container %p', (value, message) => {
    expect(describeExtensionsProblem(value)).toBe(message);
  });
});
