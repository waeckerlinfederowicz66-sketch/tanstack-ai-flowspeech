import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.env.FLOWSPEECH_ARTIFACT_ROOT ?? '.cache/packed/package')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const allowedRoot = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', ...(pkg.name === 'openclaw-flowspeech' ? ['openclaw.plugin.json'] : [])])
const forbiddenContent = [
  /\/Users\/|\/private\/var\/folders\//,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk_|sk-|fs_)[A-Za-z0-9_-]{24,}\b/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /(?:apiKey|FLOWSPEECH_API_KEY|token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/,
  /unit-test-only|11111111-1111-4111-8111-111111111111/,
  /api\/ai\/text-to-speech/,
]
let count = 0
let bytes = 0
function scan(relative = '') {
  for (const name of readdirSync(join(root, relative))) {
    const file = relative ? relative + '/' + name : name
    const stat = lstatSync(join(root, file))
    assert.ok(!stat.isSymbolicLink(), 'Unexpected symlink: ' + file)
    if (stat.isDirectory()) {
      assert.ok(file === 'dist' || file.startsWith('dist/'), 'Unexpected directory: ' + file)
      scan(file)
    } else {
      assert.ok(allowedRoot.has(file) || /^dist\/[\w./-]+\.(?:js|d\.ts)(?:\.map)?$/.test(file), 'Unexpected package file: ' + file)
      assert.ok(!/(?:^|\/)(?:tests?|node_modules|\.env|\.cache)(?:\/|\.|$)/.test(file), 'Excluded file leaked: ' + file)
      const content = readFileSync(join(root, file), 'utf8')
      for (const pattern of forbiddenContent) assert.ok(!pattern.test(content), 'Forbidden content pattern in ' + file)
      count++; bytes += stat.size
    }
  }
}
scan()
assert.equal(pkg.version, '0.2.0')
for (const file of ['dist/index.js', 'dist/index.d.ts', 'CHANGELOG.md']) assert.ok(lstatSync(join(root, file)).isFile())
const tarball = pkg.name + '-' + pkg.version + '.tgz'
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
console.log(JSON.stringify({ package: pkg.name, version: pkg.version, files: count, unpackedBytes: bytes, tarball, sha256, result: 'PASS: allowlist, credential patterns, fixture leakage, absolute paths and retired endpoint checks' }, null, 2))
