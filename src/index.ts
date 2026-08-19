import { BaseTTSAdapter } from '@tanstack/ai/adapters'
import type { TTSOptions, TTSResult } from '@tanstack/ai'

const DEFAULT_BASE_URL = 'https://flowspeech.io/api/ai/text-to-speech'
const DEFAULT_VOICE = 'Kore'
const DEFAULT_TIMEOUT = 60_000

export type FlowSpeechModel = 'flowspeech-tts' | (string & {})

export interface FlowSpeechSpeechProviderOptions {
  /** Voice name used when `generateSpeech().voice` is omitted. */
  voiceName?: string
  /** Optional second voice for text marked with Speaker1/Speaker2. */
  speakerB?: string
}

export interface FlowSpeechAdapterConfig {
  /** FlowSpeech TTS endpoint. */
  baseUrl?: string
  /** Extra request headers. */
  headers?: Record<string, string>
  /** Request timeout in milliseconds. */
  timeout?: number
  /** Custom fetch implementation, useful for runtimes and tests. */
  fetch?: typeof fetch
}

interface FlowSpeechApiResponse {
  code: number
  message?: string
  data?: {
    mimeType: string
    audioBase64: string
    sampleRate: number
    numChannels: number
    bitsPerSample: number
  }
}

export class FlowSpeechSpeechAdapter<
  TModel extends FlowSpeechModel,
> extends BaseTTSAdapter<TModel, FlowSpeechSpeechProviderOptions> {
  readonly name = 'flowspeech' as const

  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeout: number
  private readonly fetcher: typeof fetch

  constructor(model: TModel, config: FlowSpeechAdapterConfig = {}) {
    super(model, config)
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.headers = config.headers ?? {}
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
    this.fetcher = config.fetch ?? globalThis.fetch
  }

  async generateSpeech(
    options: TTSOptions<FlowSpeechSpeechProviderOptions>,
  ): Promise<TTSResult> {
    const { logger } = options
    logger.request(
      `activity=generateSpeech provider=flowspeech model=${this.model}`,
      { provider: 'flowspeech', model: this.model },
    )

    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(), this.timeout)
    const signal = combineAbortSignals(options.abortSignal, timeoutController.signal)

    try {
      const voiceName =
        options.voice ?? options.modelOptions?.voiceName ?? DEFAULT_VOICE
      const speakerB = options.modelOptions?.speakerB
      const speakers = speakerB
        ? [
            { speaker: 'Speaker1', voiceName },
            { speaker: 'Speaker2', voiceName: speakerB },
          ]
        : [{ voiceName }]

      const response = await this.fetcher(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers,
        },
        body: JSON.stringify({ text: options.text, speakers }),
        signal,
      })

      if (!response.ok) {
        const detail = await response.text()
        throw new Error(
          `FlowSpeech API error (${response.status}): ${detail || response.statusText}`,
        )
      }

      const payload = (await response.json()) as FlowSpeechApiResponse
      if (
        payload.code !== 0 ||
        !payload.data?.audioBase64 ||
        !payload.data.mimeType
      ) {
        throw new Error(payload.message || 'FlowSpeech returned no audio data.')
      }

      return {
        id: this.generateId(),
        model: this.model,
        audio: payload.data.audioBase64,
        format: inferFormat(payload.data.mimeType),
        contentType: payload.data.mimeType,
      }
    } catch (error) {
      logger.errors('flowspeech.generateSpeech fatal', {
        error,
        source: 'flowspeech.generateSpeech',
      })
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }
}

export function flowspeechSpeech<TModel extends FlowSpeechModel>(
  model: TModel,
  config?: FlowSpeechAdapterConfig,
): FlowSpeechSpeechAdapter<TModel> {
  return new FlowSpeechSpeechAdapter(model, config)
}

function inferFormat(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  if (normalized.includes('wav')) return 'wav'
  if (normalized.includes('opus')) return 'opus'
  if (normalized.includes('aac')) return 'aac'
  if (normalized.includes('flac')) return 'flac'
  if (normalized.includes('pcm') || normalized.includes('l16')) return 'pcm'
  return normalized.split('/')[1]?.split(';')[0] || 'audio'
}

function combineAbortSignals(
  requestSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  if (!requestSignal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([requestSignal, timeoutSignal])
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  requestSignal.addEventListener('abort', abort, { once: true })
  timeoutSignal.addEventListener('abort', abort, { once: true })
  if (requestSignal.aborted || timeoutSignal.aborted) controller.abort()
  return controller.signal
}
