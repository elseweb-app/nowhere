// One poll-claim-execute pass, called from the background entrypoint's alarm handler.
// Deliberately not a scheduler: no lookahead, no batching, no retry loop — it checks
// each enabled capability once, claims the first pending job it can, runs it, and
// returns (root AGENTS.md: "Avoid building a sophisticated distributed scheduler").
//
// Pure and dependency-injected, same discipline as every module in packages/client, so
// this is testable without chrome.* or a real network — see
// apps/extension/test/background-worker.test.js.

import { runClaimedJob } from './job-runner.js'

export async function runWorkerTick({
  settingsStore,
  workerIdentityStore,
  computeClient,
  provider,
  RTCPeerConnection,
  clock,
  historyStore,
}) {
  const settings = await settingsStore.get()
  if (!settings.enabled) return { ranJob: false, reason: 'disabled' }
  if (!provider || !computeClient) return { ranJob: false, reason: 'not_configured' }

  const worker = await workerIdentityStore.getWorker()
  if (!worker) return { ranJob: false, reason: 'no_worker_identity' }

  for (const capability of settings.capabilities) {
    const delegationCheck = await workerIdentityStore.currentDelegation({
      requiredCapability: capability,
    })
    if (!delegationCheck.valid) continue

    const polled = await computeClient.pollJobs({ capability })
    if (!polled.ok || polled.jobs.length === 0) continue

    for (const pendingJob of polled.jobs) {
      const claimed = await computeClient.claimJob({
        jobId: pendingJob.job_id,
        delegation: delegationCheck.delegation,
      })
      if (!claimed.ok) continue

      // maxConcurrentJobs > 1 is accepted as a limit (src/worker/limits.js) but this
      // tick only ever runs one job at a time — a documented simplification, not an
      // oversight, matching the "no sophisticated scheduler" instruction above.
      const result = await runClaimedJob({
        job: claimed.job,
        computeClient,
        workerPrivateKey: worker.privateKey,
        workerPubkey: worker.publicKey,
        RTCPeerConnection,
        resolveProvider: (model) => (settings.allowedModels.includes(model) ? provider : null),
        allowedModels: settings.allowedModels,
        limits: settings.limits,
        activeJobCount: 0,
        clock,
        onEvent: (event) => void historyStore.append(event),
      })
      return { ranJob: true, result }
    }
  }

  return { ranJob: false, reason: 'no_pending_jobs' }
}
