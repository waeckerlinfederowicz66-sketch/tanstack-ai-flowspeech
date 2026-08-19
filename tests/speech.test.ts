import { describe, expect, it, vi } from 'vitest'
import type { TTSOptions } from '@tanstack/ai'
import { flowspeechSpeech } from '../src/index.js'

function makeLogger() {
  return {
    request: vi.fn(),
    response: vi.fn(),
    provider: vi.fn(),
    errors: vi.fn(),
  } as unknown as TTSOptions['logger']
}

function successResponse(mimeType = 'audio/wav') {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        mimeType,
        audioBase64: 'AQID',
        sampleRate: 24000,
        numChannels: 1,
        bitsPerSample: 16,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('flowspeechSpeech', () => {
  it('sends text and the requested voice, then returns TanStack TTS output', async () => {
    const fetcher = vi.fn().mockResolvedValue(successResponse())
    const adapter = flowspeechSpeech('flowspeech-tts', { fetch: fetcher })

    const result = await adapter.generateSpeech({
      model: 'flowspeech-tts',
      text: 'Hello from FlowSpeech.',
      voice: 'Charon',
      logger: makeLogger(),
    })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://flowspeech.io/api/ai/text-to-speech')
    expect(JSON.parse(init.body)).toEqual({
      text: 'Hello from FlowSpeech.',
      speakers: [{ voiceName: 'Charon' }],
    })
    expect(result).toMatchObject({
      model: 'flowspeech-tts',
      audio: 'AQID',
      format: 'wav',
      contentType: 'audio/wav',
    })
    expect(result.id).toMatch(/^flowspeech-/)
  })

  it('uses Kore by default and supports two-speaker input', async () => {
    const fetcher = vi.fn().mockResolvedValue(successResponse('audio/mpeg'))
    const adapter = flowspeechSpeech('flowspeech-tts', { fetch: fetcher })

    const result = await adapter.generateSpeech({
      model: 'flowspeech-tts',
      text: 'Speaker1: Hello. Speaker2: Hi.',
      modelOptions: { speakerB: 'Puck' },
      logger: makeLogger(),
    })

    const body = JSON.parse(fetcher.mock.calls[0]![1].body)
    expect(body.speakers).toEqual([
      { speaker: 'Speaker1', voiceName: 'Kore' },
      { speaker: 'Speaker2', voiceName: 'Puck' },
    ])
    expect(result.format).toBe('mp3')
  })

  it('reports API errors through the TanStack logger', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }))
    const logger = makeLogger()
    const adapter = flowspeechSpeech('flowspeech-tts', { fetch: fetcher })

    await expect(
      adapter.generateSpeech({
        model: 'flowspeech-tts',
        text: 'Hello',
        logger,
      }),
    ).rejects.toThrow('FlowSpeech API error (429)')
    expect(logger.errors).toHaveBeenCalledWith(
      'flowspeech.generateSpeech fatal',
      expect.objectContaining({ source: 'flowspeech.generateSpeech' }),
    )
  })

  it('rejects successful HTTP responses that contain no audio', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 1, message: 'Invalid text' })),
      )
    const adapter = flowspeechSpeech('flowspeech-tts', { fetch: fetcher })

    await expect(
      adapter.generateSpeech({
        model: 'flowspeech-tts',
        text: '',
        logger: makeLogger(),
      }),
    ).rejects.toThrow('Invalid text')
  })
})
