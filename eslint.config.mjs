import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

// Covers src/, scripts/ and test/ — deliberately NOT "the whole repo": the root-level
// jest.config.ts and this file itself are outside every glob by design. Extending coverage to
// scripts/ and test/ is what finally enforces no-floating-promises and no-misused-promises where
// async CLI and test code actually lives.
const LINTED = ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'];

export default [
  {
    files: LINTED,
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        sourceType: 'module'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',
      '@typescript-eslint/prefer-optional-chain': 'warn',
      'no-console': ['warn', { allow: ['error', 'warn'] }]
    }
  },
  {
    // Test doubles legitimately need `any`, and 88 warnings nobody will ever action just train
    // people to ignore the lint job. src/ and scripts/ keep the rule at 'warn'.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: LINTED,
    rules: {
      ...prettier.rules
    }
  }
];
