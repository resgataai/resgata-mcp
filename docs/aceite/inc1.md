# Aceite do incremento 1

Estado em 06/11/2026: **parte local feita** (P6, abaixo). O aceite com os clientes reais (Claude.ai, Claude Code e
Codex) acontece depois da publicação, no roteiro da seção 3, e os resultados entram aqui. Nada nesta página tem dado
pessoal: só usuários e clientes sintéticos do modo demonstração.

## 1. O que foi provado localmente

Ambiente: Node 24.21 (vitest 5.0.5) e Bun 1.4.2 lendo o `bun.lock` do Bun 1.3.12; a mesma suíte também passou em
Node 22.23.4 (contêiner Linux, dependências instaladas pelo Bun 1.3.12), exceto o teste das regras do gitleaks, que
precisa do binário. Serviço montado por `iniciar()` em modo demonstração (mesma ligação da produção, com a plataforma e
o servidor de login simulados). A imagem do `Dockerfile` sobe em modo demonstração com Node 22 e usuário sem root.

| Prova | Onde | Resultado |
|---|---|---|
| Fluxo OAuth completo: documento CIMD do Claude Code e do Codex, login no servidor de login, tela de autorização, troca do código com PKCE S256, token de 10 min com `grant_id` | `test/ponta-a-ponta.test.ts` | passa |
| Ferramentas reais depois do login: a plataforma recebe o token do próprio usuário, gerado a partir do refresh offline que o servidor de autorização gravou cifrado | idem | passa |
| `tools/list` com 26 ferramentas (efeitos desligados: `contato_executar` fora da lista) | idem | passa |
| Uma linha de auditoria por chamada, com usuário, grant, cliente e `request_id` | idem | passa |
| Renovação: refresh rotativo devolve token novo que funciona em `/mcp` | idem | passa |
| Isolamento A × B: dois usuários com 15 chamadas cada, em paralelo; toda chamada à plataforma usa o token do dono do grant (cruzando o `request_id` da auditoria com a chamada); B sem o papel de contato não vê `contato_*` e recebe 403 `insufficient_scope` ao forçar | idem | passa |
| Renovação concorrente por **dois processos** com o mesmo refresh: um recebe 200, o outro `invalid_grant`; o grant continua ativo e o refresh novo funciona | idem | passa |
| Refresh reapresentado em menos de 30 s não revoga; depois de 30 s revoga o grant e conta `mcp_refresh_reuse_total` | `test/oauth.test.ts` | passa |
| Link de autorização aberto por outra pessoa sempre passa por login e autorização; sem `MCP_ACCESS` (mesmo com `ADMIN`) a autorização é recusada | idem | passa |
| `/oauth/revoke` revoga o grant na plataforma e o varredor encerra a sessão offline no servidor de login | idem | passa |
| Papel `MCP_CONTACT` retirado no servidor de login: `contato_*` some na renovação seguinte e a chamada forçada recebe 403; `MCP_ACCESS` retirado: grant revogado e 401; usuário desativado: grant revogado | `test/ferramentas.test.ts` | passa |
| `contato_planejar` + `contato_executar` concorrentes para o mesmo cliente e modelo: 1 envio | idem | passa |
| Ferramenta com efeito grava `accepted` antes do efeito e a linha final (`ok`, `replayed` ou `error`) com o mesmo `request_id`; plano das 23h50 executado às 23h59 e de novo às 00h01: mesma chave (dia da prévia), 1 envio | idem | passa |
| Lote JSON-RPC em `/mcp` → 400 sem executar nada; fila de auditoria cheia → `ocupado` sem executar e nenhuma linha descartada; `Host` fora da lista → 421; `/oauth/token` limitado por cliente + credencial, não por IP | `test/servidor.test.ts` | passa |

Rodar: `bun run gate` (inclui os testes acima).

### Conformidade MCP (`@modelcontextprotocol/conformance` 0.1.16)

Rodada manual, fora do gate (o pacote tem dependências com faixa de versão e não entra no `bun.lock`):
`bun scripts/conformidade.ts` sobe o modo demonstração, faz o login e imprime um endereço local que acrescenta o
Bearer; depois `npx @modelcontextprotocol/conformance@0.1.16 server --url <endereço> --scenario <cenário>`.

| Cenário | Resultado | Observação |
|---|---|---|
| `server-initialize`, `ping`, `tools-list` | passa | |
| `server-sse-polling` | 0 falhas, 3 avisos | o servidor não usa sessão nem SSE retomável (sem estado por desenho) |
| `dns-rebinding-protection` | passa (2 de 2) | o servidor confere o cabeçalho `Host` (host de `MCP_PUBLIC_URL`; no modo demonstração, `localhost` e `127.0.0.1`) e responde 421 aos outros |
| `tools-call-*`, `json-schema-2020-12`, `logging-set-level`, `completion-complete`, `resources-*`, `prompts-*` | não se aplica | exigem as ferramentas de teste do servidor de referência ou capacidades que este servidor não anuncia |

## 2. O que ainda não foi provado

- Clientes reais: Claude.ai (conector), Claude Code e Codex, inclusive o que cada um faz com o `invalid_grant` da
  renovação concorrente e se `claude mcp logout` e `codex mcp logout` revogam no servidor.
- Servidor de login real (não só o simulado): `offline_access`, papéis no token de acesso, `auth_time` e parâmetro `iss`.
- Busca dos documentos CIMD a partir do ambiente de produção.

## 3. Roteiro do aceite com clientes reais (depois da publicação)

1. Claude Code: `claude mcp add --transport http --scope user resgata https://mcp.resgata.ai/mcp`, depois
   `claude mcp login resgata`. Conferir: login, tela de autorização com "Claude Code" e aviso de aplicativo local,
   `/mcp` mostra conectado, "Quem sou eu na Resgata?" chama `resgata_quem_sou`.
2. Codex: `codex mcp add resgata --url https://mcp.resgata.ai/mcp`, `codex mcp login resgata`, e
   `default_tools_approval_mode = "writes"` em `[mcp_servers.resgata]`. Mesmas conferências.
3. Claude.ai: conector personalizado com "Use Claude's published identity"; conectar e repetir a pergunta.
4. Lista de ferramentas igual ao perfil; `contato_executar` ausente enquanto os efeitos estiverem desligados.
5. Esperar mais de 10 min e chamar de novo: funciona sem novo login (prova da renovação no Codex).
6. Duas sessões do Claude Code e CLI + extensão do Codex renovando juntas: registrar aqui o que cada cliente faz.
7. `claude mcp logout resgata` e `codex mcp logout resgata`: registrar se revogam (o painel mostra revogado).
8. "Desconectar" no painel → próxima chamada recebe 401 em até 30 s.
9. Com os efeitos ligados: "mande o modelo X por e-mail ao cliente de teste", executar, repetir, pedir de novo com
   outras palavras → um único envio; `contato_status` mostra o resultado.
