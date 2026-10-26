import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowSpeechClient, FlowSpeechError, type FlowSpeechClientOptions, type FlowSpeechInput, type FlowSpeechJob } from '../src/flowspeech-client.js'
import { audio, input, job, jobId, json, requestId, result, wav } from './fixtures.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T00:00:00Z')); vi.stubEnv('FLOWSPEECH_API_KEY', '') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function setup(responses: Array<Response | Error>, options: FlowSpeechClientOptions = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const response = responses.shift()
    if (response instanceof Error) throw response
    if (!response) throw new Error('Unexpected extra fetch')
    return response
  })
  return { fetcher, client: new FlowSpeechClient({ apiKey: 'unit-test-only', fetch: fetcher, ...options }) }
}
describe('FlowSpeech v1 transport', () => {
  it.each([undefined, null, '', 'not-a-uuid'])('rejects missing or malformed response request ID %s', async invalidId => {
    const { client, fetcher } = setup([json(job('success', { requestId: invalidId }))])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'invalid_response', requestId, jobId })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('normalizes equivalent response UUIDs and rejects poll identity changes', async () => {
    const alphaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const { client } = setup([json(job('success', { requestId: alphaId.toUpperCase() })), audio()])
    expect((await client.generate(input, { requestId: alphaId })).job.requestId).toBe(alphaId)
    const polled = setup([json(job('queued'), 202), json(job('success', { requestId: '33333333-3333-4333-8333-333333333333' }))])
    const failed = expect(polled.client.generate(input, { requestId })).rejects.toMatchObject({ code: 'invalid_response', requestId, jobId })
    await vi.advanceTimersByTimeAsync(5000)
    await failed
    expect(polled.fetcher).toHaveBeenCalledTimes(2)
  })
  it('retries empty transient API errors with the original request ID', async () => {
    const { client, fetcher } = setup([new Response(null, { status: 503 }), json(job()), audio()])
    const pending = client.generate(input, { requestId })
    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('idempotency-key')).toBe(requestId)
  })
  it('rejects request ID mismatches and invalid recovery IDs before download', async () => {
    const { client, fetcher } = setup([json(job('success', { requestId: '33333333-3333-4333-8333-333333333333' }))])
    await expect(client.generate(input, { requestId })).rejects.toThrow('Request ID changed')
    await expect(client.generate(input, { requestId: null as unknown as string })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('does not retry explicitly non-retryable server errors', async () => {
    const { client, fetcher } = setup([json({ error: { code: 'not_retryable', retryable: false } }, 503)])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'not_retryable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('bounds streamed API JSON independently of audio limits', async () => {
    const { client } = setup([new Response(new Uint8Array(1024 * 1024 + 1))])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'response_too_large' })
  })
  it('aborts an in-flight storage download and retains recovery metadata', async () => {
    const controller = new AbortController()
    const { client, fetcher } = setup([json(job()), new Response(new ReadableStream({ start() {} }))])
    const assertion = expect(client.generate(input, { requestId, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted', requestId, jobId })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]![1]?.signal?.aborted).toBe(true)
    expect(fetcher.mock.calls[1]![1]?.headers).toBeUndefined()
  })
  it('polls all pending states, obeys minimum intervals, and downloads without credentials', async () => {
    const { client, fetcher } = setup([json(job('queued'), 202), json(job('running')), json(job('merging')), json(job('settling')), json(job()), audio()], { headers: { 'X-Custom': 'api-only' } })
    const pending = client.generate(input, { requestId })
    await vi.advanceTimersByTimeAsync(4999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15001)
    const value = await pending
    expect(value.audio).toEqual(new Uint8Array(wav()))
    expect(value.requestId).toBe(requestId)
    expect(value.job.id).toBe(jobId)
    expect(fetcher).toHaveBeenCalledTimes(6)
    const [url, create] = fetcher.mock.calls[0]!
    expect(url).toBe('https://flowspeech.io/api/v1/tts/jobs')
    expect(JSON.parse(String(create?.body))).toEqual({ input })
    expect(new Headers(create?.headers).get('authorization')).toBe('Bearer unit-test-only')
    expect(new Headers(create?.headers).get('idempotency-key')).toBe(requestId)
    for (const [apiUrl, init] of fetcher.mock.calls.slice(0, -1)) {
      expect(String(apiUrl)).toContain('/api/v1/')
      expect(new Headers(init?.headers).get('x-custom')).toBe('api-only')
      expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    }
    expect(fetcher.mock.calls[5]).toMatchObject([result.url, { method: 'GET', credentials: 'omit', redirect: 'manual' }])
    expect(fetcher.mock.calls[5]![1]?.headers).toBeUndefined()
  })
  it('maps explicit multi-speaker input without legacy fields', async () => {
    const { client, fetcher } = setup([json(job()), audio()])
    const multi: FlowSpeechInput = { mode: 'multi', segments: [{ speaker: 'Alice', text: 'Hi', voiceName: 'Kore' }, { speaker: 'Bob', text: 'Hey', voiceName: 'Puck' }] }
    await client.generate(multi, { requestId })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ input: multi })
  })
  it('uses a generated UUID and preserves it and the exact body on network/server retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('transport failure')).mockResolvedValueOnce(json({ error: { code: 'busy', message: 'Busy', retryable: true } }, 503, { 'Retry-After': '9' }))
      .mockImplementationOnce(async (_url, init) => json(job('success', { requestId: new Headers(init?.headers).get('idempotency-key') })))
      .mockResolvedValueOnce(audio())
    const client = new FlowSpeechClient({ apiKey: 'unit-test-only', fetch: fetcher })
    const pending = client.generate(input)
    await vi.advanceTimersByTimeAsync(13999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    const output = await pending
    expect(output.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Set(fetcher.mock.calls.slice(0, 3).map(call => new Headers(call[1]?.headers).get('idempotency-key'))).size).toBe(1)
    expect(new Set(fetcher.mock.calls.slice(0, 3).map(call => call[1]?.body)).size).toBe(1)
  })
  it.each(['8', 'Mon, 26 Oct 2026 00:00:08 GMT'])('obeys Retry-After %s on acceptance', async header => {
    const { client, fetcher } = setup([json(job('queued'), 202, { 'Retry-After': header }), json(job()), audio()])
    const pending = client.generate(input, { requestId })
    await vi.advanceTimersByTimeAsync(7999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('respects read rate limits without resubmitting', async () => {
    const { client, fetcher } = setup([json(job('queued'), 202), json({ error: { code: 'rate_limited', retryable: true } }, 429, { 'Retry-After': '10' }), json(job()), audio()])
    const pending = client.generate(input, { requestId })
    await vi.advanceTimersByTimeAsync(14999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1)
  })
  it('reads canonical subscription quota and optional entitlement compatibility', async () => {
    const quota = { quota: { remaining: 12, reserved: 2, available: 10 }, subscription: { status: 'active' }, limits: { readRequests: 60 } }
    const compatibility = { ...quota, subscription: undefined, entitlement: { plan: 'basic' } }
    const voices = [{ name: 'Kore', description: 'Firm', gender: 'female' }]
    const { client, fetcher } = setup([json(quota), json(compatibility), json({ ...quota, subscription: null }), json({ voices })])
    expect(await client.getQuota()).toEqual(quota)
    expect(await client.getQuota()).toMatchObject({ entitlement: { plan: 'basic' } })
    expect(await client.getQuota()).toEqual({ ...quota, subscription: null })
    expect(await client.listVoices()).toEqual(voices)
    expect(fetcher.mock.calls.map(c => c[0])).toEqual(['https://flowspeech.io/api/v1/quota', 'https://flowspeech.io/api/v1/quota', 'https://flowspeech.io/api/v1/quota', 'https://flowspeech.io/api/v1/voices'])
  })
  it('supports recovery and cancellation with validated IDs', async () => {
    const { client, fetcher } = setup([json(job('queued')), json(job()), json(job('cancelled'))])
    expect((await client.findJob(requestId)).id).toBe(jobId)
    expect((await client.getJob(jobId)).status).toBe('success')
    expect((await client.cancelJob(jobId)).status).toBe('cancelled')
    expect(fetcher.mock.calls[0]![0]).toBe('https://flowspeech.io/api/v1/tts/jobs?requestId=' + requestId)
    expect(fetcher.mock.calls[2]![0]).toBe('https://flowspeech.io/api/v1/tts/jobs/' + jobId + '/cancel')
    expect(fetcher.mock.calls[2]![1]?.method).toBe('POST')
    await expect(client.getJob('../quota')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(client.findJob('bad?requestId=foo')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it.each(['failed', 'cancelled'] as const)('does not treat HTTP 200 status=%s as success', async status => {
    const { client, fetcher } = setup([json(job(status, { error: { code: 'TTS_STOPPED', message: 'Stopped' } }))])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'TTS_STOPPED', requestId, jobId })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('reports deleted audio explicitly and permits reading its metadata', async () => {
    const deleted = job('success', { result: null, resultDeleted: true })
    const { client, fetcher } = setup([json(deleted), json(deleted)])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'result_deleted', jobId, requestId })
    expect((await client.getJob(jobId)).resultDeleted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([
    { id: undefined }, { id: '../../quota' }, { status: 'mystery' }, { usage: null },
    { result: undefined }, { result: null }, { result: { ...result, sampleRate: 48000 } },
    { result: { ...result, url: 'http://audio.example.test/a.wav' } },
    { result: { ...result, url: 'https://name:password@audio.example.test/a.wav' } },
    { result: { ...result, url: 'file:///tmp/a.wav' } },
  ])('rejects malformed job %j before downloading', async extra => {
    const { client, fetcher } = setup([json(job('success', extra))])
    await expect(client.generate(input, { requestId })).rejects.toBeInstanceOf(FlowSpeechError)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects IDs changing during polling', async () => {
    const { client } = setup([json(job('queued')), json(job('success', { id: '33333333-3333-4333-8333-333333333333' }))])
    const assertion = expect(client.generate(input, { requestId })).rejects.toThrow('Job ID changed')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })
  it('redacts reflected credentials but preserves structured API diagnostics', async () => {
    const { client, fetcher } = setup([json({ error: { code: 'subscription_required', message: 'No access for unit-test-only', retryable: false }, traceId: 'trace-fixture' }, 403)])
    const error = await client.generate(input, { requestId }).catch(e => e)
    expect(error).toMatchObject({ code: 'subscription_required', status: 403, traceId: 'trace-fixture', requestId })
    expect(error.message).not.toContain('unit-test-only')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('bounds retry attempts and exposes IDs after exhausted retries', async () => {
    const { client, fetcher } = setup([new Error('a'), new Error('b'), new Error('c')])
    const assertion = expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'network_error', requestId })
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('rejects malformed JSON without echoing the response', async () => {
    const { client } = setup([new Response('sensitive non-JSON')])
    const error = await client.generate(input, { requestId }).catch(e => e)
    expect(error.message).toBe('Malformed API JSON')
  })
  it('enforces the total deadline during Retry-After waiting', async () => {
    const { client, fetcher } = setup([json(job('queued'), 202, { 'Retry-After': '3600' })], { timeoutMs: 100 })
    const assertion = expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'deadline_exceeded', requestId, jobId })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts a hanging fetch even when the custom transport ignores the signal', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const client = new FlowSpeechClient({ apiKey: 'unit-test-only', fetch: fetcher, timeoutMs: 100 })
    const assertion = expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'deadline_exceeded' })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true)
  })
  it.each([false, true])('applies deadlines to stalled response bodies (download=%s)', async download => {
    const stalled = new Response(new ReadableStream({ start() {} }))
    const { client } = setup(download ? [json(job()), stalled] : [stalled], { timeoutMs: 100 })
    const assertion = expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'deadline_exceeded', requestId })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })
  it('bounds each request and never lets attempts run beyond the total deadline', async () => {
    const { client } = setup([new Response(new ReadableStream({ start() {} }))], { requestTimeoutMs: 50, maxRetries: 0 })
    const assertion = expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'request_timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
  })
  it('handles already-aborted and polling cancellation without cancelling the server job', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, fetcher } = setup([json(job('queued'))])
    await expect(client.generate(input, { requestId, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
    expect(fetcher).not.toHaveBeenCalled()
    const second = new AbortController()
    const assertion = expect(client.generate(input, { requestId, signal: second.signal })).rejects.toMatchObject({ code: 'aborted', jobId })
    await vi.advanceTimersByTimeAsync(0)
    second.abort()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retries failed downloads without submitting another job', async () => {
    const { client, fetcher } = setup([json(job()), new Response(null, { status: 503, headers: { 'Retry-After': '7' } }), audio()])
    const pending = client.generate(input, { requestId })
    await vi.advanceTimersByTimeAsync(7000)
    await pending
    expect(fetcher.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1)
    expect(fetcher.mock.calls.slice(1).every(c => c[0] === result.url && c[1]?.headers === undefined)).toBe(true)
  })
  it('supports downloading an existing job after an error without submitting', async () => {
    const { client, fetcher } = setup([new Response(null, { status: 404 }), audio()], { maxRetries: 0 })
    await expect(client.downloadJob(job() as FlowSpeechJob)).rejects.toMatchObject({ code: 'download_error', jobId, requestId })
    expect(await client.downloadJob(job() as FlowSpeechJob)).toEqual(new Uint8Array(wav()))
    expect(fetcher.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true)
  })
  it.each([false, true])('rejects redirects before following (download=%s)', async download => {
    const redirect = new Response(null, { status: 302, headers: { Location: 'https://other.example.test' } })
    const { client, fetcher } = setup(download ? [json(job()), redirect] : [redirect])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'unexpected_redirect' })
    expect(fetcher).toHaveBeenCalledTimes(download ? 2 : 1)
    if (download) expect(fetcher.mock.calls[1]![1]?.headers).toBeUndefined()
  })
  it.each([false, true])('bounds audio before buffering (content-length=%s)', async declared => {
    const response = new Response(new Uint8Array(100), { headers: declared ? { 'Content-Length': '100' } : {} })
    const { client } = setup([json(job()), response], { maxAudioBytes: 50 })
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'response_too_large' })
  })
  it('rejects non-WAV data even if the API claimed audio/wav', async () => {
    const { client } = setup([json(job()), new Response('not a wave file')])
    await expect(client.generate(input, { requestId })).rejects.toMatchObject({ code: 'invalid_audio' })
  })
  it.each([
    { apiKey: null }, { timeoutMs: null }, { headers: 'invalid' }, { headers: { 'X-Test': 123 } },
    { apiKey: '' }, { apiKey: 'has whitespace' }, { apiKey: 'a\nb' }, { baseUrl: 'http://flowspeech.io' },
    { baseUrl: 'https://name:pass@flowspeech.io' }, { baseUrl: 'https://flowspeech.io/api/v1' },
    { baseUrl: 'https://flowspeech.io?key=abc' }, { timeoutMs: 0 }, { maxRetries: 6 }, { pollIntervalMs: 4999 },
    { maxAudioBytes: -1 }, { requestTimeoutMs: Infinity }, { headers: { aUtHoRiZaTiOn: 'override' } }, { headers: { Cookie: 'session=value' } },
    { headers: { 'Idempotency-Key': requestId } },
  ])('rejects invalid configuration %j', config => {
    expect(() => new FlowSpeechClient({ apiKey: 'unit-test-only', ...config } as FlowSpeechClientOptions)).toThrow(FlowSpeechError)
  })
  it.each([
    { mode: 'single', text: '', voiceName: 'Kore' },
    { ...input, speed: 1 }, { mode: 'multi', segments: [] },
    { mode: 'multi', segments: [{ speaker: 'Alice', text: 'Hi', voiceName: 'Kore' }, { speaker: 'Alice', text: 'Hi', voiceName: 'Puck' }] },
  ])('rejects invalid input %j before HTTP', async bad => {
    const { client, fetcher } = setup([])
    await expect(client.generate(bad as FlowSpeechInput, { requestId })).rejects.toBeInstanceOf(FlowSpeechError)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects malformed quota and voice responses', async () => {
    const { client } = setup([json({ data: { quota: {} } }), json({ voices: [{ name: 'Kore' }] })])
    await expect(client.getQuota()).rejects.toThrow('Malformed quota')
    await expect(client.listVoices()).rejects.toThrow('Malformed voices')
  })
})
