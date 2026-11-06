# Desenvolvimento

Guia para quem mexe no código. Para usar o MCP, veja o [README](../README.md) e o [INSTALAR.md](../INSTALAR.md).

## Primeiros passos

Requisitos: [Bun](https://bun.sh) 1.3.12 ou mais novo, Node 22 e [gitleaks](https://github.com/gitleaks/gitleaks)
8.30 ou mais novo.

```bash
bun install            # instala as dependências e liga os hooks (.githooks) pelo script "prepare"
bun run dev:demo       # sobe o servidor em modo demonstração em http://localhost:8080
bun run gate           # tudo o que o pre-push roda
```

`trustedDependencies` é uma lista vazia: nenhum script de dependência roda no `bun install`. O gate e o `Dockerfile`
usam `bun install --frozen-lockfile --ignore-scripts`.

## Modo demonstração

`MCP_MODO=demo` sobe, só em `127.0.0.1`, uma V2 falsa (`src/demo/v2-falsa.ts`) e um IdP falso
(`src/demo/idp-falso.ts`), com dados 100% sintéticos e chaves efêmeras. Nenhuma credencial é necessária e nada sai da
máquina. Por segurança, o processo **recusa subir** em modo demo se `V2_API_BASE_URL` ou qualquer `KEYCLOAK_*` estiver
definida, ou se `MCP_PUBLIC_URL` for o endereço de produção.

## Configuração (produção)

Tudo por variável de ambiente, validado na subida (`src/config.ts`); a mensagem de erro cita só o nome da variável.
Nenhum endereço tem valor padrão.

| Variável | O que é |
|---|---|
| `MCP_MODO` | `producao` (padrão) ou `demo` |
| `MCP_PUBLIC_URL`, `MCP_RESOURCE` | endereço público (https) e a URI do recurso (`MCP_PUBLIC_URL` + `/mcp`) |
| `V2_API_BASE_URL` | base da API da Resgata |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | login das pessoas |
| `KEYCLOAK_SVC_CLIENT_ID`, `KEYCLOAK_SVC_CLIENT_SECRET` | credencial de serviço (armazém OAuth e auditoria) |
| `MCP_JWKS` | JWKS com a chave privada ES256 (com `kid`) que assina os tokens do MCP |
| `MCP_COOKIE_KEYS` | chaves dos cookies da interação, separadas por vírgula |
| `MCP_UPSTREAM_KEY`, `MCP_PLAN_KEY`, `MCP_CURSOR_KEY`, `MCP_AUDIT_HMAC_KEY` | 32 bytes em base64url cada |
| `MCP_EFFECTS_ENABLED` | `false` (padrão): ferramentas com efeito externo somem do catálogo |
| `MCP_TRANSCRIPTS_ENABLED` | `false` (padrão): mensagens de atendimento ficam fora do contexto da IA (`atendimento_mensagens` responde `indisponivel_por_gate`) |
| `MCP_DISABLED_TOOLS` | nomes de ferramentas desligadas, separados por vírgula |
| `MCP_TRUST_PROXY_HOPS` | saltos de proxy confiáveis para o IP do cliente (padrão 0). **Em produção, defina com o número de saltos do balanceador de carga externo** (os endereços que ele acrescenta ao `X-Forwarded-For`): com 0, todas as requisições parecem vir do balanceador e o limite por IP das telas de login vira um limite global |
| `MCP_PROVEDORES_JSON` | nós do `diagnostico_provedor` (lista JSON que substitui o padrão; vazio = padrão). Nomes reais de provedores, apelidos e códigos da V2 só chegam por aqui, nunca pelo código; o padrão público tem só o nó genérico "provedor bancário". Formato abaixo |
| `PORT`, `LOG_LEVEL` | porta (8080) e nível de log (`info`) |

Formato de `MCP_PROVEDORES_JSON` (valores fictícios; a subida recusa campo desconhecido, `id` repetido ou relação
fora da lista, e a mensagem de erro cita só a variável e a regra):

```json
[
  { "id": "provedor_bancario", "rotulo": "provedor bancário (integração direta)", "relacao": "direto",
    "apelidos": ["nome do parceiro", "outro apelido"], "codigos": ["CODIGO_NA_V2"] },
  { "id": "banco_a", "rotulo": "Banco A (a montante, observado via provedor bancário)", "relacao": "a_montante",
    "apelidos": ["banco a"] },
  { "id": "orgao_x", "rotulo": "Órgão X (dependência indireta, sem telemetria própria)", "relacao": "indireto",
    "apelidos": ["orgao x"] }
]
```

`relacao`: `direto` (telemetria própria, achada pelos `codigos` = `providerCode` da V2), `a_montante` (só agregado no
provedor direto) ou `indireto` (sem telemetria). Apelidos casam como palavra inteira, sem diferença de maiúscula ou
acento.

## Rotas

| Rota | Função |
|---|---|
| `POST /mcp` | MCP sem sessão (2026-07-28 e 2025-11-25); exige Bearer do MCP; 60 chamadas/min por grant; **uma mensagem JSON-RPC por requisição** (lote → 400, código -32600) |
| `GET /.well-known/oauth-protected-resource/mcp` | metadados do recurso (RFC 9728) |
| `/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/jwks` | servidor de autorização (`oidc-provider`, só CIMD da lista fechada, sem DCR) |
| `GET /oauth/interacao/:uid`, `GET /oauth/keycloak/callback`, `POST /oauth/interacao/:uid/decisao` | login no IdP (`max_age=300`) e tela de consentimento, sempre |
| `GET /readyz` | só o processo (rotas montadas, chaves carregadas); nunca depende da V2 |
| `GET /healthz` | vivo; `?detalhe=1` testa a V2 e o IdP (503 se algum falhar) |
| `GET /metrics` | Prometheus (não exposta na borda) |

Limites em memória por pod: 30 req/min **por IP** só nas rotas de navegador (`/oauth/authorize`, `/oauth/interacao/*`,
`/oauth/keycloak/callback`); `/oauth/token` e `/oauth/revoke` chegam dos servidores dos clientes de IA, por IPs
compartilhados, e contam 10 req/min **por cliente + credencial** (refresh, código ou token a revogar, ou seja, um
grant); `/mcp` conta por grant.

Cabeçalho `Host` (proteção contra DNS rebinding): só o host de `MCP_PUBLIC_URL` e, no modo demonstração, também
`localhost` e `127.0.0.1`; outro host recebe 421. `/healthz`, `/readyz` e `/metrics` não conferem o `Host`, porque as
sondas e o coletor chamam pelo IP do pod.

Auditoria: com a fila em memória cheia (1 000 linhas), a chamada nova é recusada com `ocupado` (`tentar_novamente`)
antes de executar, em vez de descartar linha. Ferramenta com efeito grava `accepted` antes do efeito (espera o 201) e a
linha final (`ok`, `replayed` ou `error`) com o mesmo `requestId`.

## Estrutura e quem mexe onde

As frentes do incremento 1 trabalham em paralelo; cada uma é dona de um diretório e só toca o contrato do outro por
interface.

| Caminho | Conteúdo | Dono |
|---|---|---|
| `src/config.ts`, `src/log.ts`, `src/limites.ts`, `src/servidor.ts`, `src/iniciar.ts`, `src/principal.ts` | esqueleto | P2 |
| `src/oauth/tipos.ts` | contrato `ServidorAutorizacao` e `ExtraDoToken` (o que o verificador põe em `AuthInfo.extra`) | P2 → P3 |
| `src/oauth/*` | servidor de autorização (`oidc-provider`, CIMD, adaptador da V2, Keycloak, consentimento, revogador) | P3 |
| `src/oauth/cifra.ts` | único AES-256-GCM do refresh offline (`iv ‖ tag ‖ cifrado`, AAD = `uid` ou `grant_id`): o servidor de autorização cifra, o cliente da V2 decifra | P3 → P4 |
| `src/v2/tipos.ts` | contrato `ClienteV2`, `PedidoV2`, `ErroV2` | P2 → P4 |
| `src/v2/contrato.ts`, `contrato/operacoes-v2.json` | manifesto das operações da V2 e drift | P2 → P4 |
| `src/v2/cliente.ts`, `src/v2/servico.ts` | cliente HTTP da V2 (token por grant, escopo efetivo, erros) e credencial de serviço (armazém OAuth e auditoria) | P4 |
| `src/mcp/ferramenta.ts`, `src/mcp/servidor-mcp.ts`, `src/mcp/escopos.ts` | tipo `Ferramenta`, handler MCP que filtra por escopo | P2 → P5 |
| `src/mcp/*` (envelope, máscara, plano, cursor, auditoria, portão de escopo, provedores) e `src/ferramentas/<dominio>.ts` | ferramentas | P5 |
| `src/demo/` | V2 falsa (fixtures em `fixtures.ts`) e IdP falso | P2; P4/P5 acrescentam fixtures |

`src/iniciar.ts` liga o servidor de autorização, o cliente da V2, a auditoria e o portão de escopo (`src/mcp/portao.ts`).
Ferramenta nova entra no arquivo do seu domínio em `src/ferramentas/` e na lista de `src/ferramentas/index.ts`; o
`catalogo:check` confere o resto.

### Servidor de autorização (resumo)

- Toda autorização passa pelo IdP e pela tela de consentimento: a `Session` do `oidc-provider` não é gravada, e a
  interação só termina com login e consentimento juntos, depois da aprovação. O cliente pede o escopo mínimo do PRM; a
  tela mostra o conjunto que os papéis `MCP_*` da pessoa liberam, e o grant fica só com ele.
- O refresh offline do IdP é cifrado no callback (AES-256-GCM, `MCP_UPSTREAM_KEY`, AAD = `uid` da interação) e
  recifrado com AAD = `grant_id` na aprovação. Nunca fica em claro no armazém da V2.
- Token do MCP: JWT ES256 de 10 min com `grant_id`; refresh opaco rotativo de 30 dias; grant de 90 dias. Refresh
  reapresentado em menos de 30 s recebe `invalid_grant` sem revogar; depois disso revoga o grant (`refresh_reuse`),
  incrementa `mcp_refresh_reuse_total` e registra `oauth.reuso_detectado`.
- `/mcp` confere o grant na V2 com cache de 30 s por pod; o varredor (a cada 5 min) revoga no IdP o offline de grants
  revogados ou vencidos e de interações abandonadas.

Regras que valem para todos:

- Log só por `criarLog` (lista positiva). Argumentos de ferramenta entram no log e na auditoria só pela
  `paramsAuditaveis` da ferramenta; dado pessoal como `hmac`.
- Limites e semáforo vêm de `criarLimites()`: o cliente da V2 usa `limites.analiticas` para as operações de
  `OPERACOES_ANALITICAS` e devolve `ocupado` quando não há vaga.
- Fixtures só sintéticas: CPF com prefixo `000.000.` e dígito válido, nomes fictícios, e-mails em `exemplo.invalid`.

## Gate

`bun run gate` (também no `pre-push`), na ordem, parando no primeiro erro:

1. `bun install --frozen-lockfile --ignore-scripts`;
2. `gitleaks` com `.gitleaks.toml` no histórico e na árvore (`scripts/segredos.sh`);
3. nomes proibidos (`scripts/nomes-proibidos.ts`, lista privada; veja abaixo);
4. `biome check`;
5. `tsc --noEmit`;
6. `vitest run`;
7. `catalogo:check`: toda ferramenta aponta para operações do manifesto e o manifesto aponta de volta; efeito só
   sobre operação com `Idempotency-Key` obrigatória e anotado como destrutivo; leitura anotada como só leitura;
   exemplos presentes;
8. `drift:v2` contra o recorte versionado da OpenAPI da V2 (`contrato/openapi-v2.recorte.json`).

Entra depois: `@modelcontextprotocol/conformance` (P6).

O `pre-commit` roda `gitleaks --staged` e os nomes proibidos no conteúdo preparado.

### Nomes proibidos

Nomes de parceiros comerciais não aparecem no repositório público, nem como hash (um hash sem sal de uma palavra se
confirma por dicionário). A lista é privada: um nome ou expressão por linha, `#` comenta, sem diferença de maiúscula ou
acento. O script lê o arquivo indicado em `NOMES_PROIBIDOS_ARQUIVO` (de preferência fora do repositório) ou, sem a
variável, `.nomes-proibidos` na raiz do repositório (ignorado pelo git e pelo Docker).

Sem lista, a checagem é **pulada com aviso** (quem clona o repositório não tem a lista). Com
`NOMES_PROIBIDOS_OBRIGATORIO=1`, ou com `NOMES_PROIBIDOS_ARQUIVO` apontando para arquivo ausente ou vazio, a falta da
lista é **erro**: o build de release roda assim, com a lista fornecida pelo repositório privado de infraestrutura.

### Drift da V2

```bash
bun run drift:v2                                         # manifesto × recorte versionado (sem rede)
bun run drift:v2 --fonte https://api.resgata.ai/v3/api-docs   # manifesto × OpenAPI publicada (fora do ar = aviso)
bun run drift:v2 --atualizar openapi.json [outra-parte.json…]  # regrava o recorte a partir da OpenAPI completa
```

O recorte guarda só operationId, método, caminho e nomes de parâmetro das operações do manifesto. Operação nova que a
V2 ainda não publicou leva `"pending": true` no manifesto e gera só aviso.

## Imagem

`Dockerfile` em três estágios: build com Bun (lockfile congelado, sem scripts), dependências de produção e runtime
`node:22-alpine` sem root. Imagens base fixadas por digest.

## Regras do repositório público

Nada de segredo, dado pessoal, endereço ou nome interno, nome de parceiro comercial ou configuração de produção. PR
de terceiro nunca é executado na máquina de quem tem acesso a produção: o diff é lido e a mudança recriada numa branch
própria. Segurança: [SECURITY.md](../SECURITY.md).
