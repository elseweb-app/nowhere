// MV3 service worker. Per apps/extension/AGENTS.md: no module-level mutable state,
// scheduling goes through chrome.alarms rather than setInterval, and every wake-up is
// treated as a cold start — everything the worker needs is re-read from storage/wired
// fresh on each tick.

import { defineBackground } from 'wxt/utils/define-background'
import { createComputeClient, createWorkerIdentityStore } from '@elseweb-app/client'
import { createChromeStorage } from '../src/platform/storage.js'
import { createSystemClock } from '../src/platform/clock.js'
import { createSettingsStore } from '../src/worker/settings.js'
import { createHistoryStore } from '../src/worker/history.js'
import { createLocalAIProvider } from '../src/providers/openai-compatible.js'
import { runWorkerTick } from '../src/worker/background-worker.js'

const POLL_ALARM = 'elseweb-worker-poll'
const POLL_PERIOD_MINUTES = 1

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES })
  })

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) {
      tick().catch((cause) => console.error('elseweb worker tick failed', cause))
    }
  })

  // Also runs once at worker start-up (service worker can be killed and restarted
  // between alarms) so a pending job is not left waiting a full period after a
  // restart.
  tick().catch((cause) => console.error('elseweb worker tick failed', cause))
})

async function tick() {
  const storage = createChromeStorage()
  const clock = createSystemClock()
  const settingsStore = createSettingsStore({ storage })
  const historyStore = createHistoryStore({ storage, clock })
  const workerIdentityStore = createWorkerIdentityStore({ storage, clock })

  const settings = await settingsStore.get()
  if (!settings.enabled || !settings.relayUrl || !settings.providerBaseUrl) {
    return
  }

  const computeClient = createComputeClient({ url: settings.relayUrl, fetch, clock })
  const provider = createLocalAIProvider({ baseUrl: settings.providerBaseUrl, fetch })

  await runWorkerTick({
    settingsStore,
    workerIdentityStore,
    computeClient,
    provider,
    RTCPeerConnection: globalThis.RTCPeerConnection,
    clock,
    historyStore,
  })
}
