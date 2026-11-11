# Source and license notices

LongMemory original integration code is distributed under AGPL-3.0-only. Copyright 2026 LongMemory contributors. The owner has authorized public release of the commissioned local code. This does not transfer or replace any upstream copyrights.

Selected ThreadShelf modules are MIT licensed, copyright 2026 Chrystian Schutz. Exact upstream commit: `f13b721561305c3b040dc701ce86553ec36c4447`, package version 1.4.1. Original files are unchanged in `vendor/threadshelf/`; `PROVENANCE.json` records their SHA-256 hashes. The complete MIT notice is retained in `vendor/threadshelf/LICENSE` and `plugin/THREADSHELF-LICENSE.txt`; generated parser code also carries attribution. Source adapters and storage integration are separate LongMemory changes, not upstream endorsements.

SillyTavern is a separate host application under its own AGPL terms. This repository does not distribute the host, user data, models or character cards. Development dependencies retain their own licenses in their packages/lockfile; they are not shipped as runtime dependencies in the extension/backend payload.

No ThreadShelf model service, LanceDB store, React application or MCP implementation is bundled. No affiliation with or endorsement by SillyTavern, ThreadShelf or OpenAI is implied.

The v0.3.0 interface review used design guidance from [unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky (@heydamir), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). LongMemory's changes replace decorative gradients, glows and emoji labels with host-theme panels and plain action labels. The unslop skill is not bundled as runtime code, and its author does not endorse this project.
