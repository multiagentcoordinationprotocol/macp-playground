import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompileLaunchRequestDto } from './compile-launch-request.dto';
import { RunExampleRequestDto } from './run-example-request.dto';

// Mirrors the global ValidationPipe options in src/main.ts (whitelist: true, transform: true).
async function validateDto(dtoClass: new () => object, payload: Record<string, unknown>): Promise<string[]> {
  const instance = plainToInstance(dtoClass, payload);
  const errors = await validate(instance, { whitelist: true });
  return errors.map((error) => error.property);
}

const validCompilePayload = {
  scenarioRef: 'fraud/high-value-new-device@1.0.0',
  inputs: { transactionAmount: 3200, deviceTrustScore: 0.12 }
};

describe('CompileLaunchRequestDto', () => {
  it('accepts a minimal valid payload', async () => {
    await expect(validateDto(CompileLaunchRequestDto, validCompilePayload)).resolves.toEqual([]);
  });

  it('accepts optional templateId and mode when well-formed', async () => {
    await expect(
      validateDto(CompileLaunchRequestDto, { ...validCompilePayload, templateId: 'default', mode: 'live' })
    ).resolves.toEqual([]);
  });

  it('rejects a missing or empty scenarioRef', async () => {
    await expect(validateDto(CompileLaunchRequestDto, { inputs: {} })).resolves.toEqual(['scenarioRef']);
    await expect(validateDto(CompileLaunchRequestDto, { scenarioRef: '', inputs: {} })).resolves.toEqual([
      'scenarioRef'
    ]);
  });

  it('rejects non-object inputs', async () => {
    await expect(
      validateDto(CompileLaunchRequestDto, { scenarioRef: 'fraud/x@1.0.0', inputs: 'not-an-object' })
    ).resolves.toEqual(['inputs']);
  });

  it('rejects a mode outside live/sandbox', async () => {
    await expect(validateDto(CompileLaunchRequestDto, { ...validCompilePayload, mode: 'production' })).resolves.toEqual(
      ['mode']
    );
  });
});

describe('RunExampleRequestDto', () => {
  it('inherits compile validation and accepts the optional UI-driven fields', async () => {
    await expect(
      validateDto(RunExampleRequestDto, {
        ...validCompilePayload,
        bootstrapAgents: false,
        tags: ['ui-launch', 'experiment-42'],
        requester: { actorId: 'user@example.com', actorType: 'user' },
        runLabel: 'My test run'
      })
    ).resolves.toEqual([]);
  });

  it('rejects non-boolean bootstrapAgents', async () => {
    await expect(
      validateDto(RunExampleRequestDto, { ...validCompilePayload, bootstrapAgents: 'yes' })
    ).resolves.toEqual(['bootstrapAgents']);
  });

  it('rejects tags that are not an array of strings', async () => {
    await expect(validateDto(RunExampleRequestDto, { ...validCompilePayload, tags: 'ui-launch' })).resolves.toEqual([
      'tags'
    ]);
    await expect(validateDto(RunExampleRequestDto, { ...validCompilePayload, tags: [1, 2] })).resolves.toEqual([
      'tags'
    ]);
  });

  it('rejects a non-object requester and non-string runLabel', async () => {
    await expect(validateDto(RunExampleRequestDto, { ...validCompilePayload, requester: 'me' })).resolves.toEqual([
      'requester'
    ]);
    await expect(validateDto(RunExampleRequestDto, { ...validCompilePayload, runLabel: 42 })).resolves.toEqual([
      'runLabel'
    ]);
  });

  it('still fails when the inherited scenarioRef is missing', async () => {
    await expect(validateDto(RunExampleRequestDto, { inputs: {}, runLabel: 'x' })).resolves.toEqual(['scenarioRef']);
  });
});
