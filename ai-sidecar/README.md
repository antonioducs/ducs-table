# DUCS Table AI sidecar

Processo Node.js/TypeScript isolado que conversa com o host por JSONL em `stdin`/`stdout`. Cada linha é um objeto JSON-RPC simplificado (`id`, `method`, `params`); respostas usam `id` com `result` ou `error`.

Métodos do host para o sidecar:

- `status`, `login`, `logout`, `models` com `params.provider` (`codex` ou `claude`);
- `chat.start` com `provider`, `prompt`, `model`, `cwd` e, opcionalmente, `chatId`, `sessionId`, `systemPrompt`, `reasoningEffort` e `tools`;
- `chat.cancel` com `chatId` (e `provider` opcional);
- `chat.disposeSession` com `provider` e `sessionId`.

O streaming sai em notificações `chat.event` com `{ chatId, provider, event }`. Ferramentas são chamadas pelo sidecar com uma requisição reversa `tool.call`; o host deve responder `{ output }` ou `{ error, isError: true }` usando o mesmo `id`.

Os perfis ficam sob `DUCS_AI_HOME` (padrão `~/.ducs-table/ai-sidecar`). `DUCS_CODEX_BINARY` e `DUCS_CLAUDE_BINARY` permitem sobrescrever executáveis em desenvolvimento. Os subprocessos recebem ambientes sanitizados; Codex usa `CODEX_HOME` próprio e Claude usa `CLAUDE_CONFIG_DIR` próprio.
