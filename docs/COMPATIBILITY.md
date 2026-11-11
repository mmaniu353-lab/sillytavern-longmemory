# Compatibility

These are the runtime targets, supported input formats, and verification limits for v0.3.0. Remote CI results are still pending.

## Runtime and host

| Component | Target | Tested scope |
|---|---|---|
| Node.js | 22+ | Local Windows checks used 22.20.0; Ubuntu/Windows CI for 22/24 is pending |
| Python | 3.11+, standard-library SQLite | Local Windows checks used 3.11.9; CI targets 3.11; later versions are unverified |
| Browser | Chromium through Playwright 1.65.0 | Separate synthetic host-shim and isolated actual-host UI checks passed locally |
| SillyTavern | 1.18.0, commit `51ad27fb86d39a3daca3adaa970375c9670c12df` | Isolated Windows smoke passed with fresh synthetic data; other revisions and multi-user login deployments are unverified |

The local `outputs/host-smoke-result.json` reports `passed: true` for the pinned host. Its seven stages covered:

1. Startup from the isolated tracked host source.
2. Cookie-session CSRF checks, including HTTP 403 without a token.
3. Full Unicode persistence/readback with exact SHA-256 acknowledgments.
4. Library preview/import/search/read/export/restore over HTTP, including tamper rejection.
5. Installed extension loading with memory, automatic import/offload, and prompt inclusion off by default.
6. Imported-knowledge search in the installed UI using a synthetic character.
7. Opening the memory console, reading the synthetic original, and closing it without model calls.

The run recorded no browser page errors or blocked external origins; the harness also checked that no model-provider requests occurred. This local output is excluded from release and CI payload uploads.

The smoke used a fresh loopback-only host with `enableUserAccounts: false` and CSRF enabled. It checked default-user routes and sessions, not multi-user sign-in, every generation backend/model, every host setting, or every supported export shape. Ubuntu/Windows CI and Node 24 results remain pending.

Both payloads are required: the frontend has `manifest.json` and browser entry `index.js`; the backend has `package.json` and CommonJS entry `index.cjs`. Enable server plugins manually in the host configuration. Browser-only installations cannot persist through this backend.

## Import formats

| Input | Adapter | Important limits |
|---|---|---|
| `.md`, `.txt` | Project-owned note adapter | UTF-8 text; note is one projected message and must fit its per-message quota; links/media are not fetched |
| SillyTavern `.jsonl` | Project-owned adapter | Chat header and message text; system messages are separated; unsupported attachments/metadata remain in the source text |
| Workbench-style `.json` | Project-owned normalized-message adapter | Top-level `messages`, message `text`/string `content`, role and supported metadata; not every rich Workbench export shape |
| Google AI Studio JSON | Pinned ThreadShelf parser | Recognized export structure and selected text projection |
| Anthropic JSON | Pinned ThreadShelf parser | Recognized export structure and selected text projection |
| OpenAI JSON | Pinned ThreadShelf parser | Recognized conversation mapping/group structure and selected branch text |
| OpenRouter JSON | Pinned ThreadShelf parser | Recognized export structure and selected text projection |
| LM Studio JSON | Pinned ThreadShelf parser | Recognized export structure and selected message versions |
| Grok JSON | Pinned ThreadShelf parser | Recognized conversation/response export structure and selected text projection |

Provider names identify file parsers, not API integrations. They do not imply account access, live API compatibility, a subscription requirement, or support for the latest exports. Formats can change. Malformed, unsupported, empty, duplicate-identity, or over-quota input is rejected, not reported as a successful empty import.

The selected ThreadShelf source is pinned to commit [`f13b721561305c3b040dc701ce86553ec36c4447`](https://github.com/ChrystianSchutz/ThreadShelf/tree/f13b721561305c3b040dc701ce86553ec36c4447), listed as version 1.4.1 in the vendored provenance file. This describes the pinned source, not the latest upstream release. Source hashes are in `vendor/threadshelf/PROVENANCE.json`; MIT notices accompany source and backend output.

## Preservation and generation

The library preserves decoded UTF-8 source text, not the original bytes of a binary file or an encoding converted before import. Hashes and parser revisions help detect changes; they do not verify authenticity. Metadata and media references may remain only in source text. Search covers selected branches and text; it may omit thinking and unsupported fields.

Chat memory and imported knowledge are separate sources. The current-chat archive action adds a snapshot to the library only after preview and confirmation; other chats are not automatically added. Export/restore covers only the selected knowledge collection and its retained document revisions in the current user/world scope, not all collections, chat-memory rows, settings, scope keys, or the whole database.

Knowledge prompt inclusion is opt-in, and selected excerpts use the model connection already configured in SillyTavern. LongMemory has no separate remote model client, automatic media retrieval, semantic/vector backend, MCP server, PDF parser, or OCR pipeline.

## Tests and release checks

- Node/Python fixtures test acknowledgments, atomic writes, scope isolation, parsers, stored history, archive integrity/restore, and routes using synthetic inputs.
- Browser-shim tests check UI flows with synthetic host interfaces. They do not verify actual host authentication, CSRF, or loading order.
- The host smoke test requires an explicitly supplied disposable `ST_SOURCE`, isolated state, synthetic content, and host session/CSRF protections. It is separate from the default tests and CI matrix; its default-user setup does not test multi-user login.
- Before publication, review source and artifacts, licenses/provenance, private-data exclusions, and the results of completed checks. Version fields alone do not establish a release.

Record commands and failures as well as passes. Do not claim compatibility from an unrun matrix job, optional test, or intended host target.
