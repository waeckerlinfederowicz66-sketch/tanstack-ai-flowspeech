import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FlowSpeechClient } from '../src/flowspeech-client.js'
import { input, job, jobId, json, requestId, audio } from './fixtures.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T00:00:00Z')) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const key = 'review_secret_canary'
const extra = 'review_header_canary'
const url = 'https://storage.example.test/private.wav?signature=review-only'
const broken = (status: number, headers = {}) => new Response(new ReadableStream({
  start(controller) { controller.error(new Error(url)) },
}), { status, headers })
function setup(responses: Response[], options = {}) {
  const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!)
  return { fetcher, client: new FlowSpeechClient({ apiKey: key, headers: { 'X-Private': extra }, fetch: fetcher, ...options }) }
}
it.each([401, 403, 404, 422])('does not retry an unreadable permanent HTTP %s response', async status => {
  const { client, fetcher } = setup([broken(status)], { maxRetries: 1 })
  await expect(client.generate(input, { requestId })).rejects.toMatchObject({ status, retryable: false, requestId })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each([401, 403])('permanent status overrides contradictory retryable=true on HTTP %s', async status => {
  const { client, fetcher } = setup([json({ error: { code: 'denied', retryable: true } }, status)], { maxRetries: 1 })
  await expect(client.generate(input, { requestId })).rejects.toMatchObject({ status, retryable: false })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('keeps the status when a body times out after headers', async () => {
  const { client, fetcher } = setup([new Response(new ReadableStream({ start() {} }), { status: 401 })], { requestTimeoutMs: 100 })
  const assertion = expect(client.generate(input, { requestId })).rejects.toMatchObject({ status: 401, code: 'request_timeout', retryable: false })
  await vi.advanceTimersByTimeAsync(100)
  await assertion
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each([429, 503])('honors Retry-After after an interrupted HTTP %s body with the original request', async status => {
  const { client, fetcher } = setup([broken(status, { 'Retry-After': '30' }), json(job()), audio()], { maxRetries: 1 })
  const pending = client.generate(input, { requestId })
  await vi.advanceTimersByTimeAsync(29999)
  expect(fetcher).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[1]![1]?.body)
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('idempotency-key')).toBe(requestId)
})
it('exposes the received cooldown on an exhausted body failure', async () => {
  const { client } = setup([broken(429, { 'Retry-After': '30' })], { maxRetries: 0 })
  await expect(client.generate(input, { requestId })).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 30000, requestId })
})
it.each([key, extra, url, 'token\n', 'token\r', 'token\t', 'A'.repeat(129)])('does not reflect untrusted diagnostics %s', async value => {
  const { client } = setup([json({ error: { code: value, message: value }, traceId: value }, 403)])
  const error = await client.getQuota().catch(error => error)
  expect(error.status).toBe(403)
  expect(error.code).toBe('http_error')
  expect(error.traceId).toBeUndefined()
  expect(String(error)).not.toContain(value)
  expect(JSON.stringify(error)).not.toContain(value)
})
it('retains bounded safe diagnostic tokens', async () => {
  const { client } = setup([json({ error: { code: 'subscription_required', message: url }, traceId: requestId }, 403)])
  await expect(client.getQuota()).rejects.toMatchObject({ code: 'subscription_required', traceId: requestId, status: 403 })
})
it.each(['failed', 'cancelled'] as const)('sanitizes returned %s jobs and thrown terminal failures', async status => {
  const body = job(status, { error: { code: key, message: url, retryable: false, detail: extra }, traceId: url })
  const { client } = setup([json(body), json(body), json(body)])
  const found = await client.getJob(jobId)
  expect(found.id).toBe(jobId)
  expect(found.error).toEqual({ code: 'job_error', message: 'FlowSpeech job failed', retryable: false })
  expect(JSON.stringify(found)).not.toContain(url)
  expect((await client.findJob(requestId)).requestId).toBe(requestId)
  const failure = await client.generate(input, { requestId }).catch(error => error)
  expect(String(failure)).not.toContain(url)
  expect(failure.requestId).toBe(requestId)
  expect(failure.jobId).toBe(jobId)
})
