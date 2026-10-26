# TanStack AI FlowSpeech Adapter

A server-side FlowSpeech public API v1 adapter for TanStack AI's `generateSpeech` activity. The adapter waits for the asynchronous job and downloads WAV audio, then encodes those bytes locally as base64 to preserve TanStack's `TTSResult`. The v1 API itself does not return base64.

## Local installation

Requires Node.js 22 or newer and `@tanstack/ai ^0.45.1`.

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm run test:dist
npm pack
# From your application:
npm install @tanstack/ai /path/to/tanstack-ai-flowspeech-0.2.0.tgz
```

Set `FLOWSPEECH_API_KEY` in the server environment, or pass `apiKey` to the adapter. Never use browser code for API credentials.

## Generate speech

```ts
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { generateSpeech } from '@tanstack/ai'
import { flowspeechSpeech, FlowSpeechClient } from 'tanstack-ai-flowspeech'

const requestId = randomUUID() // Persist this before submission.
const adapter = flowspeechSpeech('flowspeech-tts', { timeout: 600_000 })
const result = await generateSpeech({
  adapter,
  text: 'Here is the product update.',
  voice: 'Kore',
  format: 'wav',
  modelOptions: { requestId },
})
await writeFile('speech.wav', Buffer.from(result.audio, 'base64'))
console.log(result.id) // The actual FlowSpeech job ID.
```

Calling `adapter.generateSpeech` directly returns the extended `FlowSpeechTTSResult` with `requestId`, `jobId` and `creditUsage`. The framework's activity exposes its standard result type. A framework cancellation may surface as `AbortError` rather than the adapter's structured error, so persist the request UUID before starting.

## Multiple speakers

Legacy two-voice scripts remain supported by translating labeled turns into v1 segments. Labels must be `Speaker1:` or `Speaker2:` and separated by whitespace:

```ts
await generateSpeech({
  adapter,
  text: 'Speaker1: Welcome. Speaker2: Thank you.',
  modelOptions: { speakerB: 'Puck', requestId: randomUUID() },
})
```

Explicit segments are preferred for unambiguous multi-speaker scripts. Set `text: ''` and do not combine them with `speakerB`:

```ts
await generateSpeech({
  adapter,
  text: '',
  modelOptions: {
    requestId: randomUUID(),
    segments: [
      { speaker: 'Alice', text: 'Welcome.', voiceName: 'Kore' },
      { speaker: 'Bob', text: 'Thank you.', voiceName: 'Puck' },
    ],
  },
})
```

## Configuration and migration

Only `flowspeech-tts` is supported as a framework model identifier; it is not sent to the API. Numeric `speed`, non-WAV formats and unknown model options are rejected. `voiceName` remains a model-option fallback for the top-level voice.

Configuration accepts `apiKey`, `baseUrl`, `headers`, `fetch`, `timeoutMs` (or its retained `timeout` alias), `requestTimeoutMs`, `pollIntervalMs`, `maxRetries` and `maxAudioBytes`. `baseUrl` is now an HTTPS origin, not an endpoint path. The timeout default is now ten minutes for the entire operation. Headers are API-only; supply authentication through `apiKey` or the environment, not Authorization/Cookie header overrides.

## v1 behavior and recovery

Requires a server-side developer API key and an active paid Basic, Pro or Scale subscription. Trials do not include API generation. Website cookies and plugin login tokens are not API credentials.

The API origin is `https://flowspeech.io`. Calls submit `{ input: ... }` to `POST /api/v1/tts/jobs` with a UUID `Idempotency-Key`, poll the returned job, then download its result. No model or legacy speaker fields are sent. Audio is WAV, 24000 Hz, mono, 16 bit. HTTP 200 from a status query is not generation success.

- Pending states: queued, running, merging, settling. Failed/cancelled jobs throw; a deleted success result throws `result_deleted`.
- Polling defaults to 5000 ms and cannot be configured faster. Longer `Retry-After` values, including HTTP dates and rate limits, take precedence.
- There are at most two transient retries per HTTP operation by default (configurable from zero to five). Submission retries preserve the exact UUID and JSON body.
- The total deadline includes submit, polling, retry waits, response-body reads and download. The general client default is 600000 ms; each request defaults to 30000 ms.
- Downloads use no API headers, Bearer token or cookies. HTTPS URLs with embedded credentials are rejected. API and storage redirects are rejected rather than followed. Downloads are bounded (64 MiB for the general client).
- Custom fetch implementations are trusted application code and must preserve the supplied abort, redirect and credential settings.
- Aborting or timing out stops local work; it does not cancel the server job or reverse a charge. Use `cancelJob` explicitly when cancellation is intended.

Each package exports `FlowSpeechClient` and `FlowSpeechError`. Save a fresh UUID before each new recording and pass it as `requestId`. Reuse it only with unchanged input. Error properties include `code`, `status`, `traceId`, `requestId` and `jobId` when known; do not automatically start a new job after a timeout or download error.

```ts
const client = new FlowSpeechClient({ apiKey: process.env.FLOWSPEECH_API_KEY })
const quota = await client.getQuota()
console.log(quota.quota.available)
const voices = await client.listVoices()

// Use the UUID previously saved for the interrupted recording.
const job = await client.findJob(savedRequestId)
// Or: await client.getJob(savedJobId)
// Poll pending jobs no faster than five seconds, or resume generate() with
// the same UUID and unchanged input; it replays the existing job.
if (job.status === 'success') {
  const bytes = await client.downloadJob(job) // never creates a recording
}
// await client.cancelJob(job.id)
```

The quota response preserves canonical top-level `quota`, `subscription` and `limits`. An optional `entitlement` field is also retained for compatibility; it is not required. Result links grant public link access and should not be logged or shared unnecessarily. Deleting a result does not necessarily invalidate a previously copied link.

Downloads validate the actual RIFF/WAVE container, chunk lengths and padding,
PCM format (24000 Hz, mono, 16 bit), byte rate/block alignment, and complete
nonempty aligned sample data. Truncated, malformed or mismatched audio is
rejected even on HTTP 200. Bounded unknown chunks are skipped safely and valid
files are returned byte-for-byte unchanged. Validation remains within the
operation deadline; an invalid download never triggers another submission.

Full API contract: [FlowSpeech public API](https://flowspeech.io/docs/public-api).

## Development and release status

These are local 0.2.0 release candidates. The npm-name audit on 2026-10-26 returned 404; do not assume an earlier npm release exists or claim this version is published. The GitHub repository exists independently of npm availability. Publication is a separate maintainer/coordinator action.

Install locked dependencies, then run the package checks and pack locally. Tests use only fake transports and synthetic WAV data; they do not spend generation credits. See `RELEASE_CHECKLIST.md` for maintainer release steps.

## License

MIT
