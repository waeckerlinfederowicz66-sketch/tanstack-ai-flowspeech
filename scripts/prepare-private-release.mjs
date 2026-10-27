import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERIFIED_NPM = '10.9.8';
const packages = new Set(['mcp-flowspeech-server', 'tanstack-ai-flowspeech', 'openclaw-flowspeech']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const privatePath = /(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|(?:^|[\s"'=({])[A-Za-z]:[\\/])/;
const secret = /(?:fs_live_[A-Za-z0-9_-]{43}|sk-[A-Za-z0-9]{32}|npm_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function checkUrlCredentials(value) {
  if (typeof value !== 'string') return;
  const normalized = value.replace(/^git\+/i, '');
  let url;
  try { url = new URL(normalized); } catch { return; }
  // The conventional SSH Git user is a transport identity, not a password.
  const sshGitUser = url.protocol === 'ssh:' && url.username === 'git' && !url.password;
  assert.ok((!url.username && !url.password) || sshGitUser, 'Embedded URL credentials are forbidden');
  for (const key of url.searchParams.keys()) {
    assert.ok(!/^(?:access[_-]?token|api[_-]?key|token|password|authorization)$/i.test(key),
      'Credential-bearing URL query is forbidden');
  }
}

// Reject rather than silently remove fields that would change reviewed metadata.
function checkPrivateMetadata(value, location = 'manifest') {
  if (Array.isArray(value)) return value.forEach((item, index) => checkPrivateMetadata(item, location + '[' + index + ']'));
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!['_resolved', '_from', '_where', '_integrity'].includes(key),
        'Disallowed npm provenance field at ' + location + '.' + key);
      checkPrivateMetadata(item, location + '.' + key);
    }
  } else if (typeof value === 'string') {
    checkUrlCredentials(value);
    assert.ok(!privatePath.test(value) && !/^(?:\/|file:)/i.test(value),
      'Absolute/local path at ' + location);
    assert.ok(!secret.test(value), 'Potential credential at ' + location);
  }
}

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function checkPackageDependencies(manifest, packageArg) {
  if (!manifest || typeof manifest !== 'object') return;
  if (![...dependencyFields, 'overrides'].some(field => Object.hasOwn(manifest, field))) return;
  assert.equal(typeof packageArg?.resolve, 'function', 'Pinned npm dependency parser is required');
  const reject = () => assert.fail('Local or unsupported dependency specification');
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const checkParsed = parsed => {
    if (parsed.type === 'alias') return checkParsed(parsed.subSpec);
    if (['version', 'range', 'tag'].includes(parsed.type)) return;
    if (parsed.type === 'git' && parsed.hosted) {
      assert.ok(!parsed.hosted.auth, 'Embedded URL credentials are forbidden');
      checkUrlCredentials(parsed.fetchSpec);
      return;
    }
    if (['git', 'remote'].includes(parsed.type)) {
      let url;
      try { url = new URL(parsed.fetchSpec); } catch { reject(); }
      checkUrlCredentials(url.href);
      if (url.hostname && ['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return;
    }
    reject();
  };
  const checkSpec = (name, value) => {
    if (typeof value !== 'string') reject();
    let parsed;
    try { parsed = packageArg.resolve(name, value); } catch { reject(); }
    checkParsed(parsed);
  };
  const dependencies = new Map();
  for (const field of dependencyFields) {
    if (!Object.hasOwn(manifest, field)) continue;
    if (!object(manifest[field])) reject();
    for (const [name, spec] of Object.entries(manifest[field])) {
      checkSpec(name, spec);
      dependencies.set(name, spec);
    }
  }
  const checkOverride = (value, name) => {
    if (typeof value === 'string') {
      if (value.startsWith('$')) {
        const reference = value.slice(1);
        if (!dependencies.has(reference)) reject();
        return checkSpec(reference, dependencies.get(reference));
      }
      return checkSpec(name, value);
    }
    if (!object(value)) reject();
    for (const [selector, spec] of Object.entries(value)) {
      if (selector === '.') {
        if (!name) reject();
        checkOverride(spec, name);
        continue;
      }
      let parsed;
      try { parsed = packageArg(selector); } catch { reject(); }
      if (!parsed.name || !['version', 'range', 'tag'].includes(parsed.type)) reject();
      checkOverride(spec, parsed.name);
    }
  };
  if (Object.hasOwn(manifest, 'overrides')) {
    if (!object(manifest.overrides)) reject();
    checkOverride(manifest.overrides);
  }
}

export function checkMetadata(value, tools) {
  checkPrivateMetadata(value);
  checkPackageDependencies(value, tools?.packageArg);
  // Registry version documents contain manifests; entrypoint maps do not.
  if (value?.versions && typeof value.versions === 'object') {
    for (const manifest of Object.values(value.versions)) checkPackageDependencies(manifest, tools?.packageArg);
  }
}

export function npmTools(cli) {
  assert.ok(cli, 'Supply --npm-cli for the verified local npm installation');
  const filename = realpathSync(cli);
  const root = path.resolve(path.dirname(filename), '..');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'npm', 'Expected an npm CLI installation');
  assert.equal(manifest.version, VERIFIED_NPM, 'Unverified npm version; rerun the offline metadata review before upgrading');
  const require = createRequire(path.join(root, 'package.json'));
  return { require, tar: require('tar'), packageArg: require('npm-package-arg'),
    packageJson: require('@npmcli/package-json'), pack: require('libnpmpack') };
}

export async function archiveFiles(filename, tools) {
  const { tar } = tools;
  assert.ok(lstatSync(filename).isFile(), 'Archive must be a regular file, not a symlink');
  assert.ok(lstatSync(filename).size <= 20 * 1024 * 1024, 'Archive exceeds the local audit limit');
  const files = new Map();
  const modes = new Map();
  const seen = new Set();
  let total = 0;
  let failure;
  await tar.t({ file: filename, strict: true, onReadEntry(entry) {
    if (failure) { entry.resume(); return; }
    try {
    const name = entry.path;
    assert.ok(!seen.has(name), 'Duplicate archive member');
    seen.add(name);
    assert.ok(seen.size <= 100, 'Too many archive members');
    if (entry.type === 'Directory') {
      assert.ok(/^package(?:\/dist)?\/?$/.test(name), 'Unexpected archive directory');
      return;
    }
    assert.equal(entry.type, 'File', 'Links and special files are forbidden');
    assert.equal(entry.mode & 0o7000, 0, 'Special permission bits are forbidden');
    modes.set(name.slice(8), entry.mode & 0o777);
    assert.ok(/^package\/(?:package\.json|README\.md|CHANGELOG\.md|LICENSE|SKILL\.md|openclaw\.plugin\.json|dist\/[\w-]+(?:\.d)?\.(?:js|ts)(?:\.map)?)$/.test(name),
      'Unexpected archive member');
    total += entry.size;
    assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && total <= 20 * 1024 * 1024,
      'Unpacked archive exceeds the local audit limit');
    const chunks = [];
    entry.on('data', chunk => chunks.push(chunk));
    entry.on('end', () => files.set(name.slice(8), Buffer.concat(chunks)));
    } catch (error) {
      failure = error;
      entry.resume();
    }
  } });
  if (failure) throw failure;
  const manifest = JSON.parse(files.get('package.json')?.toString() ?? 'null');
  assert.ok(manifest && packages.has(manifest.name), 'Unexpected package identity');
  for (const required of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/index.js', 'dist/index.d.ts']) {
    assert.ok(files.has(required), 'Missing required package member: ' + required);
  }
  for (const [name, bytes] of files) {
    assert.ok(name !== 'SKILL.md' || manifest.name === 'mcp-flowspeech-server', 'Unexpected SKILL.md');
    assert.ok(name !== 'openclaw.plugin.json' || manifest.name === 'openclaw-flowspeech', 'Unexpected plugin manifest');
    assert.ok(!privatePath.test(bytes.toString()) && !secret.test(bytes.toString()),
      'Private path or credential pattern in ' + name);
  }
  checkMetadata(manifest, tools);
  return { files, modes, manifest };
}

// Exercise npm's real metadata assembler with its sole HTTP dependency replaced.
// This function never sends a request, reads npm credentials, or calls npm publish.
export async function registryPayload(manifest, tarball, tools) {
  checkMetadata(manifest, tools);
  const require = tools.require;
  const fetchId = require.resolve('npm-registry-fetch');
  const publishId = require.resolve('libnpmpublish/lib/publish.js');
  require(fetchId);
  const savedFetch = require.cache[fetchId].exports;
  const savedPublish = require.cache[publishId];
  let payload;
  let calls = 0;
  const capture = async (name, options) => {
    assert.equal(name, manifest.name);
    assert.equal(options.method, 'PUT');
    assert.equal(options.registry, 'https://registry.example.invalid/');
    payload = options.body;
    calls++;
    return {};
  };
  capture.pickRegistry = () => 'https://registry.example.invalid/';
  require.cache[fetchId].exports = capture;
  delete require.cache[publishId];
  try {
    await require(publishId)(manifest, tarball, {
      registry: 'https://registry.example.invalid/', npmVersion: VERIFIED_NPM,
      access: 'public', provenance: false, defaultTag: 'latest',
    });
  } finally {
    require.cache[fetchId].exports = savedFetch;
    delete require.cache[publishId];
    if (savedPublish) require.cache[publishId] = savedPublish;
  }
  assert.equal(calls, 1, 'Expected one intercepted metadata assembly');
  const attachment = Object.values(payload._attachments);
  assert.equal(attachment.length, 1);
  assert.deepEqual(Buffer.from(attachment[0].data, 'base64'), Buffer.from(tarball));
  const { _attachments, ...metadata } = payload;
  checkMetadata(metadata, tools);
  return metadata;
}

export async function prepareRelease({ archive, expectedSha256, destination, npmCli }) {
  assert.match(expectedSha256 ?? '', /^[a-f0-9]{64}$/, 'Supply the independently reviewed archive SHA-256');
  const bytes = readFileSync(archive);
  assert.equal(sha256(bytes), expectedSha256, 'Reviewed archive hash mismatch');
  const tools = npmTools(npmCli);
  const { files, modes, manifest } = await archiveFiles(archive, tools);
  const parent = path.resolve('.release-stage');
  const target = path.resolve(destination ?? path.join(parent, 'candidate'));
  assert.ok(target.startsWith(parent + path.sep) && target !== parent, 'Destination must be inside .release-stage');
  assert.ok(!existsSync(parent) || !lstatSync(parent).isSymbolicLink(), 'Stage root must not be a symlink');
  assert.equal(path.dirname(target), parent, 'Use a direct child of .release-stage');
  await mkdir(parent, { recursive: true });
  await mkdir(target); // Never overwrite a prior candidate.
  try {
    const pkg = path.join(target, 'package');
    await mkdir(pkg);
    // Only the audited regular members are written; no checkout, cache or npmrc is copied.
    for (const [name, content] of files) {
      await mkdir(path.dirname(path.join(pkg, name)), { recursive: true });
      await writeFile(path.join(pkg, name), content, { flag: 'wx', mode: modes.get(name) });
    }
    const { content: directoryManifest } = await (await tools.packageJson.fix(pkg)).prepare();
    checkMetadata(directoryManifest, tools);
    const packed = await tools.pack(pkg, {
      ignoreScripts: true, offline: true, dryRun: true, cache: path.join(target, 'cache'),
    });
    const repacked = path.join(target, 'candidate.tgz');
    await writeFile(repacked, packed, { flag: 'wx' });
    const inspected = await archiveFiles(repacked, tools);
    assert.deepEqual([...inspected.files.keys()].sort(), [...files.keys()].sort(), 'Directory packing changed the member list');
    for (const [name, original] of files) {
      assert.deepEqual(inspected.files.get(name), original, 'Directory packing changed reviewed content: ' + name);
      assert.deepEqual(readFileSync(path.join(pkg, name)), original, 'Directory manifest preparation modified: ' + name);
    }
    const metadata = await registryPayload(directoryManifest, packed, tools);
    const report = {
      package: manifest.name, version: manifest.version, npmVersion: VERIFIED_NPM,
      inputSha256: expectedSha256, directoryPackSha256: sha256(packed), members: files.size,
      reviewedMembersUnchanged: true, metadataSha256: sha256(JSON.stringify(metadata)),
      privatePathFields: 0, dependencySpecsVerified: true,
      registryPayloadVerifiedOffline: true, networkRequests: 0,
      publishPerformed: false, existingRegistryMetadataChanged: false,
      publishSource: 'package directory, never the input .tgz',
    };
    await writeFile(path.join(target, 'privacy-audit.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    return report;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length % 2, 0, 'Expected option/value pairs');
    const options = {};
    const names = { '--archive': 'archive', '--sha256': 'expectedSha256', '--destination': 'destination', '--npm-cli': 'npmCli' };
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(names[args[i]] && options[names[args[i]]] === undefined, 'Unknown or duplicate option');
      options[names[args[i]]] = args[i + 1];
    }
    console.log(JSON.stringify(await prepareRelease(options), null, 2));
  } catch (error) {
    // Do not print raw filesystem/library error details or a local path.
    console.error('Release privacy preparation failed; no publication was attempted. ' +
      (error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Check local inputs and pinned npm installation.'));
    process.exitCode = 1;
  }
}
