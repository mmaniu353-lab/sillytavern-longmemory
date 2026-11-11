# LongMemory for SillyTavern

Local, source-addressable chat memory and a read-only knowledge library for SillyTavern. LongMemory stores originals in SQLite, recalls matching excerpts before generation, and can move acknowledged messages out of the active prompt without replacing them with summaries.

**Release status:** v0.3.0 is in preparation and has not been published. It is the intended first public release; v0.2 was a local baseline, not a public release. Package version fields identify this development target, not a published artifact.

## What it does

- Persists chat messages with full UTF-8 SHA-256 acknowledgments, explicit revisions, and retained version history. Visibility changes wait for confirmed storage; failed chat saves are rolled back.
- Supports pinned, active, and offloaded messages, plus separately enabled automatic overflow handling and current-character historical chat import.
- Recalls bounded lexical excerpts from stored chat evidence, scoped to the authenticated user and world. Full evidence reads identify the exact chat and source.
- Imports explicitly selected conversation exports and Markdown/TXT notes into a separate read-only knowledge collection. Preview parsing results and loss warnings before confirming an import.
- **归档当前聊天（先预览）** snapshots the open chat as JSONL with original message metadata; confirm import before it becomes an independently exportable library document. Library exports cover the selected collection, not an automatic backup of the entire live chat-memory database or SillyTavern configuration.
- Searches knowledge with keyword or exact text matching, opens cited evidence, rebuilds derived indexes, and exports/restores the selected knowledge collection's original documents and retained revisions.
- Offers a current-chat snapshot through the library's **归档当前聊天（先预览）** action: preview the text/metadata snapshot, then explicitly confirm importing it into the selected collection.
- Optionally adds knowledge excerpts to the prompt sent through the model connection already selected in SillyTavern. LongMemory does not choose a model or call a separate model service.

Memory, automatic historical imports, automatic overflow handling, and knowledge prompt inclusion are disabled by default. Enable only the features you want in the extension settings. Importing a knowledge file does not itself authorize adding it to model prompts.

## Inputs and limits

Supported adapters cover SillyTavern JSONL, Workbench-style normalized JSON, Markdown, TXT, and the pinned ThreadShelf parser's Google AI Studio, Anthropic, OpenAI, OpenRouter, LM Studio, and Grok export structures. These are file-format adapters, not live account integrations or a promise to accept every current provider export. See [compatibility](docs/COMPATIBILITY.md).

The library preserves the original decoded UTF-8 text, its SHA-256, parser revision, and projection warnings. Search uses a text projection: media references, unsupported metadata, branches, and thinking may not be searchable even though they remain in the original raw text. Media and linked attachments are not downloaded. Binary file fidelity, PDF/OCR, semantic/vector search, MCP, and remote synchronization are outside v0.3.0.

Chat persistence accepts at most 1 MiB of UTF-8 per message, 2,000 items per batch, and 8 MiB of message text per batch. Library imports have additional file, message, count, and canonical-storage quotas; oversized or malformed input is rejected rather than silently shortened. Large Markdown/TXT notes must also fit the projected-message limit. Keep original exports separately: a local SQLite file is not a substitute for a backup.

## Requirements

Old v0.2 database rows may already contain truncated text. A migration cannot reconstruct missing suffixes; equal-revision/full-content conflicts are rejected rather than falsely acknowledged. Keep original chats and backups, and validate a separate import of the original JSONL before replacing a live installation. A failed compensating chat save can require manual recovery; preserve the original host backup.

- A SillyTavern installation with third-party browser extensions and server plugins available. Actual host compatibility is tracked separately from unit and browser-shim tests in [compatibility](docs/COMPATIBILITY.md).
- Node.js 22 or later, and Python 3.11 or later with the standard-library `sqlite3` module. CI targets Node 22/24 and Python 3.11; other combinations are not implied to be tested.
- Permission to install and run server-side code on that SillyTavern instance. Browser-only hosting is insufficient.

## Build and install

There is no published v0.3.0 release artifact yet. Build from this source tree:

```sh
npm ci
npm run build
```

The build writes **two different installation payloads**:

| Payload | Destination in your SillyTavern installation | Required entry |
|---|---|---|
| Contents of `dist/extension/` | `public/scripts/extensions/third-party/long-memory-bridge/` | `manifest.json`, loading `index.js` |
| Contents of `dist/plugin/` | `plugins/long-memory-bridge/` | `package.json`, with `main: index.cjs` |

Do not put the backend in the browser extension directory, or the browser extension in `plugins/`. Copy the complete payload directories, including Python files, local ES modules, and license notices.

1. Stop SillyTavern and back up its configuration and data. For an upgrade, preserve the existing memory database and scope key as well.
2. Copy each payload to the matching destination above.
3. **Manually** set `enableServerPlugins: true` in the SillyTavern configuration you actually start. LongMemory does not edit host configuration or enable server plugins for you. Enabling this host option permits installed server plugins to run; review what you install.
4. Ensure `python` resolves to the intended interpreter in the environment that starts SillyTavern. Alternatively set `LONG_MEMORY_PYTHON` to that interpreter's executable path before starting the host.
5. Start SillyTavern, reload its browser page, and find the LongMemory/长期记忆桥接 extension settings. Confirm backend availability before enabling memory or offloading anything.

Keep the host's authentication and CSRF protections enabled. Do not disable CSRF to make an installation or test work.

### Storage and upgrades

By default the backend stores `memory.sqlite3` and `scope.key` in `long-memory-bridge/` beneath the host data root. `LONG_MEMORY_STATE_DIR` can explicitly select another directory. Use a **new, separate directory** for development and smoke tests; never point a test at real chats or an installed memory database. The scope key participates in deriving user/world/chat identities; back it up with the database and do not publish it.

The v0.3 migration adds schema/history data. Reconciliation deactivates evidence without deleting retained canonical bodies. Shut down the host before making a filesystem backup so SQLite WAL state is not omitted. Test upgrades and restore on a copy first. Reverting code does not automatically reverse a database migration.

### First use

1. Start with invented chat content and keep automatic features off.
2. Enable memory, persist a message, and verify full evidence readback before trying offload/restore.
3. For knowledge, select a supported UTF-8 file, review the preview and warnings, and explicitly import it into the intended collection.
4. Search for a distinctive phrase and open its cited message. To snapshot the open chat, use **归档当前聊天（先预览）**, review its preview, and confirm the import. Export the selected collection and try restoring it into an isolated test state directory.
5. Enable knowledge prompt inclusion only if those excerpts may be sent to your selected SillyTavern model provider.

## Privacy and trust

Processing and storage are local to the SillyTavern server and browser; LongMemory has no independent outbound model/API service or automatic media fetching. Your normal model connection can still transmit the prompt, including recalled excerpts you have enabled. “Local” does not mean “encrypted”: imported originals, metadata, history, and backups can contain private information.

SHA-256 detects content changes relative to a known hash. It does **not** prove who authored a document, authenticate a backup, or make imported text trustworthy. Treat recalled material as untrusted evidence, not instructions. See [security](SECURITY.md) before sharing backups or reporting an issue.

The library's export button backs up **only the selected collection in the current user's world scope**, including its retained document revisions. It does not export all collections, the entire SQLite database, scope keys, extension settings, or every chat-memory record. A current-chat snapshot enters a collection only after you explicitly confirm its import. For a complete state backup, stop the host and separately preserve the state directory and relevant host configuration.

## Development and verification

```sh
npm ci
npm run build
npm test
npm audit --audit-level=low
npx playwright install chromium
npm run test:browser
```

On Linux CI, use `npx playwright install --with-deps chromium`. The browser test uses synthetic host shims; it does not establish compatibility with a running SillyTavern release. A separate isolated local smoke test passed against the pinned SillyTavern 1.18.0 checkout, with synthetic content and CSRF enabled; see [the exact evidence and limits](docs/COMPATIBILITY.md). Rerunning it is opt-in and requires `ST_SOURCE`; see [contributing](CONTRIBUTING.md). No benchmark, cross-platform certification, or successful remote CI run is claimed here.

## License and attribution

LongMemory's original code is **AGPL-3.0-only**; see [LICENSE](LICENSE). Selected ThreadShelf modules are vendored under their original **MIT** license from commit [`f13b721561305c3b040dc701ce86553ec36c4447`](https://github.com/ChrystianSchutz/ThreadShelf/tree/f13b721561305c3b040dc701ce86553ec36c4447). The MIT notice remains in `vendor/threadshelf/LICENSE` and the backend distribution's `THREADSHELF-LICENSE.txt`.

`vendor/threadshelf/PROVENANCE.json` records the upstream commit and SHA-256 of selected source files. The build bundles only parser, chunking, and model-label helpers; it does not bundle or run the complete ThreadShelf application. Adapters remain separate from the vendored source. See [changelog](CHANGELOG.md) and [contribution guidance](CONTRIBUTING.md).
