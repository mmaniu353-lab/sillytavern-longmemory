# Contributing

Keep changes focused, preserve original text, and test against the host when a change depends on host behavior. Unit and browser-shim tests do not establish SillyTavern compatibility.

## Local setup

Use Node 22+ and Python 3.11+ with standard-library SQLite. A Python virtual environment is optional; there are no application Python package dependencies. To select an interpreter, set `LONG_MEMORY_PYTHON` to its executable path in the shell running tests or SillyTavern.

```sh
npm ci
npm run build
npm test
npm audit --audit-level=low
npx playwright install chromium
npm run test:browser
```

On a Linux machine missing browser system dependencies, use `npx playwright install --with-deps chromium` with the appropriate system-package permissions. CI targets `ubuntu-latest` and `windows-latest`, Node 22/24, and Python 3.11. Remote matrix results are still pending.

`npm test` runs the Node tests followed by Python unittest discovery through `scripts/test-python.mjs`. `npm run test:browser` is the synthetic browser/host-shim suite. Neither should use real conversations, existing account state, or a production database. Audit includes development and production dependencies; do not substitute an `--omit=dev` result for the full check.

After these checks, CI uploads only the top-level build payload files matched by `dist/extension/*`, `dist/plugin/*`, and `dist/LICENSE`. Artifact names identify OS and Node version. Logs, screenshots, test-state directories, keys, and databases are not upload paths. Build artifacts still need source and license review before release.

## Host smoke test (opt-in)

`npm run test:host` is separate from the default suite and CI. It requires `ST_SOURCE` to identify an explicitly supplied SillyTavern 1.18.0 source checkout at commit `51ad27fb86d39a3daca3adaa970375c9670c12df`, with its host dependencies available. The script rejects other commits and copies tracked source through an archive into a fresh temporary host tree. Inspect the script before running it. Use a disposable checkout with synthetic content and a new temporary data/state root, not a running personal installation.

Example environment setup:

```sh
ST_SOURCE=/absolute/path/to/disposable/SillyTavern npm run test:host
```

```powershell
$env:ST_SOURCE = 'C:\absolute\path\to\disposable\SillyTavern'
npm run test:host
```

Keep host route/session and CSRF protections enabled, bind the smoke host to loopback, and close it after testing. The existing harness uses a fresh default-user installation with account login disabled; its cookie/CSRF checks do not verify multi-user login deployments. If the checkout or runtime is unavailable, report the test as not run. Record the host tag/commit, Node/Python versions, command, and result when reporting compatibility. Do not substitute shim results or download and start an unspecified host in CI.

## Source map

| Area | Responsibility |
|---|---|
| `extension/` | Browser settings, persistence acknowledgments, prompt integration, and read-only library UI |
| `plugin/index.cjs` | Server-plugin entry, authenticated routing, local worker lifecycle |
| `plugin/memory_store.py` | Original chat text, revisions, migration, bounded retrieval |
| `plugin/vault_store.py` | Original library documents/history, search, index rebuilding, export/restore |
| `plugin/normalize.cjs` | Explicit file adapters and projection warnings |
| `vendor/threadshelf/` | Pinned upstream MIT source and provenance |
| `scripts/build.mjs` | Bundling and separate extension/backend distribution payloads |
| `tests/` | Invented Node/Python/browser/host fixtures |

## Change requirements

- Add a regression that fails for the behavior being changed, then implement the fix and run the affected suite plus the full checks above.
- Never truncate original text to meet a retrieval or prompt budget. Limit derived chunks, candidates, summaries, and prompt excerpts separately.
- Validate complete batches and quotas before committing. Writes to stored originals and derived indexes must remain all-or-nothing.
- Scope every route and database query to the authenticated user and intended world/chat/collection. Test cross-user and cross-chat denial, not only successful reads.
- Keep CSRF and authentication protections intact. Do not log private request bodies or include them in generic error messages.
- Preserve original raw text and report anything excluded from searchable text. Hashes detect changes; do not describe them as signatures or proof of authorship.
- Keep automatic import, automatic offload, and knowledge prompt inclusion disabled by default.
- Use temporary SQLite/state directories and synthetic account/chat content. Never initialize or migrate a real installation as a development check.
- Do not commit generated `dist/`, dependency directories, SQLite/WAL files, scope keys, secrets, private exports, or screenshots containing private content.

## Vendored code and licensing

Original project code is AGPL-3.0-only. Selected ThreadShelf files retain their MIT license. The current pin is `f13b721561305c3b040dc701ce86553ec36c4447`; see `vendor/threadshelf/PROVENANCE.json` and the upstream notice.

Keep adapters separate from vendored source. An upstream update must identify the exact replacement commit, review source and license changes, update provenance, rebuild, and exercise every claimed provider structure. Do not silently change the parser pin or imply that an old fixture certifies a provider's current export format.

Before a release, check source/artifact allowlists, notices, manifests, installation paths, archive roundtrip, fresh/migration tests, negative security cases, and host smoke results. Update the changelog with results actually observed; do not invent dates, test counts, performance numbers, or compatibility claims.
