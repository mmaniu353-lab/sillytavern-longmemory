# Security

## Release status and reporting

v0.3.0 is being prepared as the first public release. There is no published support schedule or security-response SLA.

If the repository where you obtained this code offers **Security → Report a vulnerability**, use that private advisory channel. If it does not, open a minimal issue asking for a private reporting channel, without vulnerability details, secrets, or exploit data. No private email address is designated by this document. For ordinary reproducible bugs without sensitive details, use the repository's issue tracker.

A useful private report includes the affected revision, host/Node/Python versions, installation method, an invented minimal input, observed behavior, and the expected security boundary. Never attach real chat exports, character cards, database files, account screenshots, cookies, API keys, `scope.key`, or private backups to a public issue.

## Trust boundaries

- The backend runs as server-side code with the permissions of the SillyTavern process. Install it only on a host you administer. Enabling server plugins is an explicit manual host configuration decision, not a permission granted by installing a browser extension.
- Routes derive ownership from the authenticated SillyTavern user; world, chat, and collection identities scope reads and writes. Client-supplied user identifiers or hashes are not authentication.
- Host authentication and CSRF protection must stay enabled. Do not expose a test host to a network or turn off CSRF to work around setup errors.
- File imports accept explicit text payloads. Linked resources are not automatically downloaded, and the importer is not an arbitrary-path reader or code execution mechanism.
- Imported text and model output are untrusted data. Prompt inclusion is opt-in, but included evidence can still contain prompt-injection text. Do not treat a search hit as an instruction or authorization.

## Private data and integrity

Canonical SQLite records retain original text, supported metadata, and revision history. Reconciliation and offloading are not secure erasure. A library export includes the selected collection's private original documents and historical revisions, not only the currently visible search result; it is not an entire-database backup. Current-chat snapshots require preview and explicit import confirmation. The database and exports are not encrypted by this project; protect them with host access controls and your own backup policy.

SHA-256 acknowledgments and archive hashes check content integrity relative to the expected digest. They are not signatures, proof of provenance, proof of authenticity, or an authorization boundary: anyone able to change a backup can also recalculate an unkeyed hash. Retain a trusted original when provenance matters.

LongMemory processes data locally and does not independently contact a model API or download media. SillyTavern's selected model provider can receive recalled chat and knowledge excerpts when those features are enabled. Local processing does not prevent that normal generation traffic.

## Installation, upgrades, and tests

Use Node 22+ and Python 3.11+ from an intended interpreter. Review vendored-source provenance and license notices. Keep development dependencies out of a runtime-only copy unless the host requires them for another reason.

Stop the host before backing up or replacing its database files; a live SQLite database may have required data in its WAL file. Preserve `scope.key` with the state directory. Copy existing data to an isolated directory before testing a migration or restore. Additive migration does not imply safe downgrades.

All automated fixtures must be synthetic. Browser-shim checks and optional actual-host smoke checks must use new temporary data/state directories and a loopback-only host. Never point `LONG_MEMORY_STATE_DIR` or a test host at a real installation's memory, chat, or account directories.
