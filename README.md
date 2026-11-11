# LongMemory for SillyTavern

LongMemory stores SillyTavern chats and imported notes in SQLite, recalls matching excerpts before generation, and links results to their original messages. It can move stored messages out of the active prompt without replacing them with summaries. Imported documents live in a separate read-only knowledge library.

**Release:** v0.3.0 is the first public release. v0.2 was a local baseline. Local verification passed; remote CI results are still pending. See [compatibility](docs/COMPATIBILITY.md) for the tested host and limits.

## What it does

- Stores complete UTF-8 messages with SHA-256 acknowledgments and revision history. Visibility changes wait for confirmed storage; failed chat saves are rolled back.
- Supports pinned, active, and offloaded messages, plus separately enabled automatic overflow handling and current-character historical chat import.
- Finds chat excerpts by text matching within the authenticated user and world. Full-message reads require the exact chat and source.
- Imports selected conversation exports and Markdown/TXT notes into a knowledge collection after a preview of the parsed text and any loss warnings.
- **归档当前聊天（先预览）** saves a JSONL snapshot of the open chat, including original message metadata, to a selected collection after preview and confirmation.
- Searches knowledge by keyword or exact text, opens cited messages, rebuilds search indexes, and exports/restores the selected collection's original documents and retained revisions.
- Optionally includes knowledge excerpts in prompts sent through SillyTavern's selected model connection. LongMemory does not choose a model or call a separate model service.

Memory, automatic historical imports, automatic overflow handling, and knowledge prompt inclusion are off by default. Enable them separately in the extension settings. Importing a file does not enable prompt inclusion.

## Inputs and limits

Imports support SillyTavern JSONL, Workbench-style normalized JSON, Markdown, TXT, and the Google AI Studio, Anthropic, OpenAI, OpenRouter, LM Studio, and Grok structures recognized by the pinned ThreadShelf parser. These are file adapters, not account integrations; they may not accept a provider's latest export. See [compatibility](docs/COMPATIBILITY.md).

The library keeps the decoded UTF-8 source text, its SHA-256, parser revision, and warnings about text excluded from search. Media references, unsupported metadata, branches, and thinking may remain in the source without being searchable. Media and linked attachments are not downloaded. v0.3.0 does not provide binary file preservation, PDF/OCR, semantic/vector search, MCP, or remote synchronization.

Chat persistence accepts at most 1 MiB of UTF-8 text per message and 2,000 items per batch. The extension splits batches at 8 MiB of serialized UTF-8 JSON, including scope fields, item metadata, and escaping; usable message text per batch is therefore smaller. Library imports also have file, message, count, and stored-text quotas. Oversized or malformed input is rejected, not shortened. A Markdown/TXT note must fit the projected-message limit. Keep original exports separately: a local SQLite file is not a substitute for a backup.

## Requirements

- A SillyTavern installation that supports third-party browser extensions and server plugins. The tested host is listed in [compatibility](docs/COMPATIBILITY.md).
- Node.js 22+ and Python 3.11+ with the standard-library `sqlite3` module. CI targets Node 22/24 and Python 3.11; this is not a claim that all combinations have passed.
- Permission to install and run server-side code on that SillyTavern instance. Browser-only hosting is insufficient.

## Build and install

To build from source:

```sh
npm ci
npm run build
```

The build writes two payloads. Install both:

| Payload | Destination in your SillyTavern installation | Required entry |
|---|---|---|
| Contents of `dist/extension/` | `public/scripts/extensions/third-party/long-memory-bridge/` | `manifest.json`, loading `index.js` |
| Contents of `dist/plugin/` | `plugins/long-memory-bridge/` | `package.json`, with `main: index.cjs` |

Do not put the backend in the browser extension directory, or the browser extension in `plugins/`. Copy the complete payload directories, including Python files, local ES modules, and license notices.

1. Stop SillyTavern and back up its configuration and data. For an upgrade, preserve the existing memory database and scope key as well.
2. Copy each payload to the matching destination above.
3. Manually set `enableServerPlugins: true` in the SillyTavern configuration you actually start. LongMemory does not edit host configuration or enable server plugins for you. Enabling this host option permits installed server plugins to run; review what you install.
4. Ensure `python` resolves to the intended interpreter in the environment that starts SillyTavern. Alternatively set `LONG_MEMORY_PYTHON` to that interpreter's executable path before starting the host.
5. Start SillyTavern, reload its browser page, and find the LongMemory/长期记忆桥接 extension settings. Confirm backend availability before enabling memory or offloading anything.

Keep the host's authentication and CSRF protections enabled. Do not disable CSRF to make an installation or test work.

### Storage and upgrades

The backend stores `memory.sqlite3` and `scope.key` in `long-memory-bridge/` beneath the host data root. Set `LONG_MEMORY_STATE_DIR` to use another directory. Development and smoke tests must use a new directory, never real chats or an installed memory database. The scope key is used to derive user/world/chat identities; back it up with the database and do not publish it.

The v0.3 migration adds schema and history data. Reconciliation deactivates records without deleting their retained original text. Stop the host before a filesystem backup so SQLite WAL data is not missed. Test upgrades and restores on a copy first; reverting code does not reverse a database migration.

v0.2 rows may already contain truncated text, which migration cannot recover. Conflicting content at the same revision is rejected. Keep original chats and backups, and validate a separate import of the original JSONL before replacing a live installation. If a compensating chat save also fails, manual recovery may be needed; retain the original host backup.

### First use

1. Start with invented chat content and keep automatic features off.
2. Enable memory, persist a message, and verify full-message readback before trying offload/restore.
3. For knowledge, select a supported UTF-8 file, review the preview and warnings, and explicitly import it into the intended collection.
4. Search for a distinctive phrase and open its cited message. To snapshot the open chat, use **归档当前聊天（先预览）**, review its preview, and confirm the import. Export the selected collection and try restoring it into an isolated test state directory.
5. Enable knowledge prompt inclusion only if those excerpts may be sent to your selected SillyTavern model provider.

## Privacy and trust

LongMemory processes and stores data on the SillyTavern server and in the browser. It has no separate model/API service and does not fetch media. SillyTavern's normal model connection can still send prompts containing recalled excerpts. The data is not encrypted by LongMemory; originals, metadata, history, and backups may be private.

SHA-256 detects content changes relative to a known hash. It does **not** prove who authored a document, authenticate a backup, or make imported text trustworthy. Treat recalled text as untrusted data, not instructions. See [security](SECURITY.md) before sharing backups or reporting an issue.

The library export covers only the selected collection and its retained document revisions in the current user/world scope. It excludes other collections, chat-memory records, scope keys, extension settings, and the rest of the SQLite database. To back up the full state, stop the host and copy the state directory and relevant host configuration.

## Development and verification

```sh
npm ci
npm run build
npm test
npm audit --audit-level=low
npx playwright install chromium
npm run test:browser
```

On Linux CI, use `npx playwright install --with-deps chromium`. Browser tests use synthetic host shims, not a running SillyTavern instance. A separate local smoke test passed on the pinned SillyTavern 1.18.0 checkout with synthetic content and CSRF enabled. [Compatibility](docs/COMPATIBILITY.md) records its scope and limits. To rerun it, supply `ST_SOURCE` as described in [contributing](CONTRIBUTING.md). Benchmarks, cross-platform verification, and remote CI results are not available yet.

## License and attribution

LongMemory's original code is **AGPL-3.0-only**; see [LICENSE](LICENSE). Selected ThreadShelf modules are vendored under their original **MIT** license from commit [`f13b721561305c3b040dc701ce86553ec36c4447`](https://github.com/ChrystianSchutz/ThreadShelf/tree/f13b721561305c3b040dc701ce86553ec36c4447). The MIT notice remains in `vendor/threadshelf/LICENSE` and the backend distribution's `THREADSHELF-LICENSE.txt`.

`vendor/threadshelf/PROVENANCE.json` records the upstream commit and SHA-256 of selected source files. The build bundles only parser, chunking, and model-label helpers; it does not bundle or run the complete ThreadShelf application. Adapters remain separate from the vendored source. See [changelog](CHANGELOG.md) and [contribution guidance](CONTRIBUTING.md).
