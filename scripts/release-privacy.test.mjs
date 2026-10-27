import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { archiveFiles, checkMetadata, npmTools, prepareRelease, registryPayload } from './prepare-private-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const archive = path.resolve(process.env.FLOWSPEECH_RELEASE_ARCHIVE ?? path.join(root, pkg.name + '-' + pkg.version + '.tgz'));
const npmCli = process.env.FLOWSPEECH_NPM_CLI ?? process.env.npm_execpath;
const tools = npmTools(npmCli);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(archive);
const expectedSha256 = digest(bytes);
const fixtureRoot = path.join(root, '.release-stage');
await mkdir(fixtureRoot, { recursive: true });

const connect = net.Socket.prototype.connect;
const fetch = globalThis.fetch;
net.Socket.prototype.connect = function () { throw new Error('Network forbidden in release privacy tests'); };
globalThis.fetch = async () => { throw new Error('Network forbidden in release privacy tests'); };
test.after(() => { net.Socket.prototype.connect = connect; globalThis.fetch = fetch; });

for (const field of ['_resolved', '_from', '_where', '_integrity']) {
  test('rejects npm-injected ' + field + ' rather than deleting evidence', () => {
    const value = { name: pkg.name, version: pkg.version, [field]: '/private/fixture/release.tgz' };
    assert.throws(() => checkMetadata(value, tools), /Disallowed npm provenance field/);
    assert.ok(value[field], 'Validation must not erase the original metadata');
  });
}
for (const value of ['/Users/fixture/package', '/home/fixture/package', '/opt/fixture/package', 'file:../candidate.tgz', 'C:\\fixture\\package']) {
  test('rejects a private/local manifest path form', () => {
    assert.throws(() => checkMetadata({ dependencies: { fixture: value } }, tools), /Absolute\/local path/);
  });
}
test('HTTPS URLs and relative published entrypoints are not mistaken for filesystem paths', () => {
  checkMetadata({ repository: 'https://github.com/example/package.git', main: './dist/index.js' }, tools);
});

test('reproduces tarball metadata leakage and blocks its offline registry payload', async () => {
  const manifest = await tools.require('pacote').manifest(archive, {
    offline: true, fullmetadata: true, fullReadJson: true, cache: path.join(fixtureRoot, 'cache'),
  });
  assert.equal(typeof manifest._resolved, 'string');
  assert.ok(path.isAbsolute(manifest._resolved));
  await assert.rejects(registryPayload(manifest, bytes, tools), /Disallowed npm provenance field/);
});

test('stages exact reviewed bytes, assembles path-free directory metadata and never overwrites a candidate', async () => {
  const target = path.join(fixtureRoot, 'success-' + process.pid);
  try {
    const result = await prepareRelease({ archive, expectedSha256, destination: target, npmCli });
    assert.equal(result.inputSha256, expectedSha256);
    assert.equal(result.directoryPackSha256, expectedSha256);
    assert.equal(result.networkRequests, 0);
    assert.equal(result.publishPerformed, false);
    assert.equal(result.existingRegistryMetadataChanged, false);
    const before = await archiveFiles(archive, tools);
    const after = await archiveFiles(path.join(target, 'candidate.tgz'), tools);
    assert.deepEqual(after.files, before.files);
    assert.deepEqual(await readFile(archive), bytes);
    await assert.rejects(prepareRelease({ archive, expectedSha256, destination: target, npmCli }));
    assert.ok(existsSync(path.join(target, 'privacy-audit.json')), 'Prior evidence must survive a collision');
  } finally { await rm(target, { recursive: true, force: true }); }
});

test('fails closed on a wrong digest or unverified npm toolchain', async () => {
  await assert.rejects(prepareRelease({ archive, expectedSha256: '0'.repeat(64), npmCli }), /hash mismatch/);
  const tmp = await mkdtemp(path.join(fixtureRoot, 'npm-fixture-'));
  try {
    await mkdir(path.join(tmp, 'bin'));
    await writeFile(path.join(tmp, 'bin/npm-cli.js'), '');
    await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'npm', version: '99.0.0' }));
    assert.throws(() => npmTools(path.join(tmp, 'bin/npm-cli.js')), /Unverified npm version/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('rejects diagnostics, local metadata and links in the candidate archive', async () => {
  const tmp = await mkdtemp(path.join(fixtureRoot, 'archive-fixture-'));
  try {
    await tools.tar.x({ file: archive, cwd: tmp });
    const filename = path.join(tmp, 'bad.tgz');
    const packageRoot = path.join(tmp, 'package');
    await mkdir(path.join(packageRoot, 'dist/post-release'));
    await writeFile(path.join(packageRoot, 'dist/post-release/registry.json'), '{}');
    await tools.tar.c({ gzip: true, portable: true, file: filename, cwd: tmp }, ['package']);
    await assert.rejects(archiveFiles(filename, tools));
    await rm(path.join(packageRoot, 'dist/post-release'), { recursive: true });
    await symlink('index.js', path.join(packageRoot, 'dist/link.js'));
    await tools.tar.c({ gzip: true, portable: true, file: filename, cwd: tmp }, ['package']);
    await assert.rejects(archiveFiles(filename, tools));
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

async function withManifest(changes, run) {
  const tmp = await mkdtemp(path.join(fixtureRoot, 'dependency-fixture-'));
  const destination = tmp + '-stage';
  try {
    await tools.tar.x({ file: archive, cwd: tmp });
    const filename = path.join(tmp, 'candidate.tgz');
    const manifestFile = path.join(tmp, 'package/package.json');
    const manifest = { ...JSON.parse(await readFile(manifestFile, 'utf8')), ...changes };
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    await tools.tar.c({ gzip: true, portable: true, file: filename, cwd: tmp }, ['package']);
    await run({ archive: filename, expectedSha256: digest(await readFile(filename)), destination, npmCli }, manifest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
}

async function rejectsManifest(changes) {
  await withManifest(changes, async (options, manifest) => {
    assert.throws(() => checkMetadata(manifest, tools));
    await assert.rejects(registryPayload(manifest, bytes, tools));
    await assert.rejects(prepareRelease(options));
    assert.ok(!existsSync(options.destination), 'Rejected dependency must never receive a clean audit report');
  });
}

const localSpecs = ['../private-project', './private-project', '~/private-project',
  'link:../private-project', 'workspace:*', 'file:../private-project', 'git+file:///opt/private-project'];
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  test('rejects parsed local specs in ' + field + ' before metadata or a full preparation report', async () => {
    for (const spec of localSpecs) await rejectsManifest({ [field]: { fixture: spec } });
  });
}

test('rejects local aliases without echoing parser errors or dependency paths', async () => {
  for (const spec of ['npm:fixture@file:../private-project', 'npm:fixture@link:../private-project', 'npm:fixture@workspace:*']) {
    assert.throws(() => checkMetadata({ dependencies: { fixture: spec } }, tools), error =>
      error.message === 'Local or unsupported dependency specification' && !error.message.includes(spec));
    await rejectsManifest({ dependencies: { fixture: spec } });
  }
});

test('checks nested overrides, package selectors and dependency references structurally', async () => {
  for (const spec of localSpecs) {
    await rejectsManifest({ overrides: { fixture: spec } });
    await rejectsManifest({ overrides: { 'parent@^1': { fixture: { '.': spec } } } });
  }
  await rejectsManifest({ overrides: { 'fixture@file:../private-project': { other: '^1' } } });
  await rejectsManifest({ dependencies: { fixture: '../private-project' }, overrides: { fixture: '$fixture' } });
  await rejectsManifest({ overrides: { fixture: '$missing' } });
});

test('accepts registry versions, ranges, tags, aliases and relative published entrypoints end to end', async () => {
  const manifest = {
    main: './dist/index.js', types: './dist/index.d.ts', bin: { fixture: './dist/index.js' },
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { fixture: '^1.2.3', exact: '1.2.3', tagged: 'latest', alias: 'npm:other@^2' },
    devDependencies: { scoped: 'npm:@example/package@next' },
    optionalDependencies: { optional: '~1.0.0' }, peerDependencies: { peer: '>=1 <3' },
    overrides: { fixture: '$fixture', 'parent@^1': { '.': '1.2.3', alias: 'npm:other@^2' } },
  };
  checkMetadata(manifest, tools);
  await withManifest(manifest, async (options, candidate) => {
    const payload = await registryPayload(candidate, bytes, tools);
    assert.equal(payload.versions[candidate.version].dependencies.alias, 'npm:other@^2');
    const report = await prepareRelease(options);
    assert.equal(report.dependencySpecsVerified, true);
    assert.equal(report.networkRequests, 0);
    assert.equal(report.privatePathFields, 0);
    const after = await archiveFiles(path.join(options.destination, 'candidate.tgz'), tools);
    assert.deepEqual(after.manifest.exports, manifest.exports);
    assert.deepEqual(after.manifest.bin, manifest.bin);
  });
});

test('fails closed without the pinned parser and rejects malformed dependency collections', () => {
  assert.throws(() => checkMetadata({ dependencies: { fixture: '^1' } }), /Pinned npm dependency parser/);
  for (const value of [null, [], 'fixture', { fixture: null }]) {
    assert.throws(() => checkMetadata({ dependencies: value }, tools));
  }
});

test('rejects credential-bearing URL metadata end to end without echoing credentials', async () => {
  const canary = 'review-credential-canary-only';
  for (const spec of [
    'git+https://review-user:' + canary + '@github.com/example/package.git',
    'https://review-user:' + canary + '@example.test/package.tgz',
    'git+https://' + canary + '@github.com/example/package.git',
    'git+ssh://git:' + canary + '@example.test/package.git',
    'https://example.test/package.tgz?access_token=' + canary,
  ]) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      await rejectsManifest({ [field]: { fixture: spec } });
    }
    await rejectsManifest({ overrides: { 'parent@^1': { fixture: spec } } });
    await rejectsManifest({ repository: { type: 'git', url: spec } });
    await rejectsManifest({ homepage: spec });
    assert.throws(() => checkMetadata({ dependencies: { fixture: spec } }, tools), error =>
      !error.message.includes(canary) && !error.message.includes('review-user'));
  }
});

test('public Git, conventional SSH and tarball dependencies remain supported', async () => {
  const dependencies = {
    publicgit: 'git+https://github.com/example/package.git',
    shortcut: 'github:example/package',
    ssh: 'git+ssh://git@github.com/example/package.git',
    archive: 'https://example.test/package.tgz',
  };
  await withManifest({ dependencies }, async (options, candidate) => {
    const report = await prepareRelease(options);
    assert.equal(report.networkRequests, 0);
    assert.deepEqual((await registryPayload(candidate, bytes, tools)).versions[candidate.version].dependencies, dependencies);
  });
});
