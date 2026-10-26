import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { extendedWav, invalidWavs, validWav } from './wav-fixtures.mjs'

const root = process.env.FLOWSPEECH_ARTIFACT_ROOT
  ? pathToFileURL(resolve(process.env.FLOWSPEECH_ARTIFACT_ROOT) + '/')
  : new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const api = await import(new URL('dist/index.js', root).href)
const requestId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const input = { mode: 'single', text: 'Hello', voiceName: 'Kore' }
const wav = Buffer.alloc(46)
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40)
const finished = { id: jobId, requestId, status: 'success', usage: { billableCharacters: 5, reservedCredits: 0, chargedCredits: 5 },
  result: { url: 'https://audio.example.test/test.wav', mimeType: 'audio/wav', sampleRate: 24000, channels: 1, bitsPerSample: 16 } }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status }) }
function fake(responses) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push([url, init])
    const response = responses.shift()
    assert.ok(response, 'No unexpected requests')
    return response
  }
  return { fetch, calls }
}
test('built client preserves valid RIFF chunks and rejects 27 malformed WAV variants', async () => {
  for (const bytes of [validWav(), extendedWav()]) {
    const { fetch } = fake([new Response(new Uint8Array(bytes))])
    assert.deepEqual(Buffer.from(await new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch }).downloadJob(finished)), bytes)
  }
  for (const [name, bytes] of invalidWavs()) {
    const { fetch, calls } = fake([new Response(new Uint8Array(bytes))])
    await assert.rejects(new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch }).downloadJob(finished), { code: 'invalid_audio', jobId, requestId }, name)
    assert.equal(calls.length, 1)
  }
  const bytes = validWav()
  for (let length = 0; length < bytes.length; length++) {
    const { fetch } = fake([new Response(new Uint8Array(bytes.subarray(0, length)))])
    await assert.rejects(new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch }).downloadJob(finished), { code: 'invalid_audio' })
  }
})
test('built client recovers from invalid WAV without creating a second job', async () => {
  const { fetch, calls } = fake([json(finished), new Response('<html>not audio</html>'), new Response(new Uint8Array(validWav()))])
  const client = new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch })
  await assert.rejects(client.generate(input, { requestId }), { code: 'invalid_audio', jobId, requestId })
  assert.deepEqual(Buffer.from(await client.downloadJob(finished)), validWav())
  assert.equal(calls.filter(([, init]) => init.method === 'POST').length, 1)
})
test('packed exports and release metadata', () => {
  assert.equal(pkg.version, '0.2.0')
  assert.equal(typeof api.FlowSpeechClient, 'function')
  assert.equal(typeof api.FlowSpeechError, 'function')
  assert.ok(readFileSync(new URL('dist/index.d.ts', root), 'utf8').includes('FlowSpeech'))
  assert.ok(readFileSync(new URL('CHANGELOG.md', root), 'utf8').includes('0.2.0'))
})
test('built client performs delayed polling and credential-free WAV download', async () => {
  const { fetch, calls } = fake([json({ ...finished, status: 'queued', result: null }, 202), json(finished), new Response(wav)])
  const client = new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch, timeoutMs: 15000 })
  const start = Date.now()
  const result = await client.generate(input, { requestId })
  assert.ok(Date.now() - start >= 4900, 'Poll must wait at least the default five seconds')
  assert.deepEqual(Buffer.from(result.audio), wav)
  assert.equal(new Headers(calls[0][1].headers).get('idempotency-key'), requestId)
  assert.equal(new Headers(calls[0][1].headers).get('authorization'), 'Bearer unit-test-only')
  assert.equal(calls[2][1].headers, undefined)
  assert.equal(calls[2][1].credentials, 'omit')
  assert.equal(calls[2][1].redirect, 'manual')
})
test('built client reports failed jobs and never repeats submission on download error', async () => {
  const { fetch, calls } = fake([json({ ...finished, status: 'failed', error: { code: 'TTS_FAILED' } }), json(finished), new Response(null, { status: 404 })])
  const client = new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch, maxRetries: 0 })
  await assert.rejects(client.generate(input, { requestId }), { code: 'TTS_FAILED', jobId, requestId })
  await assert.rejects(client.downloadJob(finished), { code: 'invalid_audio' })
  await assert.rejects(client.downloadJob(finished), { code: 'download_error', jobId, requestId })
  assert.equal(calls.filter(c => c[1].method === 'POST').length, 1)
})
test('built client reads quota/voices and enforces the deadline', async () => {
  const quota = { quota: { remaining: 20, reserved: 5, available: 15 }, subscription: { status: 'active' }, limits: {} }
  const { fetch } = fake([json(quota), json({ ...quota, subscription: null }), json({ voices: [{ name: 'Kore', description: 'Firm', gender: 'female' }] })])
  const client = new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch })
  assert.deepEqual(await client.getQuota(), quota)
  assert.deepEqual(await client.getQuota(), { ...quota, subscription: null })
  assert.equal((await client.listVoices())[0].name, 'Kore')
  const stalled = new api.FlowSpeechClient({ apiKey: 'unit-test-only', fetch: async () => new Promise(() => {}), timeoutMs: 20 })
  await assert.rejects(stalled.generate(input, { requestId }), { code: 'deadline_exceeded', requestId })
})

test('built TanStack adapter satisfies generateSpeech', async () => {
  const { generateSpeech } = await import('@tanstack/ai')
  const { fetch } = fake([json(finished), new Response(wav)])
  const result = await generateSpeech({ adapter: api.flowspeechSpeech('flowspeech-tts', { apiKey: 'unit-test-only', fetch }), text: 'Hello', modelOptions: { requestId } })
  assert.equal(result.id, jobId)
  assert.equal(result.audio, wav.toString('base64'))
  assert.equal(result.format, 'wav')
})
