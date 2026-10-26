import { BaseTTSAdapter } from '@tanstack/ai/adapters'
import type { TTSOptions, TTSResult } from '@tanstack/ai'
import { FlowSpeechClient, FlowSpeechError, rejectUnsupported, type FlowSpeechClientOptions, type FlowSpeechInput } from './flowspeech-client.js'

export * from './flowspeech-client.js'
export type FlowSpeechModel = 'flowspeech-tts' | (string & {})
export interface FlowSpeechSpeechProviderOptions {
  voiceName?: string
  /** Compatibility parser for scripts labeled Speaker1: and Speaker2:. */
  speakerB?: string
  segments?: Extract<FlowSpeechInput, { mode: 'multi' }>['segments']
  requestId?: string
}
export interface FlowSpeechAdapterConfig extends FlowSpeechClientOptions {
  /** Alias for timeoutMs; total operation deadline, not just the initial request. */
  timeout?: number
}
export interface FlowSpeechTTSResult extends TTSResult {
  requestId: string
  jobId: string
  creditUsage: { billableCharacters: number; reservedCredits: number; chargedCredits: number }
}

/** Preserve the legacy two-voice script surface, but emit explicit v1 segments. */
function scriptSegments(script: string, voiceName: string, speakerB: string): Extract<FlowSpeechInput, { mode: 'multi' }>['segments'] {
  if (/\bSpeaker(?![12]:)\d+:/.test(script)) throw new FlowSpeechError('Only Speaker1: and Speaker2: labels are supported; use explicit segments for other speakers', 'invalid_request')
  const matches = [...script.matchAll(/(?:^|\s)(Speaker[12]):\s*/g)]
  if (!matches.length || script.slice(0, matches[0]!.index).trim()) throw new FlowSpeechError('Two-speaker scripts must begin with Speaker1: or Speaker2:', 'invalid_request')
  return matches.map((match, index) => ({
    speaker: match[1]!,
    voiceName: match[1] === 'Speaker1' ? voiceName : speakerB,
    text: script.slice(match.index! + match[0].length, matches[index + 1]?.index ?? script.length).trim(),
  }))
}

export class FlowSpeechSpeechAdapter<TModel extends FlowSpeechModel> extends BaseTTSAdapter<TModel, FlowSpeechSpeechProviderOptions> {
  readonly name = 'flowspeech' as const
  private readonly client: FlowSpeechClient
  constructor(model: TModel, config: FlowSpeechAdapterConfig = {}) {
    super(model, config)
    if (model !== 'flowspeech-tts') throw new FlowSpeechError('Unsupported FlowSpeech model identifier', 'unsupported_option')
    if (config.timeout !== undefined && config.timeoutMs !== undefined && config.timeout !== config.timeoutMs) throw new FlowSpeechError('timeout and timeoutMs disagree', 'invalid_configuration')
    this.client = new FlowSpeechClient({ ...config, timeoutMs: config.timeoutMs ?? config.timeout })
  }
  async generateSpeech(options: TTSOptions<FlowSpeechSpeechProviderOptions>): Promise<FlowSpeechTTSResult> {
    const { logger } = options
    logger.request('activity=generateSpeech provider=flowspeech model=' + this.model, { provider: 'flowspeech', model: this.model })
    try {
      if (options.model !== this.model) throw new FlowSpeechError('TTS model does not match the adapter', 'unsupported_option')
      rejectUnsupported({ speed: options.speed }, [])
      if (options.format !== undefined && options.format !== 'wav') throw new FlowSpeechError('FlowSpeech v1 only supports WAV output', 'unsupported_option')
      const modelOptions = options.modelOptions ?? {}
      rejectUnsupported(modelOptions, ['voiceName', 'speakerB', 'segments', 'requestId'])
      const voiceName = options.voice ?? modelOptions.voiceName ?? 'Kore'
      if (modelOptions.segments !== undefined && (options.text.trim() || modelOptions.speakerB !== undefined)) throw new FlowSpeechError('Explicit segments require empty text and no speakerB', 'invalid_request')
      const segments = modelOptions.segments ?? (modelOptions.speakerB === undefined ? undefined : scriptSegments(options.text, voiceName, modelOptions.speakerB))
      const input: FlowSpeechInput = segments === undefined ? { mode: 'single', text: options.text, voiceName } : { mode: 'multi', segments }
      const result = await this.client.generate(input, { requestId: modelOptions.requestId, signal: options.abortSignal })
      return {
        id: result.job.id, jobId: result.job.id, requestId: result.requestId, model: this.model,
        audio: Buffer.from(result.audio).toString('base64'), format: 'wav', contentType: 'audio/wav', creditUsage: result.job.usage,
      }
    } catch (error) {
      logger.errors('flowspeech.generateSpeech fatal', { error, source: 'flowspeech.generateSpeech' })
      throw error
    }
  }
}
export function flowspeechSpeech<TModel extends FlowSpeechModel>(model: TModel, config?: FlowSpeechAdapterConfig): FlowSpeechSpeechAdapter<TModel> {
  return new FlowSpeechSpeechAdapter(model, config)
}
