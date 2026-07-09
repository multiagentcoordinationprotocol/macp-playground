import { createScenarioAjv } from './ajv-factory';

describe('createScenarioAjv', () => {
  it('registers ajv-formats so scenario schemas can use standard string formats', () => {
    const ajv = createScenarioAjv();
    const validate = ajv.compile({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        createdAt: { type: 'string', format: 'date-time' }
      }
    });

    expect(validate({ id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(validate({ id: 'not-a-uuid', createdAt: '2026-01-01T00:00:00Z' })).toBe(false);
  });

  it('collects all errors instead of stopping at the first (allErrors: true)', () => {
    const ajv = createScenarioAjv();
    const validate = ajv.compile({
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: { type: 'number' },
        b: { type: 'string' }
      }
    });

    expect(validate({})).toBe(false);
    expect(validate.errors).toHaveLength(2);
  });

  it('does not coerce types, so string inputs fail numeric schemas (coerceTypes: false)', () => {
    const ajv = createScenarioAjv();
    const validate = ajv.compile({
      type: 'object',
      properties: { amount: { type: 'number' } }
    });

    const input = { amount: '3200' };
    expect(validate(input)).toBe(false);
    expect(input.amount).toBe('3200');
  });

  it('does not apply schema defaults — default merging is owned by the compiler, not ajv', () => {
    const ajv = createScenarioAjv();
    const validate = ajv.compile({
      type: 'object',
      properties: { mode: { type: 'string', default: 'sandbox' } }
    });

    const input: Record<string, unknown> = {};
    expect(validate(input)).toBe(true);
    expect(input.mode).toBeUndefined();
  });

  it('returns an independent instance per call', () => {
    expect(createScenarioAjv()).not.toBe(createScenarioAjv());
  });
});
