// WXT + plain Svelte (root AGENTS.md, apps/extension/AGENTS.md). No SvelteKit: no
// router, no SSR, no `$app` imports — entrypoints below mount components directly.
import { defineConfig } from 'wxt'

export default defineConfig({
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-svelte'],
  // WXT's built-in auto-import transform (unimport) only excludes paths containing a
  // literal "node_modules" segment. pnpm symlinks a workspace dependency to its real
  // path instead (packages/client/dist/index.js), so that bundle was being scanned
  // too, and a destructured `{ storage }` parameter inside it was misread as an
  // unresolved reference to WXT's own `storage` global — injecting a bogus
  // `import { storage } from "wxt/utils/storage"` that then failed to resolve. This
  // project always writes explicit imports anyway (root AGENTS.md §5), so the fix is
  // to exclude every file from the transform rather than rely on `imports: false`,
  // which does not stop this specific plugin from being registered.
  imports: { exclude: [/.*/] },
  manifest: {
    name: 'ElseWeb',
    description:
      'Generic protocol client for ElseWeb: identity, and a local AI worker for the compute network.',
    // Kept to the minimum this feature needs: local settings/job-history storage and a
    // periodic wake-up to poll for compute jobs while worker mode is on (MV3 workers
    // are killed at any time — root AGENTS.md, apps/extension/AGENTS.md "Background
    // service worker" — so polling goes through chrome.alarms, never setInterval).
    permissions: ['storage', 'alarms'],
    // Nothing here is granted by default. Root AGENTS.md §8: "Adding a new permission
    // requires approval" — the answer here is to request none upfront and ask for one
    // narrow origin at a time, at the moment the local user configures it (a local AI
    // endpoint, or a relay URL), via chrome.permissions.request. See
    // src/platform/permissions.js. Listed here only because MV3 requires a permission
    // to be enumerable as optional before it can ever be requested at runtime.
    optional_host_permissions: [
      'http://localhost/*',
      'http://127.0.0.1/*',
      'http://[::1]/*',
      'https://*/*',
      'http://*/*',
    ],
  },
})
