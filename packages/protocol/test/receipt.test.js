import { describe, it, expect } from 'vitest'
import {
  canonicalizeReceipt,
  canonicalizeReceiptForCountersign,
  signReceiptAsWorker,
  signReceiptAsRequester,
  verifyReceipt,
} from '../src/receipt.js'
import { receiptVectors, keyVectors } from './helpers/vectors.js'

// A receipt proves a compute job happened without carrying its prompt or result — only
// a `result_hash`. It also has to distinguish "the worker claims it finished" from "the
// requester confirms it received the result", which is why two independent signatures
// exist over two overlapping-but-different byte ranges.

describe('canonicalizeReceipt', () => {
  for (const testCase of receiptVectors.cases) {
    it(testCase.name, () => {
      const { worker_sig, requester_sig, ...body } = testCase.receipt
      void worker_sig
      void requester_sig
      expect(canonicalizeReceipt(body)).toBe(testCase.canonical_worker)
    })
  }
})

describe('canonicalizeReceiptForCountersign', () => {
  for (const testCase of receiptVectors.cases.filter((c) => c.canonical_countersign)) {
    it(testCase.name, () => {
      const { requester_sig, ...body } = testCase.receipt
      void requester_sig
      expect(canonicalizeReceiptForCountersign(body)).toBe(testCase.canonical_countersign)
    })
  }
})

describe('signReceiptAsWorker / signReceiptAsRequester', () => {
  it('round trips: worker signs, requester countersigns, both verify', async () => {
    const { worker_sig, requester_sig, ...body } = receiptVectors.cases[1].receipt
    void worker_sig
    void requester_sig
    const workerSigned = await signReceiptAsWorker(body, keyVectors.worker.seed)
    const fullySigned = await signReceiptAsRequester(workerSigned, keyVectors.requester.seed)
    const result = await verifyReceipt(fullySigned)
    expect(result.valid).toBe(true)
    expect(result.countersigned).toBe(true)
  })

  it('a receipt is valid with only a worker signature', async () => {
    const { worker_sig, ...body } = receiptVectors.cases[0].receipt
    void worker_sig
    const workerSigned = await signReceiptAsWorker(body, keyVectors.worker.seed)
    const result = await verifyReceipt(workerSigned)
    expect(result.valid).toBe(true)
    expect(result.countersigned).toBe(false)
  })
})

describe('verifyReceipt', () => {
  for (const testCase of receiptVectors.cases) {
    it(testCase.name, async () => {
      const result = await verifyReceipt(testCase.receipt)
      expect(result.reason).toBe(testCase.expect)
      expect(result.valid).toBe(testCase.expect === 'valid')
      expect(result.countersigned).toBe(testCase.countersigned)
    })
  }

  it('requires a countersignature only when the caller asks for one', async () => {
    const uncountersigned = receiptVectors.cases.find(
      (c) => c.expect === 'valid' && !c.countersigned
    )
    const result = await verifyReceipt(uncountersigned.receipt, { requireCountersignature: true })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('not_countersigned')
  })

  it('does not require a countersignature by default', async () => {
    const uncountersigned = receiptVectors.cases.find(
      (c) => c.expect === 'valid' && !c.countersigned
    )
    const result = await verifyReceipt(uncountersigned.receipt)
    expect(result.valid).toBe(true)
  })

  it('rejects an unknown receipt type rather than trusting it', async () => {
    const testCase = receiptVectors.cases[0]
    const unknown = { ...testCase.receipt, type: 'something-else' }
    const result = await verifyReceipt(unknown)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported_type')
  })
})
