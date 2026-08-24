<script>
  import { onMount } from 'svelte'
  import { createPageContext } from '../../src/lib/wiring.js'
  import { createLocalAIProvider } from '../../src/providers/openai-compatible.js'
  import { hasEndpointPermission } from '../../src/platform/permissions.js'

  const { settingsStore, historyStore, workerIdentityStore } = createPageContext()

  let settings = $state(null)
  let connectionStatus = $state('checking')
  let jobsCompleted = $state(0)
  let delegationValid = $state(false)

  async function refresh() {
    settings = await settingsStore.get()
    jobsCompleted = await historyStore.completedCount()

    if (!settings.providerBaseUrl) {
      connectionStatus = 'unconfigured'
    } else if (!(await hasEndpointPermission(settings.providerBaseUrl))) {
      connectionStatus = 'not-permitted'
    } else {
      const provider = createLocalAIProvider({ baseUrl: settings.providerBaseUrl, fetch })
      const probed = await provider.probe()
      connectionStatus = probed.ok ? 'connected' : 'unreachable'
    }

    const worker = await workerIdentityStore.getWorker()
    if (worker?.delegation) {
      const checks = await Promise.all(
        settings.capabilities.map((capability) =>
          workerIdentityStore.currentDelegation({ requiredCapability: capability })
        )
      )
      delegationValid = checks.some((check) => check.valid)
    } else {
      delegationValid = false
    }
  }

  async function toggleWorker() {
    if (!settings.relayUrl || !settings.providerBaseUrl || settings.allowedModels.length === 0) return
    settings = await settingsStore.update({ enabled: !settings.enabled })
  }

  onMount(refresh)

  const statusLabel = $derived(
    {
      checking: 'Checking…',
      unconfigured: 'Not configured',
      'not-permitted': 'Not connected',
      unreachable: 'Unreachable',
      connected: 'Connected',
    }[connectionStatus] ?? connectionStatus
  )

  const workerStatusLabel = $derived.by(() => {
    if (!settings) return ''
    if (!settings.enabled) return 'Off'
    if (!delegationValid) return 'Needs authorization'
    return 'Ready'
  })
</script>

<main>
  <h1>ElseWeb</h1>

  <section>
    <h2>Local AI</h2>
    <div class="row">
      <span>{settings?.providerId ?? 'No provider'}</span>
      <span class="dot" class:on={connectionStatus === 'connected'}></span>
      <span>{statusLabel}</span>
    </div>
    {#if settings?.allowedModels?.length}
      <div class="row"><span class="label">Model</span><span>{settings.allowedModels[0]}</span></div>
    {/if}
  </section>

  <section>
    <div class="row">
      <span class="label">Worker</span>
      <button
        class="toggle"
        class:on={settings?.enabled}
        onclick={toggleWorker}
        disabled={!settings}
      >
        {settings?.enabled ? 'ON' : 'OFF'}
      </button>
    </div>
    <div class="row">
      <span class="label">Capabilities</span>
      <span>
        {#each settings?.capabilities ?? [] as capability}
          ✓ {capability === 'text.generate' ? 'Text' : 'Code'}&nbsp;
        {/each}
      </span>
    </div>
    <div class="row"><span class="label">Status</span><span>{workerStatusLabel}</span></div>
    <div class="row"><span class="label">Jobs completed</span><span>{jobsCompleted}</span></div>
  </section>

  <p class="privacy">
    Worker mode processes remote prompts on this machine in plaintext. Nothing is
    end-to-end private — see Options for details.
  </p>

  <a class="options-link" href="/options.html" target="_blank" rel="noopener">Open settings</a>
</main>

<style>
  main {
    width: 260px;
    padding: 12px;
    font: 13px/1.4 system-ui, sans-serif;
    color: #1a1a1a;
  }
  h1 {
    font-size: 15px;
    margin: 0 0 8px;
  }
  h2 {
    font-size: 12px;
    text-transform: uppercase;
    color: #666;
    margin: 0 0 6px;
  }
  section {
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid #eee;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .label {
    color: #666;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #c33;
    display: inline-block;
  }
  .dot.on {
    background: #2a2;
  }
  .toggle {
    border: 1px solid #ccc;
    background: #f5f5f5;
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
  }
  .toggle.on {
    background: #2a2;
    color: white;
    border-color: #2a2;
  }
  .privacy {
    font-size: 11px;
    color: #888;
    margin: 0 0 10px;
  }
  .options-link {
    font-size: 12px;
  }
</style>
