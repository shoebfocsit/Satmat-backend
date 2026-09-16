// Flat config (ESLint 9). `npm run lint` must exit non-zero on real problems so
// CI can gate on it. `@typescript-eslint/no-explicit-any` stays a *warning*:
// `any` cleanup across services is tracked follow-up work (see ARCHITECTURE.md)
// and must not block the gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
