import type { z } from 'zod';

export type EnvSource = Record<string, string | undefined>;

/** Thrown when environment variables fail validation. Lists every problem at once. */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validates `source` (default `process.env`) against a zod object schema.
 * Empty strings are treated as unset so `FOO=` in a .env file falls back to the default
 * or triggers a "required" error instead of passing an empty value through.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: EnvSource = process.env,
): z.output<T> {
  const cleaned: EnvSource = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }

  const result = schema.safeParse(cleaned);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
