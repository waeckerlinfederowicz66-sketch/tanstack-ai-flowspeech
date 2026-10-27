# Unreleased npm Publication Privacy Guard

The URL-credential follow-up also rejects embedded URL usernames/passwords
(except the conventional password-free SSH Git user), credential-bearing
query fields and parsed hosted-Git authentication. This includes dependency
fields, nested overrides and repository/homepage metadata. Public Git,
password-free SSH, registry aliases and relative dist entrypoints remain valid.
Package files are limited to root-level compiled dist modules and declared
public documents; historical post-release reports are not package contents.
This guard does not remove metadata from versions already published.

This is a local preparation/check workflow, not a publication or a repair of
already published 0.2.0 metadata. Previously retained registry responses contain
a private absolute path in `_resolved`; their original evidence is unchanged.
A maintainer must separately decide whether/how npm can correct those existing
records. Do not overwrite 0.2.0 or describe it as repaired.

## Why the Input Type Matters

The reviewed npm 10.9.8 implementation uses different manifest paths:
`lib/commands/publish.js` prepares a directory with `@npmcli/package-json`, but
loads a tarball with `pacote.manifest`. The latter adds `_resolved`/`_from`.
`libnpmpublish` retains those fields in the registry version document. A clean
tarball alone therefore does not prove clean public registry metadata.

The guard pins npm 10.9.8 and fails on another version. It requires an independently
reviewed tarball SHA-256, reads only allowlisted regular members, rejects private
paths/credentials/internal npm fields, and stages them under a new ignored
`.release-stage/` directory. It never copies node_modules, npmrc, post-release
diagnostics, credentials or arbitrary checkout files. Existing stages are not
overwritten.

Dependency collections and nested npm overrides are checked separately with
the pinned npm installation's `npm-package-arg` parser. Local directory/file
specifications, unsupported link/workspace protocols, local aliases and local
override selectors/references are rejected before staging or reporting success.
Registry versions, ranges, tags and npm aliases remain valid. Package-relative
`main`, `types`, `bin` and `exports` entrypoints are not dependency specifications
and remain allowed. Parser diagnostics never include the rejected value.

It executes the same directory manifest preparation and packing modules with
scripts disabled and offline mode enabled, compares every member byte with the
input, then exercises npm's actual metadata assembler with its sole HTTP
dependency replaced by an in-memory capture. No registry request, login,
credential read, provenance upload or publication occurs. The tests additionally
forbid network socket connections and reproduce the old tarball-metadata leak.

## Local Checks

Use Node 22.23.2 with the verified npm 10.9.8 installation first on PATH. Build
and run the existing source/packed tests before selecting a future release's
reviewed archive. A future version bump remains a separate maintainer decision.

```sh
export FLOWSPEECH_NPM_CLI="$(command -v npm)"
node --test scripts/release-privacy.test.mjs

node scripts/prepare-private-release.mjs \
  --archive "$REVIEWED_ARCHIVE" \
  --sha256 "$REVIEWED_SHA256" \
  --npm-cli "$FLOWSPEECH_NPM_CLI" \
  --destination .release-stage/reviewed
```

For tests against a different reviewed version set `FLOWSPEECH_RELEASE_ARCHIVE`.
The report `privacy-audit.json` records input/repacked hashes, member count,
metadata fingerprint, zero network requests and `publishPerformed=false`.
The staged `candidate.tgz` is for inspection/tests, **not** the publish argument.

Local verification on 2026-10-27: 22 privacy regressions passed; preparation of
the retained 0.2.0 archive reproduced its exact tarball hash and verified a
path-free simulated directory-publish payload. The result is retained under
`.release-stage/privacy-review-dependencies/`; the earlier report is retained
separately under `.release-stage/privacy-review/`. The new report includes
`dependencySpecsVerified=true`. Tests include 48 rejected synthetic manifests
through metadata, registry payload and full preparation, plus successful
registry-dependency/relative-entrypoint controls. No runtime source, existing tarball, registry
evidence or version was changed. This verifies only the pinned local toolchain,
not an actual future registry response.

## Coordinator-Only Future Publication

After selecting a new unpublished version, passing its source/consumer tests,
and reviewing the new stage and its hash, publish the **directory**, with
lifecycle scripts disabled so the verified contents cannot be rebuilt by hooks:

```sh
npm publish ./.release-stage/reviewed/package --ignore-scripts --access public
```

This command is documentation only; the guard never runs it. Do not substitute
the `.tgz` path or publish directly from a checkout containing diagnostics.
Do not edit the stage after validation. Preserve both the reviewed artifact and
report, then separately verify the resulting registry version metadata,
tarball integrity and consumer behavior. Only that subsequent read-back can
establish that a future release was actually published without private paths.
