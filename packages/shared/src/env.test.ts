import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, parseEnv } from './env.js';

const schema = z.object({
  REQUIRED: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  MODE: z.enum(['a', 'b']).default('a'),
  OPTIONAL: z.string().optional(),
});

describe('parseEnv', () => {
  it('returns typed values with defaults applied', () => {
    const env = parseEnv(schema, { REQUIRED: 'x' });
    expect(env).toEqual({ REQUIRED: 'x', PORT: 8080, MODE: 'a' });
  });

  it('coerces numeric strings', () => {
    expect(parseEnv(schema, { REQUIRED: 'x', PORT: '3000' }).PORT).toBe(3000);
  });

  it('treats empty and whitespace-only strings as unset', () => {
    const env = parseEnv(schema, { REQUIRED: 'x', PORT: '', OPTIONAL: '   ' });
    expect(env.PORT).toBe(8080);
    expect(env.OPTIONAL).toBeUndefined();
  });

  it('ignores unrelated variables', () => {
    const env = parseEnv(schema, { REQUIRED: 'x', PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('PATH');
  });

  it('reports every invalid variable in one error', () => {
    let error: unknown;
    try {
      parseEnv(schema, { REQUIRED: '', PORT: 'abc', MODE: 'c' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const issues = (error as EnvValidationError).issues;
    expect(issues).toHaveLength(3);
    expect(issues.some((i) => i.startsWith('REQUIRED:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('PORT:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('MODE:'))).toBe(true);
    expect((error as Error).message).toContain('Invalid environment configuration');
  });
});
