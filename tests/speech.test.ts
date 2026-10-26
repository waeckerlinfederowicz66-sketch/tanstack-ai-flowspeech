import { generateSpeech, type TTSOptions } from '@tanstack/ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flowspeechSpeech } from '../src/index.js'
import { audio, job, jobId, json, requestId, wav } from './fixtures.js'
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('FLOWSPEECH_API_KEY', '') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function logger() { return { request: vi.fn(), response: vi.fn(), provider: vi.fn(), errors: vi.fn() } as unknown as TTSOptions['logger'] }
function setup() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(job('queued'), 202)).mockResolvedValueOnce(json(job())).mockResolvedValueOnce(audio())
  return { fetcher, adapter: flowspeechSpeech('flowspeech-tts', { apiKey: 'unit-test-only', fetch: fetcher }) }
}
describe('TanStack TTS adapter', () => {
  it('preserves base64 WAV output through the real generateSpeech activity', async () => {
    const { fetcher, adapter } = setup()
    const pending = generateSpeech({ adapter, text: 'Hello', voice: 'Charon', format: 'wav', modelOptions: { requestId } })
    await vi.advanceTimersByTimeAsync(5000)
    const value = await pending
    expect(value).toMatchObject({ id: jobId, audio: wav().toString('base64'), format: 'wav', contentType: 'audio/wav' })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ input: { mode: 'single', text: 'Hello', voiceName: 'Charon' } })
  })
  it('translates legacy Speaker1/Speaker2 scripts into v1 ordered segments', async () => {
    const { fetcher, adapter } = setup()
    const pending = adapter.generateSpeech({ model: 'flowspeech-tts', text: 'Speaker1: Welcome. Speaker2: Hello.\nSpeaker1: Again.', modelOptions: { speakerB: 'Puck', requestId }, logger: logger() })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ requestId, jobId, creditUsage: { chargedCredits: 5 } })
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ input: { mode: 'multi', segments: [
      { speaker: 'Speaker1', text: 'Welcome.', voiceName: 'Kore' },
      { speaker: 'Speaker2', text: 'Hello.', voiceName: 'Puck' },
      { speaker: 'Speaker1', text: 'Again.', voiceName: 'Kore' },
    ] } })
  })
  it('accepts explicit multi-speaker turns', async () => {
    const { fetcher, adapter } = setup()
    const segments = [{ speaker: 'Alice', text: 'Hello', voiceName: 'Puck' }]
    const pending = adapter.generateSpeech({ model: 'flowspeech-tts', text: '', modelOptions: { segments, requestId }, logger: logger() })
    await vi.advanceTimersByTimeAsync(5000)
    await pending
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ input: { mode: 'multi', segments } })
  })
  it.each([{ speed: 1 }, { format: 'mp3' as const }, { modelOptions: { source: 'legacy' } }])('rejects unsupported options %j and logs the error', async extra => {
    const { fetcher, adapter } = setup()
    const log = logger()
    await expect(adapter.generateSpeech({ model: 'flowspeech-tts', text: 'Hello', logger: log, ...extra } as TTSOptions)).rejects.toMatchObject({ code: 'unsupported_option' })
    expect(log.request).toHaveBeenCalled()
    expect(log.errors).toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects ambiguous two-speaker scripts', async () => {
    const { adapter, fetcher } = setup()
    await expect(adapter.generateSpeech({ model: 'flowspeech-tts', text: 'Unlabelled text', modelOptions: { speakerB: 'Puck' }, logger: logger() })).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('preserves timeout alias as a total deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(job('queued')))
    const adapter = flowspeechSpeech('flowspeech-tts', { apiKey: 'unit-test-only', fetch: fetcher, timeout: 100 })
    const assertion = expect(adapter.generateSpeech({ model: 'flowspeech-tts', text: 'Hello', modelOptions: { requestId }, logger: logger() })).rejects.toMatchObject({ code: 'deadline_exceeded', jobId })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })
  it('honors activity cancellation during polling', async () => {
    vi.spyOn(console, 'dir').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { adapter, fetcher } = setup()
    const controller = new AbortController()
    const assertion = expect(generateSpeech({ adapter, text: 'Hello', abortSignal: controller.signal, modelOptions: { requestId } })).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
