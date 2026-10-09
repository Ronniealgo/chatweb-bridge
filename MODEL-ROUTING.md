# Chat Web model routing candidate

This is an offline-tested implementation foundation, not a working GPT-6 or
GPT-6 Pro connection. Neither model has an enabled entry: this account's exact
web model slugs and thinking choices have not been obtained. The checked-in
`web-model-metadata.json` deliberately contains an empty `models` array.

The existing GPT-5.6 route and original `dsh-chat-tools.patch.yml` are retained.
The legacy three configured HTTP IDs are not advertised as current account
entitlements. Their existing response-identity behavior is retained; the strict
final-message identity requirement applies to newly configured metadata routes.
No default provider/model selection, credential, browser profile, service, or
network setting is changed by this candidate or the metadata export script.

## Local metadata contract

`model-routes.mjs` loads `web-model-metadata.json` beside the server. This is a
manually reviewed projection of existing official ChatGPT page model metadata,
not an official API response format and not cryptographic entitlement proof.
Do not fill it from another provider's model catalog, marketing labels, guessed
slugs, or the public Responses API model list. Keep an independent, sanitized
evidence record outside the source export.

Each additional entry must contain:

- `slug`: the exact web request model; no bridge alias is introduced.
- `display_name`: the exact name from that web metadata.
- `thinking_efforts`: exact recorded web thinking values.
- `reasoning_efforts`: a reviewed map from supported DSH effort keys to those
  values. Unsupported keys fail before the upstream request. New models do not
  inherit GPT-5.6's max-to-high/extended mapping.
- `default_effort`: one of that entry's recorded DSH keys.
- `context_window` and `max_output_tokens`: reviewed harness limits; do not copy
  a large API context limit into a web message transport without evidence.
- `evidence`: `source` equal to `chatgpt-web-account-metadata`, the source's UTC
  `captured_at`, and SHA256 of the retained sanitized evidence. These fields record
  provenance, not validation of the account's present entitlement.

The exact metadata file and the generated DSH overlay must be reviewed together:

```powershell
node scripts/model-route-patch.mjs web-model-metadata.json '<new-output.patch.yml>'
```

This produces a JSON-form YAML provider overlay, refuses to overwrite its output,
and never installs it. It lists the retained GPT-5.6 model plus recorded additions.
It contains no `agent-default-model` entry. Apply after the existing route overlay
only after checking the target DSH version's resolved merged configuration. Do
not change the user's global default by using the desktop model selector.

## Identity and failure behavior

The bridge checks the selected route against the outgoing model field before
submitting. A new route sends its exact web thinking value and requires final
model evidence. The adapter takes this evidence from the selected final message,
or from the final message on the handoff conversation branch bound to this request.
Later commentary and reasoning messages cannot substitute their model metadata.

Missing or different final model identity fails before text/tool delivery, with
`generation_submitted: true` and `retryable: false`; a generation may already have
consumed usage. Missing model metadata is not repaired by filling in the requested
ID. An old adapter that ignores the new requirement is rejected by the bridge
when it cannot return final-message evidence. No automatic retry, provider change,
alias fallback, or authentication/security change is introduced.

## Remaining evidence and deployment conditions

Read-only Windows UI Automation found the dedicated Chrome window, but no model
label/slug in the currently exposed controls. No separate model catalog file was
found among the dedicated adapter cache's top-level filenames. The adapter's own
`/v1/models` is hard-coded, so querying it would not prove account availability.
Browser profile/cache databases and authentication state were not read.

The minimum remaining discovery targets the already loaded official ChatGPT
page's own model catalog for GPT-6 and GPT-6 Pro: exact slug, display name,
availability, and thinking choices. A model-picker label alone is insufficient.
A separately authorized local inspection on 2026-10-09 used one CDP target-list
GET, one existing-page WebSocket handshake GET, and one side-effect-restricted
page evaluation. It found one loaded ChatGPT page, but no model catalog array
or model-picker control in the narrowly permitted locations. This does not prove
that no catalog exists elsewhere in the application. The inspection stopped; no
webpage request, navigation, refresh, generation, or credential read occurred.
The original halted live budget was unchanged. No reliable slug or thinking
metadata was obtained, so no new route was enabled. A further discovery step
requires a separately specified scope; do not guess a catalog endpoint or reuse
captured authentication.

The maintainer has now confirmed real-task acceptance of the existing web Chat
route. This supersedes older general statements that this route still needs
acceptance; release documentation work does not require repeating it.

GPT-6 / GPT-6 Pro remain separate, disabled routes without verified web metadata.
Do not claim Codex support or enable new model labels as part of release cleanup.
If new models are requested later, obtain exact metadata and authorize their own
bounded checks; do not infer new-model support from existing-route acceptance.

The new two-layer service authentication remains in source, but its deployment
is deferred in this release preparation. No service, credential, default model
or browser configuration is changed here. Production readiness and complete
redistribution clearance are not claimed; the upstream notice gap remains.
Original source archives and production data are preserved, not overwritten.
