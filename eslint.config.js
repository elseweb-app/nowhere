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
]
