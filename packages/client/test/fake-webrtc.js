// A minimal, in-memory simulation of just enough of the RTCPeerConnection/RTCDataChannel
// surface for webrtc.js's negotiation logic to exercise — no real media, no real ICE.
// Two fake peer connections "connect" when one's setRemoteDescription is given the
// other's id (carried in the fake SDP), which is enough to prove the offer/answer/ICE
// message choreography and DataChannel handoff without a real WebRTC stack in Node.

class FakeDataChannel extends EventTarget {
  constructor(label) {
    super()
    this.label = label
    this.readyState = 'connecting'
    this._peer = null
  }
  send(data) {
    this._peer?.dispatchEvent(new MessageEvent('message', { data }))
  }
  close() {
    this.readyState = 'closed'
  }
  _open() {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }
}

function linkChannels(a, b) {
  a._peer = b
  b._peer = a
  queueMicrotask(() => {
    a._open()
    b._open()
  })
}

class FakeRTCPeerConnection extends EventTarget {
  constructor(registry) {
    super()
    this._registry = registry
    this.id = `${Math.random()}`
    registry.set(this.id, this)
  }
  createDataChannel(label) {
    this._localChannel = new FakeDataChannel(label)
    return this._localChannel
  }
  async createOffer() {
    return { type: 'offer', sdp: this.id }
  }
  async createAnswer() {
    return { type: 'answer', sdp: this.id }
  }
  async setLocalDescription() {}
  async setRemoteDescription(description) {
    const remote = this._registry.get(description.sdp)
    if (remote?._localChannel && !this._linked) {
      this._linked = true
      const localChannel = new FakeDataChannel(remote._localChannel.label)
      linkChannels(localChannel, remote._localChannel)
      queueMicrotask(() => {
        const event = new Event('datachannel')
        event.channel = localChannel
        this.dispatchEvent(event)
      })
    }
  }
  async addIceCandidate() {}
}

export function createFakeRTCPeerConnectionClass() {
  const registry = new Map()
  return class extends FakeRTCPeerConnection {
    constructor() {
      super(registry)
    }
  }
}
