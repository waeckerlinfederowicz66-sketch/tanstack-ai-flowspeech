import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowSpeechClient, type FlowSpeechJob } from '../src/flowspeech-client.js'
import { input, job, jobId, json, requestId } from './fixtures.js'
import { extendedWav, invalidWavs, pcmFormat, validWav, wavChunk, wavFile } from './wav-fixtures.mjs'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function download(bytes: Uint8Array, options = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes)))
  return { fetcher, client: new FlowSpeechClient({ apiKey: 'unit-test-only', fetch: fetcher, ...options }) }
}
describe('strict WAV validation', () => {
  it.each([['canonical PCM', validWav()], ['padded unknown chunks and PCM extension', extendedWav()]])('preserves exact bytes: %s', async (_name, bytes) => {
    const { client, fetcher } = download(bytes as Uint8Array)
    expect(await client.downloadJob(job() as FlowSpeechJob)).toEqual(new Uint8Array(bytes as Uint8Array))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![1]?.headers).toBeUndefined()
  })
  it.each(invalidWavs())('rejects %s with recovery IDs and no retry', async (_name, bytes) => {
    const { client, fetcher } = download(bytes)
    await expect(client.downloadJob(job() as FlowSpeechJob)).rejects.toMatchObject({ code: 'invalid_audio', jobId, requestId, retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects every truncated prefix', async () => {
    const bytes = validWav()
    for (let length = 0; length < bytes.length; length++) {
      const { client } = download(bytes.subarray(0, length))
      await expect(client.downloadJob(job() as FlowSpeechJob)).rejects.toMatchObject({ code: 'invalid_audio', jobId, requestId })
    }
  })
  it('allows later download recovery without submitting again', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(job()))
      .mockResolvedValueOnce(new Response('<html>bad</html>'))
      .mockResolvedValueOnce(new Response(new Uint8Array(extendedWav())))
    const client = new FlowSpeechClient({ apiKey: 'unit-test-only', fetch: fetcher })
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'invalid_audio', jobId, requestId })
    expect(await client.downloadJob(job() as FlowSpeechJob)).toEqual(new Uint8Array(extendedWav()))
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1)
  })
  it('lets the total deadline interrupt parsing many tiny unknown chunks', async () => {
    vi.useFakeTimers()
    const bytes = wavFile(wavChunk('fmt ', pcmFormat()),
      ...Array.from({ length: 32768 }, () => wavChunk('JUNK', [])), wavChunk('data', [0, 0]))
    const { client, fetcher } = download(bytes, { timeoutMs: 5 })
    const assertion = expect(client.downloadJob(job() as FlowSpeechJob)).rejects.toMatchObject({ code: 'deadline_exceeded', jobId, requestId })
    await vi.advanceTimersByTimeAsync(5)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
