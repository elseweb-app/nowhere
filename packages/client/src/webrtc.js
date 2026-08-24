// WebRTC negotiation over the compute-relay signaling mailbox (relay/AGENTS.md's
// `/compute/jobs/{id}/signal` endpoints; SPEC.md §20's privacy boundary). The relay
// only ever sees opaque `{ kind, data }` signaling messages here — never a job's
// prompt or result, which travel over the DataChannel this negotiates, once open,
// entirely outside this module's view.
//
// `RTCPeerConnection` is taken as an injected constructor, the same discipline as
// `fetch` elsewhere in this package: it exists in a browser and an MV3 service worker
// but not in a bare Node host, and this package must run unchanged in all three
// (packages/client/AGENTS.md). A host with no WebRTC support simply never calls this
// module.
//
// Requester and worker play asymmetric roles by construction — exactly one side offers
// and the other answers, per WebRTC's own model. `negotiateAsOfferer` creates the
// DataChannel; `negotiateAsAnswerer` receives it via `ondatachannel`.

const POLL_INTERVAL_MS = 400
const DEFAULT_TIMEOUT_MS = 15000
const DATA_CHANNEL_LABEL = 'elseweb-compute'

function waitForOpenChannel(dataChannel, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (dataChannel.readyState === 'open') {
      resolve(dataChannel)
      return
    }
    const timer = setTimeout(() => {
      dataChannel.removeEventListener('open', onOpen)
      reject(new Error('data channel did not open before timeout'))
    }, timeoutMs)
    function onOpen() {
      clearTimeout(timer)
      resolve(dataChannel)
    }
    dataChannel.addEventListener('open', onOpen, { once: true })
  })
}

// Polls the mailbox for messages of one `kind` from `expectFromPubkey`, applying each
// as it arrives, until `until()` returns true or the timeout elapses. Used for both
// "wait for the one answer" and "keep draining ICE candidates while waiting".
async function drainSignals({
  computeClient,
  jobId,
  expectFromPubkey,
  sinceIndex,
  onMessage,
  until,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs
  let since = sinceIndex
  while (Date.now() < deadline) {
    const result = await computeClient.listSignals({ jobId, since })
    if (result.ok) {
      for (const message of result.messages) {
        since = Math.max(since, message.index)
        if (message.from_pubkey !== expectFromPubkey) continue
        onMessage(message)
        if (until(message)) return since
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error("timed out waiting for the peer's signaling messages")
}

function forwardLocalIceCandidates({ peerConnection, computeClient, jobId, selfPubkey }) {
  peerConnection.addEventListener('icecandidate', (event) => {
    if (!event.candidate) return
    void computeClient.postSignal({
      jobId,
      fromPubkey: selfPubkey,
      kind: 'ice',
      data: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
    })
  })
}

// The requester's side: creates the DataChannel and the SDP offer.
export async function negotiateAsOfferer({
  computeClient,
  jobId,
  selfPubkey,
  peerPubkey,
  RTCPeerConnection,
  iceServers = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const peerConnection = new RTCPeerConnection({ iceServers })
  const dataChannel = peerConnection.createDataChannel(DATA_CHANNEL_LABEL)
  forwardLocalIceCandidates({ peerConnection, computeClient, jobId, selfPubkey })

  const offer = await peerConnection.createOffer()
  await peerConnection.setLocalDescription(offer)
  await computeClient.postSignal({ jobId, fromPubkey: selfPubkey, kind: 'offer', data: offer })

  const sinceAfterAnswer = await drainSignals({
    computeClient,
    jobId,
    expectFromPubkey: peerPubkey,
    sinceIndex: -1,
    onMessage: (message) => {
      if (message.kind === 'answer') {
        void peerConnection.setRemoteDescription(message.data)
      } else if (message.kind === 'ice') {
        void peerConnection.addIceCandidate(message.data)
      }
    },
    until: (message) => message.kind === 'answer',
    timeoutMs,
  })

  // Any ICE candidate the answerer sends after its answer keeps draining in the
  // background, same reasoning as negotiateAsAnswerer's post-offer drain below.
  void drainSignals({
    computeClient,
    jobId,
    expectFromPubkey: peerPubkey,
    sinceIndex: sinceAfterAnswer,
    onMessage: (message) => {
      if (message.kind === 'ice') void peerConnection.addIceCandidate(message.data)
    },
    until: () => false,
    timeoutMs,
  }).catch(() => {})

  const openChannel = await waitForOpenChannel(dataChannel, timeoutMs)
  return { peerConnection, dataChannel: openChannel }
}

// The worker's side: waits for the offer, answers it, and receives the DataChannel via
// `ondatachannel` rather than creating one itself.
export async function negotiateAsAnswerer({
  computeClient,
  jobId,
  selfPubkey,
  peerPubkey,
  RTCPeerConnection,
  iceServers = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const peerConnection = new RTCPeerConnection({ iceServers })
  forwardLocalIceCandidates({ peerConnection, computeClient, jobId, selfPubkey })

  const channelPromise = new Promise((resolve) => {
    peerConnection.addEventListener('datachannel', (event) => resolve(event.channel), {
      once: true,
    })
  })

  const sinceAfterOffer = await drainSignals({
    computeClient,
    jobId,
    expectFromPubkey: peerPubkey,
    sinceIndex: -1,
    onMessage: async (message) => {
      if (message.kind === 'offer') {
        await peerConnection.setRemoteDescription(message.data)
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        await computeClient.postSignal({
          jobId,
          fromPubkey: selfPubkey,
          kind: 'answer',
          data: answer,
        })
      }
    },
    until: (message) => message.kind === 'offer',
    timeoutMs,
  })

  // Keep draining any ICE candidates the offerer sends after its offer, in the
  // background — never awaited, since a channel that is already open must not wait out
  // this poll's own timeout before negotiateAsAnswerer can return.
  void drainSignals({
    computeClient,
    jobId,
    expectFromPubkey: peerPubkey,
    sinceIndex: sinceAfterOffer,
    onMessage: (message) => {
      if (message.kind === 'ice') void peerConnection.addIceCandidate(message.data)
    },
    until: () => false,
    timeoutMs,
  }).catch(() => {})

  const dataChannel = await channelPromise
  const openChannel = await waitForOpenChannel(dataChannel, timeoutMs)
  return { peerConnection, dataChannel: openChannel }
}
