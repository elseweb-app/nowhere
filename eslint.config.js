import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules', 'dist', 'build', '.wxt', 'coverage'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: js.configs.recommended.rules,
  },
  {
    // The Supabase edge function is the one file in the repo that runs on Deno rather
    // than Node or a browser. It is a host binding, not project source shared with
    // anything else, so the global lives here rather than being granted repo-wide.
    files: ['relay/supabase/functions/**/*.js'],
    languageOptions: {
      globals: { Deno: 'readonly' },
    },
  },
]
