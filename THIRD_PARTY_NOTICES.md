# Third-party notices

Duc's Table source code is licensed under the Apache License 2.0. A compiled
application is an aggregate that also contains or interoperates with third-party
components governed by their own licenses or service terms. Those terms continue
to apply to the corresponding components; this document does not replace them.

Exact versions are recorded in `go.sum`, `frontend/package-lock.json`, and
`ai-sidecar/package-lock.json`. License files shipped by npm packages remain in
their package directories in the application bundle. Project and required
upstream Apache attributions are also recorded in `NOTICE`.

## Bundled runtimes and AI providers

- **Node.js** is distributed under the MIT License and includes software under
  additional compatible licenses. The complete Node.js license and attribution
  text is copied into packaged applications as `NODE_LICENSE`.
- **OpenAI Codex** (`@openai/codex` and its platform package) is licensed under
  Apache-2.0. Its upstream NOTICE includes: OpenAI Codex, Copyright 2025 OpenAI;
  code derived from Ratatui, Copyright 2016–2022 Florian Dehau and Copyright
  2023–2025 The Ratatui Developers, under the MIT License.
- **Anthropic Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` and its
  platform package) is Copyright Anthropic PBC, all rights reserved. Its use is
  subject to Anthropic's legal agreements, including the Commercial Terms of
  Service. It is not licensed under the Duc's Table Apache-2.0 license.

The AI assistant is optional at runtime and requires the user to authenticate
directly with the selected provider. Provider services, accounts, models, data
handling, and trademarks are governed by the provider's own terms and policies.

Upstream references:

- Node.js: <https://github.com/nodejs/node>
- OpenAI Codex: <https://github.com/openai/codex>
- Anthropic Claude Agent SDK: <https://github.com/anthropics/claude-agent-sdk-typescript>

## Primary application dependencies

- DuckDB and `duckdb-go` — MIT License.
- Wails — MIT License.
- Excelize — BSD 3-Clause License.
- 99designs/keyring — MIT License.
- React, CodeMirror, Radix UI, AG Grid Community, Zustand, react-markdown, and
  most supporting frontend packages — primarily MIT License.
- class-variance-authority and selected supporting packages — Apache-2.0.
- lucide-react — ISC License.
- Zod — MIT License.

The DuckDB `postgres`, `excel`, and `mongo` extensions are downloaded on demand
from repositories fixed by the application and are not included in this source
repository. Their upstream licenses and notices apply when installed.

## Trademarks

DuckDB, PostgreSQL, MongoDB, OpenAI, Codex, Anthropic, Claude, Node.js, Wails,
React, AG Grid, and other names may be trademarks of their respective owners.
Use of those names describes compatibility or integration and does not imply
endorsement or affiliation.
