import { logAgent } from './log-agent';

describe('logAgent', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  function lastLine(): string {
    expect(writeSpy).toHaveBeenCalledTimes(1);
    return writeSpy.mock.calls[0][0] as string;
  }

  it('writes a single newline-terminated JSON line with ts and message', () => {
    logAgent('agent started');

    const line = lastLine();
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.message).toBe('agent started');
    expect(typeof parsed.ts).toBe('string');
    expect(new Date(parsed.ts as string).toISOString()).toBe(parsed.ts);
  });

  it('spreads details into the payload alongside ts and message', () => {
    logAgent('vote emitted', { sessionId: 's-1', proposalId: 'p-1' });

    const parsed = JSON.parse(lastLine()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ message: 'vote emitted', sessionId: 's-1', proposalId: 'p-1' });
  });

  it('omits detail keys entirely when no details are given', () => {
    logAgent('plain');

    const parsed = JSON.parse(lastLine()) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['message', 'ts']);
  });
});
