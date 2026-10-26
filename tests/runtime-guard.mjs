import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
function check(version) {
  const code = "Object.defineProperty(process.versions, 'node', {value: " + JSON.stringify(version) +
    "}); await import('./scripts/check-runtime.mjs')"
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' })
}

test('actual selected runtime passes the guard', () => {
  const result = spawnSync(process.execPath, ['scripts/check-runtime.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})
test('both pinned CI versions are accepted', () => {
  for (const version of ['22.23.2', '24.19.0']) {
    const result = check(version)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(version))
  }
})
test('Node 20 fails with an actionable message before loading host dependencies', () => {
  const result = check('20.20.0')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Node 20 is unsupported/)
  assert.match(result.stderr, /PATH/)
  assert.doesNotMatch(result.stderr, /markAsUncloneable/)
})
test('runtime boundaries follow the package and OpenClaw host requirements', () => {
  const cases = pkg.name === 'openclaw-flowspeech'
    ? [['22.22.2', false], ['22.22.3', true], ['23.0.0', false], ['24.14.0', false],
       ['24.15.0', true], ['25.8.0', false], ['25.9.0', true], ['26.0.0', true]]
    : [['21.9.0', false], ['22.0.0', true], ['23.0.0', true], ['24.0.0', true]]
  for (const [version, supported] of [...cases, ['invalid', false]]) {
    assert.equal(check(version).status, supported ? 0 : 1, version)
  }
})
