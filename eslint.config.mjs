/**
 * Deliberately small.
 *
 * This is a five-file service whose job is to be a thin, readable transport
 * over @x402/stellar. Importing a forty-rule preset into it would generate
 * churn that has nothing to do with correctness, and would make the diff on a
 * conformance fix harder to read. The rules here are the ones that catch real
 * mistakes in this codebase: unused bindings left behind by a refactor, and
 * accidental globals.
 *
 * Formatting is Prettier's job and is checked separately, so nothing here
 * concerns itself with whitespace.
 */
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node globals used across src/, scripts/ and test/.
        process: 'readonly',
        console: 'readonly',
        globalThis: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // An import left behind by a refactor is the failure mode this catches:
      // it reads as a dependency that is no longer one.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],

      // Silent failure is the thing this repo is most trying to avoid, and an
      // empty catch is how it usually arrives. `catch {}` with a comment
      // explaining why is still allowed.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // await inside a loop is correct in the settle path and in the retry
      // wrapper; flagging it would be noise.
      'no-await-in-loop': 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
];
