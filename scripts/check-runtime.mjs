import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = process.versions.node
const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(version)?.slice(1).map(Number)
const [major, minor, patch] = parts ?? []
const openclaw = pkg.name === 'openclaw-flowspeech'
const supported = parts && (openclaw
  ? (major === 22 && (minor > 22 || (minor === 22 && patch >= 3))) ||
    (major === 24 && minor >= 15) || (major === 25 && minor >= 9) || major > 25
  : major >= 22)

if (!supported) {
  const required = openclaw ? '22.22.3+, 24.15+ or 25.9+ in the supported host ranges' : '22 or newer'
  console.error(pkg.name + ' tooling requires Node.js ' + required + '; found ' + version +
    '. Select Node 22.23.2 or 24.19.0 in PATH before invoking npm. Node 20 is unsupported.')
  process.exitCode = 1
} else {
  console.log(pkg.name + ' runtime guard: Node ' + version + ' OK')
}
