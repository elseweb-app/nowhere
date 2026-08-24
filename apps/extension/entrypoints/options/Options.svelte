<script>
  import { onMount } from 'svelte'
  import { createPageContext } from '../../src/lib/wiring.js'
  import { createLocalAIProvider } from '../../src/providers/openai-compatible.js'
  import { PROVIDER_PRESETS, CUSTOM_PROVIDER_ID } from '../../src/providers/presets.js'
  import {
    hasEndpointPermission,
    requestEndpointPermission,
  } from '../../src/platform/permissions.js'

  const { keyStore, workerIdentityStore, settingsStore } = createPageContext()

  let settings = $state(null)
  let ownerIdentity = $state(null)
  let workerIdentity = $state(null)
  let delegationStatus = $state(null)

  let customEndpoint = $state('')
  let relayUrlInput = $state('')
  let probeMessage = $state('')
  let discoveredModels = $state([])
  let testMessages = $state({})

  async function refresh() {
    settings = await settingsStore.get()
    relayUrlInput = settings.relayUrl ?? ''
    ownerIdentity = await keyStore.ensureIdentity()
    workerIdentity = await workerIdentityStore.ensureWorker()
    delegationStatus = workerIdentity.delegation
      ? await workerIdentityStore.currentDelegation({})
      : { valid: false, reason: 'no_delegation' }
  }
  onMount(refresh)

  async function saveRelayUrl() {
    await requestEndpointPermission(relayUrlInput)
    settings = await settingsStore.update({ relayUrl: relayUrlInput })
  }

  async function chooseProvider(preset) {
    const baseUrl = preset.id === CUSTOM_PROVIDER_ID ? customEndpoint : preset.baseUrl
    if (!baseUrl) return
    const granted = await requestEndpointPermission(baseUrl)
    if (!granted) {
      probeMessage = 'Permission to contact that endpoint was not granted.'
      return
    }
    settings = await settingsStore.update({ providerId: preset.id, providerBaseUrl: baseUrl, allowedModels: [] })
    await probeAndListModels()
  }

  async function probeAndListModels() {
    if (!settings?.providerBaseUrl) return
    const provider = createLocalAIProvider({ baseUrl: settings.providerBaseUrl, fetch })
    const probed = await provider.probe()
    if (!probed.ok) {
      probeMessage = `Could not reach ${settings.providerBaseUrl}.`
      discoveredModels = []
      return
    }
    const listed = await provider.listModels()
    discoveredModels = listed.ok ? listed.models : []
    probeMessage = discoveredModels.length ? '' : 'Reachable, but it reported no models.'
  }

  async function testModel(model) {
    const provider = createLocalAIProvider({ baseUrl: settings.providerBaseUrl, fetch })
    const result = await provider.testModel(model)
    testMessages = { ...testMessages, [model]: result.ok ? 'Works' : `Failed: ${result.message}` }
  }

  async function toggleAllowedModel(model) {
    const allowed = new Set(settings.allowedModels)
    allowed.has(model) ? allowed.delete(model) : allowed.add(model)
    settings = await settingsStore.update({ allowedModels: [...allowed] })
  }

  async function toggleCapability(capability) {
    const capabilities = new Set(settings.capabilities)
    capabilities.has(capability) ? capabilities.delete(capability) : capabilities.add(capability)
    settings = await settingsStore.update({ capabilities: [...capabilities] })
  }

  async function updateLimit(key, value) {
    settings = await settingsStore.update({ limits: { ...settings.limits, [key]: Number(value) } })
  }

  async function authorizeWorker() {
    await workerIdentityStore.authorize({
      ownerPrivateKey: ownerIdentity.privateKey,
      ownerPubkey: ownerIdentity.publicKey,
      capabilities: settings.capabilities,
    })
    await refresh()
  }

  async function rotateWorker() {
    await workerIdentityStore.rotateWorker()
    await refresh()
  }

  async function revokeWorker() {
    const revocation = await workerIdentityStore.revokeCurrentDelegation({
      ownerPrivateKey: ownerIdentity.privateKey,
      ownerPubkey: ownerIdentity.publicKey,
    })
    console.info('worker delegation revoked locally; publish this revocation to your relay set', revocation)
    await settingsStore.update({ enabled: false })
    await refresh()
  }
</script>

<main>
  <h1>ElseWeb settings</h1>

  <section>
    <h2>Relay</h2>
    <input bind:value={relayUrlInput} placeholder="https://relay.example" />
    <button onclick={saveRelayUrl}>Save &amp; grant access</button>
  </section>

  <section>
    <h2>Local AI provider</h2>
    <div class="presets">
      {#each PROVIDER_PRESETS as preset}
        <button onclick={() => chooseProvider(preset)}>{preset.label}</button>
      {/each}
      <input bind:value={customEndpoint} placeholder="http://localhost:8080" />
      <button onclick={() => chooseProvider({ id: CUSTOM_PROVIDER_ID })}>Use custom</button>
    </div>
    {#if settings?.providerBaseUrl}
      <p>Configured: {settings.providerBaseUrl} <button onclick={probeAndListModels}>Refresh models</button></p>
    {/if}
    {#if probeMessage}<p class="warn">{probeMessage}</p>{/if}

    {#if discoveredModels.length}
      <table>
        <thead><tr><th>Model</th><th>Allowed</th><th>Test</th></tr></thead>
        <tbody>
          {#each discoveredModels as model}
            <tr>
              <td>{model}</td>
              <td><input type="checkbox" checked={settings.allowedModels.includes(model)} onchange={() => toggleAllowedModel(model)} /></td>
              <td>
                <button onclick={() => testModel(model)}>Test</button>
                <span>{testMessages[model] ?? ''}</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <section>
    <h2>Capabilities</h2>
    <label><input type="checkbox" checked={settings?.capabilities.includes('text.generate')} onchange={() => toggleCapability('text.generate')} /> text.generate</label>
    <label><input type="checkbox" checked={settings?.capabilities.includes('code.generate')} onchange={() => toggleCapability('code.generate')} /> code.generate (generates code as text only — never executed)</label>
  </section>

  <section>
    <h2>Local limits</h2>
    {#if settings}
      <label>Max concurrent jobs <input type="number" min="1" value={settings.limits.maxConcurrentJobs} onchange={(event) => updateLimit('maxConcurrentJobs', event.target.value)} /></label>
      <label>Max input bytes <input type="number" min="1" value={settings.limits.maxInputBytes} onchange={(event) => updateLimit('maxInputBytes', event.target.value)} /></label>
      <label>Max output tokens <input type="number" min="1" value={settings.limits.maxOutputTokens} onchange={(event) => updateLimit('maxOutputTokens', event.target.value)} /></label>
      <label>Execution timeout (ms) <input type="number" min="1000" value={settings.limits.executionTimeoutMs} onchange={(event) => updateLimit('executionTimeoutMs', event.target.value)} /></label>
    {/if}
  </section>

  <section>
    <h2>Worker identity</h2>
    <p>Owner key: <code>{ownerIdentity?.publicKey?.slice(0, 16)}…</code></p>
    <p>Worker key: <code>{workerIdentity?.publicKey?.slice(0, 16)}…</code></p>
    <p>Delegation: {delegationStatus?.valid ? 'valid' : `not valid (${delegationStatus?.reason})`}</p>
    <button onclick={authorizeWorker}>Authorize worker for current capabilities</button>
    <button onclick={rotateWorker}>Rotate worker identity</button>
    <button onclick={revokeWorker}>Revoke current delegation</button>
  </section>

  <p class="privacy">
    Enabling the worker means this machine processes remote users' prompts in
    plaintext to run them through your local model. This is not end-to-end private —
    the worker sees what it is asked to run, the same way it would if you ran the
    request yourself.
  </p>
</main>

<style>
  main {
    max-width: 640px;
    margin: 24px auto;
    padding: 0 16px;
    font: 14px/1.5 system-ui, sans-serif;
    color: #1a1a1a;
  }
  section {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #eee;
  }
  h2 {
    font-size: 13px;
    text-transform: uppercase;
    color: #666;
  }
  input,
  button {
    font: inherit;
  }
  input:not([type]),
  input[type='number'] {
    padding: 4px 6px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
  }
  th,
  td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid #f0f0f0;
  }
  label {
    display: block;
    margin: 6px 0;
  }
  .presets {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .warn {
    color: #a30;
  }
  .privacy {
    font-size: 12px;
    color: #888;
  }
</style>
