# Experimental security boundary

This release preparation does not deploy the new service-credential scheme.
The maintainer has confirmed acceptance of the existing live task route; that is
not a claim that this new credential scheme was deployed during release work.
Public redistribution still needs the notice review in LICENSE-STATUS.md and
THIRD_PARTY.md. No account credential is included.

Default listening is local only (127.0.0.1). Do not expose either service to the
LAN or public Internet: no 0.0.0.0 bind, port forwarding, tunnels or unauthenticated
reverse proxies. Missing credentials must fail closed; do not remove checks to
make an unconfigured copy start.

## Two service credentials

1457 accepts standard `Authorization: Bearer <external token>` from DSH. Configure
`DSH_CHAT_API_TOKEN` or `DSH_CHAT_API_TOKEN_FILE` (exactly one). 1457 forwards a
separate credential to 1456: `PCW_INTERNAL_TOKEN` or `PCW_INTERNAL_TOKEN_FILE`.
Each value must contain 32–256 URL-safe characters and must be independently
random; the two values cannot match. These are local service credentials, not
ChatGPT cookies/tokens. The application never invents a default credential.

The existing DSH overlay references `PCW_LOCAL_KEY`. Configure it to the external
service token through your trusted local process environment or DSH credential
service. DSH managed credentials may override the environment: their value must
match too. `run.ps1` requires an explicitly matching PCW_LOCAL_KEY and never sets
a placeholder. Chat Completions/Responses paths, tool schema and streaming remain
unchanged. No new token was created, read or installed during this work.

The file interface reads an explicitly selected regular file, bounded to 1024
bytes, at startup. Store it outside the checkout/capture directories. Protect its
parent and file with an account-only Windows ACL or POSIX 0700/0600 permissions.
The loader does not claim to verify Windows ACLs or protect against another
process running as the same user. Never put credentials in command lines, Git,
logs, issue reports or CI secrets for the offline tests. Token rotation requires
coordinated idle restart of both services and the client reference.

## Ingress rules

Both services validate the socket loopback peer and exact loopback Host/port,
reject browser Origin/Referer/Sec-Fetch context, and require a service Bearer
credential before protected routes, parsing, queueing or browser access. JSON
POSTs accept application/json with optional UTF-8 charset only. This is actual
authentication plus browser-request restrictions; CORS is not authentication.
1457 cannot forward to a remote origin or follow a redirect. 1456 refuses a
non-loopback listen address. Any code executing as this Windows account can
potentially access the configured tokens; this is not an OS user isolation layer.

Only exact GET /health is public, with service/status only. Protected health
contains `security: service-bearer-v1`; the startup manager authenticates and
requires this marker before accepting an existing service. Old running services
must not be treated as a migrated secure deployment. Diagnostics, model catalogs
and all generation aliases are protected. No browser activity is triggered by
unauthenticated requests in offline acceptance.

## Diagnostics and captures

Default bridge/adapter logs use an allowlist of events, bounded numbers, booleans,
request UUIDs and SHA256 digests. Arbitrary error messages, tool/model identifiers,
headers, prompts and responses are not stored verbatim. Digests can still reveal
correlation or guesses of low-entropy values: logs are private operational data.
Structural protocol samples remain bounded to 20 files. `.runtime` and adapter
log paths must stay private and outside public artifacts. POSIX mode requests do
not establish an account-only Windows ACL; configure that before live use.

Raw response capture is disabled in this experimental candidate, including when
PCW_CAPTURE_DIR is set. No capture directory is read or created. A warning record
is emitted. Earlier versions could capture full task/model/account content: keep
old captures private; disabling future capture does not delete previous files.

## Controlled deployment boundary

Deployment of the new credential scheme is explicitly deferred for this release
preparation. No new service tokens are created or installed; the security source
and fail-closed checks remain intact. Existing accepted services and settings are
not changed by preparing this source directory.

If a later, separately authorized deployment is requested, preserve recoverable
configuration/credential references, check idle state, then configure both service
references and reload only this project. Do not overwrite concurrent user edits.
No authentication, proxy, network or browser-security setting is silently changed
by install.ps1 or CI. Release documentation work does not require repeating the
maintainer-confirmed live acceptance.
