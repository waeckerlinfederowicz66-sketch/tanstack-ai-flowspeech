# TanStack AI FlowSpeech Adapter

Use [FlowSpeech](https://flowspeech.io/) text-to-speech with TanStack AI's standard `generateSpeech` activity. The adapter supports single-voice narration, two-speaker scripts, request cancellation, custom endpoints, and server runtimes with a custom `fetch` implementation.

## Install

```bash
npm install @tanstack/ai tanstack-ai-flowspeech
```

## Basic usage

```ts
import { generateSpeech } from '@tanstack/ai'
import { flowspeechSpeech } from 'tanstack-ai-flowspeech'

const result = await generateSpeech({
  adapter: flowspeechSpeech('flowspeech-tts'),
  text: 'A clear voice can make product documentation easier to follow.',
  voice: 'Kore',
})

console.log(result.audio) // base64 audio
console.log(result.contentType)
```

## Two-speaker scripts

Label the script with `Speaker1` and `Speaker2`, then select the second voice through `modelOptions`.

```ts
const result = await generateSpeech({
  adapter: flowspeechSpeech('flowspeech-tts'),
  text: 'Speaker1: Welcome. Speaker2: Thanks for having me.',
  voice: 'Kore',
  modelOptions: {
    speakerB: 'Puck',
  },
})
```

## Adapter configuration

```ts
const adapter = flowspeechSpeech('flowspeech-tts', {
  timeout: 45_000,
  headers: {
    'X-Request-Source': 'my-app',
  },
})
```

Options:

- `baseUrl`: Override the TTS endpoint.
- `headers`: Add request headers.
- `timeout`: Set the request timeout in milliseconds. The default is 60 seconds.
- `fetch`: Supply a custom Fetch API implementation.

Per-request `modelOptions`:

- `voiceName`: Fallback voice when the top-level `voice` option is omitted.
- `speakerB`: Enable two-speaker synthesis with the specified second voice.

## Development

```bash
npm install
npm test
npm run build
```

## License

MIT
