// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/', '**/coverage/', 'pnpm-lock.yaml'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Architecture rule: domain logic stays pure and Discord-free so it can be unit-tested.
    files: ['packages/shared/**/*.ts', 'apps/bot/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['discord.js', 'discord.js/*', '@discordjs/*'],
              message: 'Domain code must not depend on Discord libraries. Keep it pure.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
