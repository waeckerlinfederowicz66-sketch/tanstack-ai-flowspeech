import { Buffer } from 'node:buffer'

export function pcmFormat() {
  const bytes = Buffer.alloc(16)
  bytes.writeUInt16LE(1, 0); bytes.writeUInt16LE(1, 2)
  bytes.writeUInt32LE(24000, 4); bytes.writeUInt32LE(48000, 8)
  bytes.writeUInt16LE(2, 12); bytes.writeUInt16LE(16, 14)
  return bytes
}
export function wavChunk(tag, payload) {
  const bytes = Buffer.alloc(8 + payload.length + (payload.length & 1))
  bytes.write(tag, 0, 'ascii'); bytes.writeUInt32LE(payload.length, 4)
  Buffer.from(payload).copy(bytes, 8)
  return bytes
}
export function wavFile(...chunks) {
  const bytes = Buffer.concat([Buffer.from('RIFF0000WAVE'), ...chunks])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return bytes
}
export function validWav() {
  return wavFile(wavChunk('fmt ', pcmFormat()), wavChunk('data', [0, 0, 1, 0]))
}
export function extendedWav() {
  return wavFile(wavChunk('JUNK', [1, 2, 3]),
    wavChunk('fmt ', Buffer.concat([pcmFormat(), Buffer.alloc(2)])),
    wavChunk('LIST', [7]), wavChunk('data', [0, 0, 1, 0]), wavChunk('JUNK', []))
}
export function invalidWavs() {
  const f = wavChunk('fmt ', pcmFormat()), d = wavChunk('data', [0, 0, 1, 0])
  const bad = {
    empty: Buffer.alloc(0), html: Buffer.from('<html>not audio</html>'),
    'magic only': wavFile(Buffer.alloc(32)),
    'missing format': wavFile(d), 'missing data': wavFile(f),
    'empty data': wavFile(f, wavChunk('data', [])),
    'odd data': wavFile(f, wavChunk('data', [1, 2, 3])),
    'data before format': wavFile(d, f),
    'duplicate format': wavFile(f, f, d), 'duplicate data': wavFile(f, d, d),
    'short format': wavFile(wavChunk('fmt ', pcmFormat().subarray(0, 15)), d),
    'invalid extension': wavFile(wavChunk('fmt ', Buffer.concat([pcmFormat(), Buffer.from([1, 0])])), d),
    'partial chunk header': wavFile(f, d, Buffer.from('ABC')),
    'chunk overflow': wavFile(f, d, Buffer.from([74, 85, 78, 75, 255, 255, 255, 255])),
    'missing padding': wavFile(f, d, Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 42])),
  }
  for (const [name, offset, value, width] of [
    ['float', 0, 3, 2], ['stereo', 2, 2, 2], ['sample rate', 4, 44100, 4],
    ['byte rate', 8, 96000, 4], ['block alignment', 12, 4, 2], ['bit depth', 14, 8, 2],
  ]) {
    const format = pcmFormat()
    if (width === 2) format.writeUInt16LE(value, offset)
    else format.writeUInt32LE(value, offset)
    bad[name] = wavFile(wavChunk('fmt ', format), d)
  }
  for (const name of ['riff length too big', 'riff length too small', 'wrong RIFF', 'wrong WAVE', 'trailing bytes', 'data length too big']) {
    let bytes = validWav()
    switch (name) {
      case 'riff length too big': bytes.writeUInt32LE(4096, 4); break
      case 'riff length too small': bytes.writeUInt32LE(4, 4); break
      case 'wrong RIFF': bytes.write('RIFX'); break
      case 'wrong WAVE': bytes.write('HTML', 8); break
      case 'trailing bytes': bytes = Buffer.concat([bytes, Buffer.alloc(1)]); break
      case 'data length too big': bytes.writeUInt32LE(6, 40); break
    }
    bad[name] = bytes
  }
  return Object.entries(bad)
}
