# Changelog

## 0.2.0 - 2026-10-26 (unreleased)

- Validate complete RIFF/WAVE chunks and 24 kHz mono 16-bit PCM data; preserve valid bytes, reject malformed downloads and allow download-only recovery.
- Correct quota documentation to canonical `subscription`, retaining optional `entitlement` compatibility.

- Replace the retired synchronous endpoint with public API v1 submit, poll and credential-free WAV download.
- Preserve the framework's buffered speech result contract and expose recovery request/job IDs.
- Add single/multi input support through the exported client, quota/voices queries, job lookup and explicit cancellation.
- Bound retries, response sizes, per-request timeouts and total deadlines; reuse submission UUID/body on retries.
- Respect five-second polling and longer Retry-After values; report failed/cancelled/deleted/malformed jobs explicitly.
- Reject unsupported legacy generation options, unsafe URLs, API credential overrides and redirects.
- Add fake-transport framework tests and build/packed-artifact smoke tests; no paid generation tests.
- Update server-only credential/subscription documentation and migration guidance.

0.1.0 identifies the original repository code, not a verified npm release. Registry
availability was unverified/404 during the 2026-10-26 audit. Publication of 0.2.0 is
a separate maintainer action.
