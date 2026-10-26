import type { Buffer } from 'node:buffer'
export function pcmFormat(): Buffer
export function wavChunk(tag: string, payload: Uint8Array | number[]): Buffer
export function wavFile(...chunks: Uint8Array[]): Buffer
export function validWav(): Buffer
export function extendedWav(): Buffer
export function invalidWavs(): Array<[string, Buffer]>
