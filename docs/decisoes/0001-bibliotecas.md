# 0001 — Bibliotecas do servidor (spike P1)

Data: 06/11/2026. Estado: **aceita**. Plano B e plano C do servidor de autorização **não** são necessários.

## Decisão

| Pacote | Versão (exata, travada no `bun.lock`) | Papel |
|---|---|---|
| `@modelcontextprotocol/server` | 2.4.0 | servidor MCP sem sessão (`createMcpHandler`) |
| `express` | 5.3.0 | HTTP |
| `oidc-provider` | 9.13.3 | servidor de autorização (CIMD, PKCE, rotação de refresh) |
| `openid-client` | 6.8.9 | login no IdP da Resgata |
| `jose` | 6.2.15 | JWT/JWE |
| `zod` | 4.6.7 | configuração e schemas das ferramentas |
| `pino` | 10.4.0 | log |
| `prom-client` | 15.1.3 | métricas |

`@modelcontextprotocol/express` 2.0.2 (`requireBearerAuth`) saiu na integração: o 401 com `resource_metadata` e o
escopo mínimo é montado com `verifyBearerToken` e `bearerAuthChallengeResponse` do `@modelcontextprotocol/server`.

Desenvolvimento: `typescript` 6.0.3, `vitest` 5.0.5, `@biomejs/biome` 2.6.3, `@types/node` 22.20.5,
`@modelcontextprotocol/client` 2.4.0 (só testes). Ferramentas de desenvolvimento ficaram em versões com pelo menos
duas semanas de publicação; as de runtime são as do desenho.

Gerenciador: Bun 1.3.12 (`packageManager`), `trustedDependencies: []` (nenhum script de dependência roda) e
`--ignore-scripts` no gate e no `Dockerfile`. O `bun.lock` foi gerado com o Bun 1.3.12 (formato 1); o Bun 1.4 lê esse
formato com `--frozen-lockfile` sem regravar. Runtime: Node 22.

## Como foi testado

Num diretório descartável, fora do repositório: um script com o `oidc-provider` configurado como no desenho, os três
documentos CIMD reais buscados na internet, um adaptador em memória que registra as chamadas e a janela de 30 s, e
um script com o SDK MCP atrás do `express`, exercitado pelo cliente oficial nas duas versões do protocolo. Rodado no
Node 24.21 local e no Node 22.23.4 (`node:22-alpine`), com o mesmo resultado: 21 de 21 checagens do servidor de
autorização e 4 de 4 do MCP.

## Resultado por item

| # | Item | Resultado |
|---|---|---|
| 1 | CIMD dos três clientes (`claude.ai/oauth/mcp-oauth-client-metadata`, `claude.ai/oauth/claude-code-client-metadata`, `chatgpt.com/oauth/codex/client.json`) | **OK com ajuste.** Feature `clientIdMetadataDocument` (experimental, `ack: 'draft-02'`), `allowFetch` com a lista exata. Dois ajustes obrigatórios, ver "Configuração que o P3 precisa" itens a e b |
| 2 | `token_endpoint_auth_methods_supported` do Codex | **OK, sem `rpMetadataChoices`.** O documento é aceito com a feature desligada (metadado desconhecido é ignorado). Recomendação: deixar `rpMetadataChoices` desligada (menos superfície) |
| 3 | Pedido de autorização **sem** `openid` | **OK.** Código emitido, `iss` na resposta (RFC 9207) |
| 4 | Refresh sem `offline_access` | **OK** com `issueRefreshToken: () => true` **e** `expiresWithSession: () => false`. Sem o segundo, o refresh morre junto com a sessão (que dura só a interação) |
| 5 | Node 22 | **OK** (22.23.4) |
| 6 | `defaultResource` = URI do MCP | **OK.** Refresh sem `resource` devolve JWT ES256 com `aud` = URI do MCP |
| 7 | `requestObjects` e `request_uri` | **OK.** Desligados: `request` → `request_not_supported`; `request_uri` → `request_uri_not_supported`, sem busca de URL. Metadados anunciam `request_uri_parameter_supported=false` |
| 8 | `jwks_uri`, `sector_identifier_uri`, `logo_uri` do CIMD ignorados | **Não por padrão.** O `oidc-provider` busca `sector_identifier_uri` ao montar o cliente. Resolvido pelo hook `fetch` (item c) |
| 9 | `/oauth/revoke` de um refresh | **OK.** Chama `revokeByGrantId` do adaptador para `AccessToken`, `RefreshToken` e `AuthorizationCode`, e `destroy` do `Grant`; emite `grant.revoked`. Não precisa de *listener* para o caso comum (ver item e) |
| 10 | Refresh consumido há < 30 s com o adaptador devolvendo "não encontrado" | **OK.** `invalid_grant`, nenhum `revokeByGrantId`, o sucessor continua válido |
| 11 | Refresh consumido há > 30 s | **OK.** `invalid_grant`, `revokeByGrantId` em todos os modelos, `grant.revoked`; o sucessor morre |
| 12 | `Session` com TTL da interação | **OK.** `ttl.Session = ttl.Interaction = 600` gravados assim pelo adaptador |
| 13 | Negativas | CIMD fora da lista → `invalid_client`; `redirect_uri` fora do documento → `invalid_redirect_uri`; `resource` errado → `invalid_target` (com `errors.InvalidTarget`; outro erro vira 500); PKCE `plain` → `invalid_request` |
| 14 | SDK MCP 2.4.0 + express 2.0.2, sem sessão | **OK.** `createMcpHandler(fábrica)` atende cliente 2025-11-25 (pelo modo legado sem estado, `initialize` sem `Mcp-Session-Id`) e 2026-07-28 (versão fixada e negociação `auto`), com `tools/list` e `tools/call`. `requireBearerAuth` sem token → 401 com `resource_metadata` |

## Configuração que o P3 precisa (achados do spike)

a. **Documento do Claude Code sem `application_type`.** O `oidc-provider` o trata como `web` e não aceita a porta
   variável do loopback (`http://localhost:<porta>/callback` → `invalid_redirect_uri`). O documento do Codex declara
   `native` e funciona. Correção testada: no hook `fetch` do provider, quando todos os `redirect_uris` do documento são
   loopback, marcar `application_type: 'native'` antes de devolver o documento.

b. **`id_token_signed_response_alg` padrão é RS256.** Com só a chave ES256, todo CIMD falha com
   `invalid_client_metadata`. Usar `clientDefaults: { id_token_signed_response_alg: 'ES256' }`.

c. **Sanear o CIMD no hook `fetch`.** Remover `jwks_uri`, `jwks`, `sector_identifier_uri`, `logo_uri`, `policy_uri`,
   `tos_uri` e `client_uri` do documento antes de devolvê-lo ao provider. O hook recebe o `dispatcher` com a proteção
   contra IP de uso especial do próprio `oidc-provider`, prazo de 2,5 s, `redirect: 'manual'` e limite de 5 KB para o
   documento; repassar `options` intacto ao `fetch` preserva tudo isso. O nome exibido continua vindo do mapa local.

d. **`loadExistingGrant` não pode simplesmente devolver `undefined`.** Isso prende a interação num laço de
   consentimento, porque o grant recém-aprovado nunca é carregado. Correto: devolver só o grant de
   `ctx.oidc.result.consent.grantId` (o desta interação) e nunca o de uma sessão anterior.

e. **Motivo da revogação.** O provider não diz ao adaptador por que revogou. Distinguir `refresh_reuse` de
   `client_revoked` pelo contexto: revogação dentro do `grant_type=refresh_token` com "already used" é reuso; dentro
   de `/oauth/revoke` é do cliente. O adaptador recebe `revokeByGrantId` uma vez por modelo: deduplicar e chamar a V2
   uma vez por grant.

f. **Consentimento**: o grant precisa de `addOIDCScope` com os escopos de `missingOIDCScope` **e**
   `addResourceScope(recurso, …)` com `missingResourceScopes`, mesmo sem `openid`.

g. **Metadados.** `clientAuthMethods: ['none']` faz o AS anunciar só `none` em `token_endpoint_auth_methods_supported`.
   Sem `registration_endpoint` por padrão. `revocation.allowedPolicy` deve ser definida (o provider avisa quando usa a
   padrão).

h. **`requireBearerAuth` e `scope` no 401.** A opção `requiredScopes` põe `scope=` no desafio, mas também recusa com 403
   todo token sem esses escopos. O desenho quer `scope="resgata:read.bi"` no 401 sem exigir esse escopo de todos:
   o P3 monta o desafio próprio (`bearerAuthChallengeResponse`) ou aceita o 401 sem `scope`.

i. O CIMD do conector do Claude.ai traz o tipo de concessão `jwt-bearer`; o provider filtra o que não suporta, sem erro.

## O que o spike não cobriu

- Busca dos documentos CIMD a partir da rede de produção (o `chatgpt.com` tem proteção contra robôs; o provider manda
  `user-agent` vazio). Fica para o aceite, como o desenho previa.
- Renovação concorrente com clientes reais e `logout` dos clientes: P6.
- `@modelcontextprotocol/conformance` 0.1.16: entra no gate com o P6.
