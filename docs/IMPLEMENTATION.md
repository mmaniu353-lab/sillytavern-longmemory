# LongMemory v0.3.0 implementation plan

Approved scope: ST-native memory plus narrowly vendored ThreadShelf parsing, reliable canonical storage, read-only knowledge imports and verifiable export/restore. No live installation or real database is changed.

## Boundaries and contracts

- `plugin/memory_store.py`: canonical messages, additive migration/history, strict per-item acknowledgments. `put_confirmed` returns source/revision/full UTF-8 SHA-256/status; batches validate and commit atomically. Indexes never replace originals.
- `extension/persistence.mjs`: await and validate acknowledgments before visibility changes; recheck current chat/revision/hash; roll back flags and DOM if chat save fails.
- `plugin/vault_store.py`: scoped canonical raw documents, revisions, messages and rebuildable chunks. Import is atomic; exports use a consistent snapshot; lists are summaries; full reads use explicit identity.
- `plugin/normalize.cjs`: bounded explicit inputs only, pinned upstream grouped parser and own ST/Workbench/Markdown adapters. Preserve original raw/hash, report projection losses. No arbitrary paths, URLs, execution or model calls.
- `plugin/library-routes.cjs`: authenticated scope binding, preview/reparse/import/export/restore/search/read; never accept client ownership or salts. Existing `index.cjs` mounts routes and enforces payload/RPC budgets.
- `extension/library.mjs`: explicit read-only file selection, import preview/confirmation, scoped search, citation readback, export/restore and opt-in knowledge prompt inclusion.

## Tasks and verification

1. Write failed-write, stale revision, hash mismatch, long-text and scope regressions. Observe original failures before changing storage/frontend. Implement strict acknowledgments, retained originals and exact item lookup; rerun regressions and restart tests.
2. Write temporary SQLite vault tests: atomic malformed multi-document import, idempotence, versions, Unicode/raw hash roundtrip, scoped search/no-match/citation offsets, index rebuild. Implement store then rerun.
3. Write parser tests before the normalizer: Markdown/TXT, ST JSONL, Workbench normalized JSON, six upstream provider structures; reject malformed/over-budget input. Vendor exact MIT source/notice and build only the selected modules; implement adapters and explicit warnings.
4. Write synthetic authenticated HTTP tests: unauthenticated requests, forged ownership, wrong-world/read identities, invalid collection, preview without mutation, import/export/tampered restore. Integrate bounded worker dispatch and routes. Historical scans validate the whole bounded file before committing and never infer deletion from missing directories.
5. Write browser host-shim tests using invented chat/documents: missing backend, offload success/failure, file preview/import, quoted search results and readback, export/restore, knowledge-injection opt-in. Then run a clean pinned SillyTavern 1.18.0 instance with a temporary data root and synthetic user/chat, retaining authentication/CSRF protections.
6. Run fresh Node/Python tests/build/browser/host checks; inspect source and release allowlists; record actual supported versions and missing checks. Build separate frontend/backend artifacts, source and SHA-256 notices. Audit before public release and update application only after evidence exists.

## Commands

`npm ci`, `npm run build`, `npm test`, `npx playwright install chromium`, `npm run test:browser`, `npm run test:host`.

Python tests run through `LONG_MEMORY_PYTHON` or `python` in a subprocess using only temporary SQLite. The application does not require a new Python package. Every test must clean up its own files and worker. Semantic retrieval, MCP, writable vaults and model downloads are excluded from 0.3.0.

## Rollback and publication

Only additive schema changes are accepted. Back up a database before any manual upgrade; test restore on a copy. Do not silently replace a user's installed extension, config or database. Release source contains only audited runtime files, synthetic tests, docs and license notices. Do not add real chats, character cards, keys, state files or account screenshots.
