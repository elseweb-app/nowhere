// An in-memory implementation of the compute storage port documented in
// relay/src/compute-store.js. Exists for tests only — relay/src never imports this
// file.

export function createMemoryComputeStore() {
  const jobsById = new Map()
  const signalsByJobId = new Map()
  const revokedAuthorizationIds = new Set()

  async function putJob(job) {
    jobsById.set(job.job_id, job)
  }

  async function getJob(jobId) {
    return jobsById.get(jobId) ?? null
  }

  async function pendingJobsByCapability({ capability, limit }) {
    const matches = [...jobsById.values()].filter(
      (job) => job.status === 'pending' && job.capability === capability
    )
    return matches.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  }

  async function appendSignal(jobId, message) {
    const messages = signalsByJobId.get(jobId) ?? []
    const index = messages.length
    messages.push({ index, ...message })
    signalsByJobId.set(jobId, messages)
    return index
  }

  async function signalsSince(jobId, sinceIndex) {
    const messages = signalsByJobId.get(jobId) ?? []
    return messages.filter((message) => message.index > sinceIndex)
  }

  async function putRevocation(revocation) {
    revokedAuthorizationIds.add(revocation.authorization_id)
  }

  async function isRevoked(authorizationId) {
    return revokedAuthorizationIds.has(authorizationId)
  }

  return {
    putJob,
    getJob,
    pendingJobsByCapability,
    appendSignal,
    signalsSince,
    putRevocation,
    isRevoked,
  }
}
