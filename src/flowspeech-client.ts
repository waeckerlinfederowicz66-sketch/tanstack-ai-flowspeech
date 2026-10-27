import { randomUUID } from 'node:crypto'

export type FlowSpeechInput =
  | { mode: 'single'; text: string; voiceName: string }
  | { mode: 'multi'; segments: Array<{ speaker: string; text: string; voiceName: string }> }

export interface FlowSpeechResult {
  url: string
  mimeType: 'audio/wav'
  sampleRate: 24000
  channels: 1
  bitsPerSample: 16
}

export interface FlowSpeechJob {
  id: string
  requestId: string
  status: 'queued' | 'running' | 'merging' | 'settling' | 'success' | 'failed' | 'cancelled'
  result?: FlowSpeechResult | null
  resultDeleted?: boolean
  usage: { billableCharacters: number; reservedCredits: number; chargedCredits: number }
  error?: { code: string; message?: string; retryable?: boolean } | null
}

export interface FlowSpeechQuota {
  quota: { remaining: number; reserved: number; available: number }
  /** Optional compatibility field; production v1 returns subscription. */
  entitlement?: Record<string, unknown> | null
  /** Canonical public API v1 subscription metadata. */
  subscription?: Record<string, unknown> | null
  limits: Record<string, unknown>
}

export interface FlowSpeechVoice { name: string; description: string; gender: string }

export interface FlowSpeechClientOptions {
  apiKey?: string | undefined
  /** HTTPS API origin, not an endpoint path. */
  baseUrl?: string | undefined
  /** API-only headers. Authentication, cookies and idempotency headers cannot be overridden. */
  headers?: Record<string, string> | undefined
  fetch?: typeof fetch | undefined
  /** Total operation deadline, including requests, waits, retries and audio download. */
  timeoutMs?: number | undefined
  requestTimeoutMs?: number | undefined
  /** At least 5000 ms. */
  pollIntervalMs?: number | undefined
  /** Number of retries per HTTP operation, between zero and five. */
  maxRetries?: number | undefined
  maxAudioBytes?: number | undefined
}

export interface FlowSpeechOperationOptions {
  requestId?: string | undefined
  signal?: AbortSignal | undefined
}

export class FlowSpeechError extends Error {
  readonly name = 'FlowSpeechError'
  requestId?: string
  jobId?: string
  retryAfterMs?: number
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly traceId?: string,
    readonly retryable = false,
  ) { super(message) }
}

type Context = { signal: AbortSignal; requestId?: string | undefined; jobId?: string | undefined }
type Reply = { value: unknown; retryAfter: number; headers: Record<string, string> }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const statuses = new Set(['queued', 'running', 'merging', 'settling', 'success', 'failed', 'cancelled'])
const forbiddenHeaders = /^(authorization|proxy-authorization|cookie|cookie2|host|idempotency-key|content-type|content-length|connection|transfer-encoding)$/i

function fail(message: string, code = 'invalid_response'): never {
  throw new FlowSpeechError(message, code)
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) fail('Invalid ' + label + ' UUID', 'invalid_request')
  return value.toLowerCase()
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(label + ' must not be empty', 'invalid_request')
}
function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function integer(value: number, label: string, min = 1, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('Invalid ' + label, 'invalid_configuration')
  return value
}
export function rejectUnsupported(value: object, supported: readonly string[]): void {
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && !supported.includes(key)) fail('Unsupported FlowSpeech option: ' + key, 'unsupported_option')
  }
}
export function normalizeApiOrigin(value = 'https://flowspeech.io'): string {
  let url: URL
  try { url = new URL(value) } catch { return fail('Invalid FlowSpeech baseUrl', 'invalid_configuration') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('FlowSpeech baseUrl must be an HTTPS origin without credentials, path, query or fragment', 'invalid_configuration')
  }
  return url.origin
}
function audioUrl(value: unknown): string {
  if (typeof value !== 'string') fail('Missing audio URL')
  let url: URL
  try { url = new URL(value) } catch { return fail('Invalid audio URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('Unsafe audio URL')
  return url.href
}
function validateInput(input: FlowSpeechInput): FlowSpeechInput {
  if (!record(input)) fail('Invalid input', 'invalid_request')
  if (input.mode === 'single') {
    rejectUnsupported(input, ['mode', 'text', 'voiceName'])
    text(input.text, 'text'); text(input.voiceName, 'voiceName')
    if (input.text.length > 100_000) fail('Text exceeds 100000 UTF-16 code units', 'invalid_request')
    return { mode: 'single', text: input.text, voiceName: input.voiceName }
  }
  if (input.mode !== 'multi' || !Array.isArray(input.segments) || input.segments.length < 1 || input.segments.length > 1000) {
    fail('Multi input requires 1 to 1000 segments', 'invalid_request')
  }
  rejectUnsupported(input, ['mode', 'segments'])
  let length = 0
  const speakers = new Map<string, string>()
  const segments = input.segments.map(segment => {
    if (!record(segment)) fail('Invalid segment', 'invalid_request')
    rejectUnsupported(segment, ['speaker', 'text', 'voiceName'])
    text(segment.speaker, 'speaker'); text(segment.text, 'text'); text(segment.voiceName, 'voiceName')
    if (segment.speaker.length > 100) fail('Speaker label exceeds 100 characters', 'invalid_request')
    if (speakers.has(segment.speaker) && speakers.get(segment.speaker) !== segment.voiceName) {
      fail('A speaker must use the same voice in every segment', 'invalid_request')
    }
    speakers.set(segment.speaker, segment.voiceName)
    length += segment.text.length
    return { speaker: segment.speaker, text: segment.text, voiceName: segment.voiceName }
  })
  if (length > 100_000) fail('Text exceeds 100000 UTF-16 code units', 'invalid_request')
  return { mode: 'multi', segments }
}

function job(value: unknown, ctx: Context, token: (value: unknown) => string | undefined): FlowSpeechJob {
  if (!record(value)) fail('Malformed job')
  const id = uuid(value.id, 'job ID')
  if (ctx.jobId && ctx.jobId !== id) fail('Job ID changed unexpectedly')
  ctx.jobId = id
  if (typeof value.requestId !== 'string' || !uuidPattern.test(value.requestId)) fail('Missing or invalid job request ID')
  const requestId = value.requestId.toLowerCase()
  if (ctx.requestId && ctx.requestId !== requestId) fail('Request ID changed unexpectedly')
  ctx.requestId = requestId
  if (typeof value.status !== 'string' || !statuses.has(value.status)) fail('Unknown job status')
  if (!record(value.usage) || !['billableCharacters', 'reservedCredits', 'chargedCredits'].every(k => number((value.usage as Record<string, unknown>)[k]))) {
    fail('Missing or invalid job usage')
  }
  if (value.resultDeleted !== undefined && typeof value.resultDeleted !== 'boolean') fail('Invalid resultDeleted flag')
  if (value.status === 'success' && !(value.result === null && value.resultDeleted === true)) {
    const result = value.result
    if (!record(result) || result.mimeType !== 'audio/wav' || result.sampleRate !== 24000 || result.channels !== 1 || result.bitsPerSample !== 16) {
      fail('Missing or malformed WAV result')
    }
    audioUrl(result.url)
  }
  const error = value.error == null ? value.error : {
    code: token(record(value.error) ? value.error.code : undefined) ?? 'job_error',
    message: 'FlowSpeech job failed',
    ...(record(value.error) && typeof value.error.retryable === 'boolean' ? { retryable: value.error.retryable } : {}),
  }
  const metadata: Record<string, unknown> = {}
  for (const name of ['createdAt', 'updatedAt', 'deadlineAt']) {
    const item = value[name]
    if (typeof item === 'string' && item.length === 24 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))) metadata[name] = item
  }
  if (record(value.progress) && number(value.progress.completed) && number(value.progress.total)) {
    metadata.progress = { completed: value.progress.completed, total: value.progress.total }
  }
  return {
    ...metadata,
    id, requestId, status: value.status, usage: value.usage,
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(value.resultDeleted !== undefined ? { resultDeleted: value.resultDeleted } : {}),
    ...(value.error !== undefined ? { error } : {}),
  } as FlowSpeechJob
}

function retryAfter(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(ms, 2_147_483_647)) }), signal)
  } finally { clearTimeout(timer) }
}
async function boundedBody(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length && Number(length) > max) {
    void response.body?.cancel().catch(() => {})
    fail('FlowSpeech response exceeds ' + max + ' bytes', 'response_too_large')
  }
  if (!response.body) fail('Empty response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > max) fail('FlowSpeech response exceeds ' + max + ' bytes', 'response_too_large')
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return output
}

// Validate bounded RIFF chunks without rewriting samples or discarding metadata.
async function validateWav(bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  const invalid = () => fail('Invalid WAV: expected complete 24000 Hz mono 16-bit PCM with nonempty aligned data', 'invalid_audio')
  if (bytes.length < 12) invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number) => view.getUint32(offset)
  if (tag(0) !== 0x52494646 || tag(8) !== 0x57415645 || view.getUint32(4, true) + 8 !== bytes.length) invalid()
  let offset = 12
  let formatSeen = false
  let dataSeen = false
  let chunks = 0
  while (offset < bytes.length) {
    if (signal.aborted) throw signal.reason
    // Let cancellation/deadline timers run even for many tiny unknown chunks.
    if (++chunks % 1024 === 0) await wait(0, signal)
    if (bytes.length - offset < 8) invalid()
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + size
    const next = end + (size & 1)
    if (next > bytes.length) invalid()
    switch (tag(offset)) {
      case 0x666d7420: // fmt
        if (formatSeen || dataSeen || (size !== 16 && size !== 18)) invalid()
        if (view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1 ||
          view.getUint32(start + 4, true) !== 24000 || view.getUint32(start + 8, true) !== 48000 ||
          view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16 ||
          (size === 18 && view.getUint16(start + 16, true) !== 0)) invalid()
        formatSeen = true
        break
      case 0x64617461: // data
        if (!formatSeen || dataSeen || size === 0 || size % 2 !== 0) invalid()
        dataSeen = true
        break
    }
    offset = next
  }
  if (!formatSeen || !dataSeen) invalid()
  if (signal.aborted) throw signal.reason
}

export class FlowSpeechClient {
  private readonly key: string
  private readonly origin: string
  private readonly headers: Headers
  private readonly fetcher: typeof fetch
  private readonly timeout: number
  private readonly requestTimeout: number
  private readonly interval: number
  private readonly retries: number
  private readonly maxAudio: number

  constructor(options: FlowSpeechClientOptions = {}) {
    if (typeof options !== 'object' || options === null || Array.isArray(options) || Object.values(options).some(value => value === null)) fail('Invalid FlowSpeech configuration', 'invalid_configuration')
    if (options.headers !== undefined && (!record(options.headers) || Object.values(options.headers).some(value => typeof value !== 'string'))) fail('Invalid API headers', 'invalid_configuration')
    const key = options.apiKey ?? process.env.FLOWSPEECH_API_KEY
    if (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key)) fail('A valid server-side FlowSpeech API key is required', 'invalid_configuration')
    this.key = key
    this.origin = normalizeApiOrigin(options.baseUrl)
    this.headers = new Headers()
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (forbiddenHeaders.test(name)) fail('Reserved FlowSpeech header: ' + name, 'invalid_configuration')
      try { this.headers.set(name, value) } catch { fail('Invalid API header', 'invalid_configuration') }
    }
    this.fetcher = options.fetch ?? globalThis.fetch
    if (typeof this.fetcher !== 'function') fail('A fetch implementation is required', 'invalid_configuration')
    this.timeout = integer(options.timeoutMs ?? 600_000, 'timeoutMs')
    this.requestTimeout = integer(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs')
    this.interval = integer(options.pollIntervalMs ?? 5000, 'pollIntervalMs', 5000)
    this.retries = integer(options.maxRetries ?? 2, 'maxRetries', 0, 5)
    this.maxAudio = integer(options.maxAudioBytes ?? 64 * 1024 * 1024, 'maxAudioBytes')
  }

  private clean(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[^A-Za-z0-9_-]/.test(value) || value.includes(this.key)) return undefined
    for (const secret of this.headers.values()) if (secret && value.includes(secret)) return undefined
    return value
  }

  private job(value: unknown, ctx: Context): FlowSpeechJob {
    return job(value, ctx, value => this.clean(value))
  }

  private async operation<T>(options: FlowSpeechOperationOptions, fn: (ctx: Context) => Promise<T>, jobId?: string): Promise<T> {
    const controller = new AbortController()
    const cancel = () => controller.abort(new FlowSpeechError('FlowSpeech operation aborted; the server job was not cancelled', 'aborted'))
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const timer = setTimeout(() => controller.abort(new FlowSpeechError('FlowSpeech total deadline exceeded; recover with the same request or job ID', 'deadline_exceeded')), this.timeout)
    const ctx: Context = { signal: controller.signal }
    try {
      if (options.requestId !== undefined) ctx.requestId = uuid(options.requestId, 'request ID')
      if (jobId !== undefined) ctx.jobId = uuid(jobId, 'job ID')
      if (ctx.signal.aborted) throw ctx.signal.reason
      return await abortable(fn(ctx), ctx.signal)
    } catch (error) {
      const safe = error instanceof FlowSpeechError ? error : new FlowSpeechError('FlowSpeech request failed', 'network_error', undefined, undefined, true)
      if (ctx.requestId) safe.requestId = ctx.requestId
      if (ctx.jobId) safe.jobId = ctx.jobId
      throw safe
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
  }

  private async request(url: string, init: RequestInit, ctx: Context, download = false): Promise<Reply | Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      if (ctx.signal.aborted) throw ctx.signal.reason
      const controller = new AbortController()
      const abort = () => controller.abort(ctx.signal.reason)
      ctx.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new FlowSpeechError('FlowSpeech request timed out', 'request_timeout', undefined, undefined, true)), this.requestTimeout)
      let delay = this.interval
      let response: Response | undefined
      try {
        response = await abortable(this.fetcher(url, {
          ...init, signal: controller.signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        }), controller.signal)
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          void response.body?.cancel().catch(() => {})
          fail('Unexpected redirect rejected', 'unexpected_redirect')
        }
        delay = Math.max(this.interval, retryAfter(response.headers.get('retry-after')))
        if (download && !response.ok) {
          void response.body?.cancel().catch(() => {})
          throw new FlowSpeechError('FlowSpeech audio download failed (HTTP ' + response.status + ')', 'download_error', response.status, undefined, response.status === 429 || response.status >= 500)
        }
        const bytes = !response.ok && !response.body ? new Uint8Array()
          : await boundedBody(response, download ? this.maxAudio : 1024 * 1024, controller.signal)
        if (download) {
          await validateWav(bytes, controller.signal)
          return bytes
        }
        let value: unknown
        try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch {
          if (!response.ok) throw new FlowSpeechError('FlowSpeech API error (HTTP ' + response.status + ')', 'http_error', response.status, undefined, response.status === 429 || response.status >= 500)
          fail('Malformed API JSON')
        }
        if (!response.ok) {
          const error = record(value) && record(value.error) ? value.error : {}
          const code = this.clean(error.code) ?? 'http_error'
          const traceId = record(value) ? this.clean(value.traceId) : undefined
          throw new FlowSpeechError('FlowSpeech API error (HTTP ' + response.status + ')', code, response.status, traceId,
            error.retryable !== false && (response.status === 429 || response.status >= 500))
        }
        return { value, retryAfter: delay, headers: Object.fromEntries(response.headers) }
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason
        let safe = error instanceof FlowSpeechError ? error
          : controller.signal.aborted ? controller.signal.reason as FlowSpeechError
          : new FlowSpeechError('FlowSpeech network request failed', download ? 'download_error' : 'network_error', undefined, undefined, true)
        // Headers remain authoritative even if the body stream or its cleanup fails.
        if (response && safe.status === undefined) {
          safe = new FlowSpeechError(safe.message, safe.code, response.status, safe.traceId,
            safe.retryable && (response.ok || response.status === 429 || response.status >= 500))
        }
        if (response) safe.retryAfterMs = delay
        if (!safe.retryable || attempt >= this.retries) throw safe
      } finally {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abort)
      }
      await wait(delay, ctx.signal)
    }
  }

  private async api(path: string, ctx: Context, body?: string, method = 'GET'): Promise<Reply> {
    const headers = new Headers(this.headers)
    headers.set('Authorization', 'Bearer ' + this.key)
    headers.set('Accept', 'application/json')
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json')
      headers.set('Idempotency-Key', ctx.requestId!)
    }
    return await this.request(this.origin + '/api/v1' + path, { method, headers, ...(body === undefined ? {} : { body }) }, ctx) as Reply
  }

  async generate(input: FlowSpeechInput, options: FlowSpeechOperationOptions = {}) {
    return this.operation({ ...options, requestId: options.requestId === undefined ? randomUUID() : options.requestId }, async ctx => {
      const body = JSON.stringify({ input: validateInput(input) })
      if (Buffer.byteLength(body) > 1024 * 1024) fail('Input JSON exceeds 1 MiB', 'invalid_request')
      let response = await this.api('/tts/jobs', ctx, body, 'POST')
      let current = this.job(response.value, ctx)
      while (!['success', 'failed', 'cancelled'].includes(current.status)) {
        await wait(response.retryAfter, ctx.signal)
        response = await this.api('/tts/jobs/' + ctx.jobId, ctx)
        current = this.job(response.value, ctx)
      }
      const audio = await this.audio(current, ctx)
      return { audio, job: current, requestId: ctx.requestId!, requestBody: body, headers: response.headers }
    })
  }

  private async audio(current: FlowSpeechJob, ctx: Context): Promise<Uint8Array> {
    if (current.status === 'failed' || current.status === 'cancelled') {
      throw new FlowSpeechError('FlowSpeech job ' + current.status, this.clean(current.error?.code) ?? ('job_' + current.status))
    }
    if (current.status !== 'success') fail('Job is not ready for download', 'job_not_ready')
    if (current.resultDeleted) fail('FlowSpeech result was deleted; no audio is available', 'result_deleted')
    if (!current.result) fail('Missing result')
    return await this.request(audioUrl(current.result.url), { method: 'GET' }, ctx, true) as Uint8Array
  }

  async getJob(id: string, options: FlowSpeechOperationOptions = {}): Promise<FlowSpeechJob> {
    return this.operation(options, async ctx => this.job((await this.api('/tts/jobs/' + ctx.jobId, ctx)).value, ctx), id)
  }
  async findJob(requestId: string, options: Omit<FlowSpeechOperationOptions, 'requestId'> = {}): Promise<FlowSpeechJob> {
    return this.operation({ ...options, requestId }, async ctx => this.job((await this.api('/tts/jobs?requestId=' + ctx.requestId, ctx)).value, ctx))
  }
  async cancelJob(id: string, options: FlowSpeechOperationOptions = {}): Promise<FlowSpeechJob> {
    return this.operation(options, async ctx => this.job((await this.api('/tts/jobs/' + ctx.jobId + '/cancel', ctx, undefined, 'POST')).value, ctx), id)
  }
  /** Retries only the download of an existing successful job, never generation. */
  async downloadJob(current: FlowSpeechJob, options: FlowSpeechOperationOptions = {}): Promise<Uint8Array> {
    return this.operation({ ...options, requestId: options.requestId ?? current.requestId }, async ctx => this.audio(this.job(current, ctx), ctx), current.id)
  }
  async getQuota(options: FlowSpeechOperationOptions = {}): Promise<FlowSpeechQuota> {
    return this.operation(options, async ctx => {
      const { value } = await this.api('/quota', ctx)
      if (!record(value) || !record(value.quota) || !record(value.limits) ||
        !['remaining', 'reserved', 'available'].every(k => number((value.quota as Record<string, unknown>)[k]))) fail('Malformed quota response')
      for (const field of ['entitlement', 'subscription']) {
        if (value[field] !== undefined && value[field] !== null && !record(value[field])) fail('Malformed subscription entitlement')
      }
      return value as unknown as FlowSpeechQuota
    })
  }
  async listVoices(options: FlowSpeechOperationOptions = {}): Promise<FlowSpeechVoice[]> {
    return this.operation(options, async ctx => {
      const { value } = await this.api('/voices', ctx)
      if (!record(value) || !Array.isArray(value.voices) || !value.voices.every(v =>
        record(v) && typeof v.name === 'string' && v.name.trim() && typeof v.description === 'string' && typeof v.gender === 'string')) fail('Malformed voices response')
      return value.voices as FlowSpeechVoice[]
    })
  }
}

