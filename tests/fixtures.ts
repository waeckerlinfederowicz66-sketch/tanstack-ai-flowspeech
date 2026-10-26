import type { FlowSpeechJob } from '../src/flowspeech-client.js'
export const requestId = '11111111-1111-4111-8111-111111111111'
export const jobId = '22222222-2222-4222-8222-222222222222'
export const input = { mode: 'single', text: 'Hello', voiceName: 'Kore' } as const
export const result = { url: 'https://audio.example.test/test.wav', mimeType: 'audio/wav', sampleRate: 24000, channels: 1, bitsPerSample: 16 } as const
export function job(status: FlowSpeechJob['status'] = 'success', extra: Record<string, unknown> = {}) {
  return { id: jobId, requestId, status, result: status === 'success' ? result : null,
    usage: { billableCharacters: 5, reservedCredits: 0, chargedCredits: status === 'success' ? 5 : 0 }, ...extra }
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
export function wav(): Buffer {
  const data = Buffer.alloc(46)
  data.write('RIFF'); data.writeUInt32LE(38, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28)
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(2, 40)
  return data
}
export function audio() { return new Response(new Uint8Array(wav()), { headers: { 'Content-Type': 'audio/wav' } }) }
