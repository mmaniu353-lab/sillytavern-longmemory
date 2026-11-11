# Changelog

## 0.3.0 — Unreleased

First intended public release. The version is present in development manifests; no public v0.3.0 release is claimed.

### Chat memory

- Add full UTF-8 content-hash acknowledgments and strict, atomic batch validation before frontend offload or visibility changes.
- Preserve canonical message bodies and retained revisions across edits, restarts, and reconciliation; add an additive SQLite schema migration.
- Require exact chat/source identity for evidence readback and keep derived retrieval excerpts bounded separately from canonical storage.
- Roll back frontend flags and display changes when persistence or chat saving fails.

### Knowledge library

- Add explicit file preview/import, scoped keyword and exact search, citation readback, derived-index rebuild, and canonical export/restore.
- Add preview-and-confirm snapshots of the current chat into a selected knowledge collection; collection exports are not whole-database backups.
- Preserve raw text, metadata evidence, parser revision, hashes, and projection warnings separately from searchable text.
- Add opt-in knowledge excerpts to the existing SillyTavern generation path without introducing another model service.
- Add adapters for Markdown/TXT notes, SillyTavern JSONL, Workbench-style JSON, and six provider structures through selected ThreadShelf parsing modules.

### Packaging and verification

- Separate the browser extension manifest payload from the server plugin `package.json` payload with CommonJS entry `index.cjs`.
- Pin MIT-licensed ThreadShelf source at `f13b721561305c3b040dc701ce86553ec36c4447`, retain attribution, and record selected-file hashes.
- Add synthetic Node/Python tests, browser-shim checks, and an opt-in isolated host smoke test. CI configuration targets Ubuntu and Windows with Node 22/24 and Python 3.11.
- Keep automatic features disabled by default. Retain host authentication and CSRF requirements; do not modify live host configuration or real user state during development.
- Record a local isolated SillyTavern 1.18.0 smoke pass at commit `51ad27fb86d39a3daca3adaa970375c9670c12df`, including real CSRF rejection, canonical Unicode readback, library roundtrip, defaults, and synthetic-character UI search. This is not a remote CI or cross-platform result.

This release does not add semantic/vector search, MCP, PDF/OCR, remote synchronization, media downloading, or a general-purpose file crawler. Test execution, actual-host compatibility, and publication remain separate release checks; this changelog is not a claim that they have all completed.

## 0.2 — Local baseline

Private local memory-bridge baseline used before preparing the first public release. No public tag, release date, or published download is asserted for this version.
