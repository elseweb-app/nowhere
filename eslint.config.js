import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    // Un-prefixed patterns only match a top-level directory of that name; every one of
    // these needs the `**/` prefix or a package's own dist/build/.output directory
    // (e.g. packages/client/dist, apps/extension/.output) silently escapes ignoring.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.wxt/**',
      '**/.output/**',
      '**/coverage/**',
    ],
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
    // The extension is the one place the MV3 `chrome.*` extension APIs exist.
    files: ['apps/extension/**/*.js'],
    languageOptions: {
      globals: { ...globals.webextensions },
    },
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
