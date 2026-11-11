# Changelog

## 0.3.0 — First public release

### Chat memory

- Add full UTF-8 content-hash acknowledgments and strict, atomic batch validation before frontend offload or visibility changes.
- Preserve original message text and revisions across edits, restarts, and reconciliation; add an additive SQLite schema migration.
- Require exact chat/source identity for full-message reads. Limit retrieval excerpts separately from stored originals.
- Roll back frontend flags and display changes when persistence or chat saving fails.

### Knowledge library

- Add file preview/import, scoped keyword and exact search, citation readback, search-index rebuild, and export/restore of original documents.
- Add preview-and-confirm snapshots of the current chat into a selected knowledge collection; collection exports are not whole-database backups.
- Preserve raw text, metadata, parser revision, hashes, and warnings about text excluded from search.
- Add opt-in knowledge excerpts to the existing SillyTavern generation path without introducing another model service.
- Add adapters for Markdown/TXT notes, SillyTavern JSONL, Workbench-style JSON, and six provider structures through selected ThreadShelf parsing modules.

### Packaging and verification

- Separate the browser extension manifest payload from the server plugin `package.json` payload with CommonJS entry `index.cjs`.
- Pin MIT-licensed ThreadShelf source at `f13b721561305c3b040dc701ce86553ec36c4447`, retain attribution, and record selected-file hashes.
- Add synthetic Node/Python tests, browser-shim checks, and an opt-in isolated host smoke test. CI configuration targets Ubuntu and Windows with Node 22/24 and Python 3.11.
- Keep automatic features disabled by default. Retain host authentication and CSRF requirements; do not modify live host configuration or real user state during development.
- Record a local isolated SillyTavern 1.18.0 smoke pass at commit `51ad27fb86d39a3daca3adaa970375c9670c12df`, including real CSRF rejection, full Unicode readback, library roundtrip, defaults, and synthetic-character UI search. Remote CI and cross-platform results are still pending.

This release does not include semantic/vector search, MCP, PDF/OCR, remote synchronization, media downloading, or a general-purpose file crawler. See [compatibility](docs/COMPATIBILITY.md) for verification results and limits.

## 0.2 — Local baseline

Private local memory-bridge baseline. No public tag or download was published.
