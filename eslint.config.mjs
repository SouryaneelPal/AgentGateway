// ESLint flat config.
//
// NOTE ON FILENAME: the Phase 1 brief asked for `.eslintrc.cjs`. ESLint 9 (pinned here)
// ignores `.eslintrc.*` unless ESLINT_USE_FLAT_CONFIG=false, and ESLint 10 removed eslintrc
// support entirely. Using flat config keeps this working on the current major instead of
// pinning the toolchain to ESLint 8. Same rules, supported filename.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      'packages/gateway/src/generated/**',
      'packages/gateway/prisma/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true },
    },
    rules: {
      // Constraint from the Phase 1 brief: no `any` in adapters/policy/crypto.
      // Enforced repo-wide as an error rather than per-directory — nothing in this
      // scaffold needs an escape hatch, so there is no reason to scope it down.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },

  {
    files: ['packages/dashboard/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },

  {
    // Build/config files run in Node and are not part of a TS project.
    files: ['**/*.mjs', '**/*.cjs', 'eslint.config.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false },
    },
  },

  {
    // The reference agent is a CLI: stdout is its user interface, not stray logging.
    files: [
      'packages/gateway/test/**/*.ts',
      'packages/*/scripts/**/*.ts',
      'packages/agent-client/src/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);
