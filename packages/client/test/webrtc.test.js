import { describe, it, expect } from 'vitest'
import { negotiateAsOfferer, negotiateAsAnswerer } from '../src/webrtc.js'
import { createFakeRTCPeerConnectionClass } from './fake-webrtc.js'

// A shared, in-memory stand-in for the relay's signaling mailbox
// (relay/AGENTS.md's `/compute/jobs/{id}/signal`), so this test proves the negotiation
// choreography without a real relay or a real WebRTC stack.
function createFakeComputeClient() {
  const messages = []
  return {
    async postSignal({ jobId, fromPubkey, kind, data }) {
      messages.push({ index: messages.length, jobId, from_pubkey: fromPubkey, kind, data })
      return { ok: true, index: messages.length - 1 }
    },
    async listSignals({ jobId, since = -1 }) {
      return {
        ok: true,
        messages: messages.filter((message) => message.jobId === jobId && message.index > since),
      }
    },
  }
}

describe('WebRTC negotiation over the signaling mailbox', () => {
  it('opens a DataChannel between an offerer and an answerer, carrying only opaque signaling through the mailbox', async () => {
    const computeClient = createFakeComputeClient()
    const RTCPeerConnection = createFakeRTCPeerConnectionClass()
    const jobId = 'job-1'
    const requesterPubkey = 'r'.repeat(64)
    const workerPubkey = 'w'.repeat(64)

    const [requesterSide, workerSide] = await Promise.all([
      negotiateAsOfferer({
        computeClient,
        jobId,
        selfPubkey: requesterPubkey,
        peerPubkey: workerPubkey,
        RTCPeerConnection,
      }),
      negotiateAsAnswerer({
        computeClient,
        jobId,
        selfPubkey: workerPubkey,
        peerPubkey: requesterPubkey,
        RTCPeerConnection,
      }),
    ])

    expect(requesterSide.dataChannel.readyState).toBe('open')
    expect(workerSide.dataChannel.readyState).toBe('open')

    const received = new Promise((resolve) => {
      workerSide.dataChannel.addEventListener('message', (event) => resolve(event.data), {
        once: true,
      })
    })
    requesterSide.dataChannel.send(JSON.stringify({ capability: 'text.generate', prompt: 'hello' }))
    expect(JSON.parse(await received)).toEqual({ capability: 'text.generate', prompt: 'hello' })
  })

  it('times out cleanly when the peer never answers', async () => {
    const computeClient = createFakeComputeClient()
    const RTCPeerConnection = createFakeRTCPeerConnectionClass()

    await expect(
      negotiateAsOfferer({
        computeClient,
        jobId: 'job-2',
        selfPubkey: 'r'.repeat(64),
        peerPubkey: 'w'.repeat(64),
        RTCPeerConnection,
        timeoutMs: 50,
      })
    ).rejects.toThrow(/timed out/)
  })
})
