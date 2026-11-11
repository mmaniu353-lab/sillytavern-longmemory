# Compatibility and verification scope

v0.3.0 is not published. The following describes the development target and supported input shapes, not a blanket compatibility certification.

## Runtime and host

| Component | Target | Evidence boundary |
|---|---|---|
| Node.js | 22+ | Local Windows checks used 22.20.0; CI is configured for 22 and 24 on Ubuntu and Windows, but remote results are not yet claimed |
| Python | 3.11+, standard-library SQLite | Local Windows checks used 3.11.9; CI is configured for 3.11, and later versions require their own evidence |
| Browser | Chromium through Playwright 1.65.0 | Synthetic host-shim checks and the isolated actual-host UI check are separate verification paths |
| SillyTavern | 1.18.0, commit `51ad27fb86d39a3daca3adaa970375c9670c12df` | Local isolated Windows smoke passed with fresh synthetic data; no other host revision or multi-user login deployment is certified |

The local `outputs/host-smoke-result.json` was inspected and reports `passed: true` for the pinned host above. It records six completed stages: isolated tracked-host startup; real cookie-session CSRF enforcement including HTTP 403 without a token; full Unicode persistence/readback with exact SHA-256 acknowledgments; HTTP library preview/import/search/read/export/restore plus tamper rejection; actual extension loading with memory/import/offload/injection defaults off; and imported-knowledge search from a synthetic character's installed UI. It records no browser page errors and no blocked external origins, and the harness asserts that no model-provider requests occurred. The artifact is local verification output, not included in release/CI payload uploads.

The smoke used a loopback-only fresh host with `enableUserAccounts: false` and enabled CSRF. It verifies default-user route/session behavior, not a multi-user sign-in deployment. It does not exercise every generation backend, model, host setting, or supported export shape. Remote Ubuntu/Windows CI and Node 24 results remain pending until those jobs actually run. The project remains unreleased.

Both payloads are required: the frontend has `manifest.json` and browser entry `index.js`; the backend has `package.json` and CommonJS entry `index.cjs`. Enable server plugins manually in the host configuration. Browser-only installations cannot persist through this backend.

## Import formats

| Input | Adapter | Important limits |
|---|---|---|
| `.md`, `.txt` | Project-owned note adapter | UTF-8 text; note is one projected message and must fit its per-message quota; links/media are not fetched |
| SillyTavern `.jsonl` | Project-owned adapter | Chat header and message text; system messages are separated; unsupported attachments/metadata remain raw evidence |
| Workbench-style `.json` | Project-owned normalized-message adapter | Top-level `messages`, message `text`/string `content`, role and supported metadata; not every rich Workbench export shape |
| Google AI Studio JSON | Pinned ThreadShelf parser | Recognized export structure and selected text projection |
| Anthropic JSON | Pinned ThreadShelf parser | Recognized export structure and selected text projection |
| OpenAI JSON | Pinned ThreadShelf parser | Recognized conversation mapping/group structure and selected branch text |
| OpenRouter JSON | Pinned ThreadShelf parser | Recognized export structure and selected text projection |
| LM Studio JSON | Pinned ThreadShelf parser | Recognized export structure and selected message versions |
| Grok JSON | Pinned ThreadShelf parser | Recognized conversation/response export structure and selected text projection |

Provider names identify parsers, not API integrations. No account access, live API compatibility, subscription requirement, or latest export support is implied. Upstream formats can change; malformed, unsupported, empty, duplicate-identity, or over-quota input is rejected rather than silently treated as a successful empty import.

The selected ThreadShelf source is pinned to commit [`f13b721561305c3b040dc701ce86553ec36c4447`](https://github.com/ChrystianSchutz/ThreadShelf/tree/f13b721561305c3b040dc701ce86553ec36c4447), identified as version 1.4.1 in the vendored provenance declaration. These are pinned-source declarations, not a claim about the latest upstream release. Source hashes are in `vendor/threadshelf/PROVENANCE.json`; MIT notices accompany source and backend output.

## Preservation and generation

Original decoded UTF-8 raw text is canonical evidence. It is not a byte-for-byte backup of a binary input or of an encoding that was converted before import. Raw hashes and projection revisions allow change detection, not authenticity verification. Metadata/media references may remain only in raw evidence, while selected branches and text are searchable; excluded thinking and unsupported fields are not promised as searchable content.

Chat memory and imported knowledge are separate sources. The current-chat archive action creates a preview-and-confirm knowledge snapshot; it does not automatically add every chat to the library. Export/restore covers only the selected knowledge collection and its retained document revisions in the current user/world scope, not all collections, chat-memory rows, settings, scope keys, or the whole database.

Knowledge prompt inclusion is opt-in, and selected excerpts use the model connection already configured in SillyTavern. LongMemory adds no own remote model client, automatic media retrieval, semantic/vector backend, MCP server, PDF parser, or OCR pipeline.

## Verification categories

- **Node/Python fixtures:** acknowledgments, atomic writes, scope isolation, parser behavior, canonical history, archive integrity/restore, and route behavior with synthetic inputs.
- **Browser-shim checks:** UI flows in a controlled page that supplies synthetic host interfaces. These do not verify actual host authentication, CSRF behavior, or loading order.
- **Actual-host smoke:** explicitly supplied disposable `ST_SOURCE`, isolated data/state, synthetic content, and host authentication/CSRF retained. Not run by default or by the configured CI matrix.
- **Publication:** independent review of source/artifacts, licenses/provenance, private-data exclusion, and completed verification evidence. A development version field is not a release.

Record executed commands and failures as well as passes. Do not convert an unexecuted matrix entry, optional test, or intended host target into a supported-version claim.
