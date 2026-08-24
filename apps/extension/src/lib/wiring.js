// Shared setup for every extension page (popup, options): the storage/clock ports and
// the stores built on top of them. chrome.storage.local is what makes state visible
// across pages and the background worker — every page constructs its own store
// instances against the same storage, rather than message-passing to the background
// worker for state that storage already shares for free.

import { createKeyStore, createWorkerIdentityStore } from '@elseweb-app/client'
import { createChromeStorage } from '../platform/storage.js'
import { createSystemClock } from '../platform/clock.js'
import { createSettingsStore } from '../worker/settings.js'
import { createHistoryStore } from '../worker/history.js'

export function createPageContext() {
  const storage = createChromeStorage()
  const clock = createSystemClock()
  return {
    clock,
    keyStore: createKeyStore({ storage, clock }),
    workerIdentityStore: createWorkerIdentityStore({ storage, clock }),
    settingsStore: createSettingsStore({ storage }),
    historyStore: createHistoryStore({ storage, clock }),
  }
}
