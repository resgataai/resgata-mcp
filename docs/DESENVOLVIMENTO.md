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
| `MCP_DISABLED_TOOLS` | nomes de ferramentas desligadas, separados por vírgula |
| `MCP_TRUST_PROXY_HOPS` | saltos de proxy confiáveis para o IP do cliente (padrão 0) |
| `PORT`, `LOG_LEVEL` | porta (8080) e nível de log (`info`) |

## Rotas

| Rota | Função |
|---|---|
| `POST /mcp` | MCP sem sessão (2026-07-28 e 2025-11-25); exige Bearer do MCP; 60 chamadas/min por grant |
| `GET /.well-known/oauth-protected-resource/mcp` | metadados do recurso (RFC 9728) |
| `/.well-known/oauth-authorization-server`, `/oauth/*` | servidor de autorização (P3); 30 req/min por IP em `/oauth/*` |
| `GET /readyz` | só o processo (rotas montadas, chaves carregadas); nunca depende da V2 |
| `GET /healthz` | vivo; `?detalhe=1` testa a V2 e o IdP (503 se algum falhar) |
| `GET /metrics` | Prometheus (não exposta na borda) |

## Estrutura e quem mexe onde

As frentes do incremento 1 trabalham em paralelo; cada uma é dona de um diretório e só toca o contrato do outro por
interface.

| Caminho | Conteúdo | Dono |
|---|---|---|
| `src/config.ts`, `src/log.ts`, `src/limites.ts`, `src/servidor.ts`, `src/iniciar.ts`, `src/principal.ts` | esqueleto | P2 |
| `src/oauth/tipos.ts` | contrato `ServidorAutorizacao` e `ExtraDoToken` (o que o verificador põe em `AuthInfo.extra`) | P2 → P3 |
| `src/oauth/*` | servidor de autorização (`oidc-provider`, CIMD, adaptador da V2, Keycloak, consentimento, revogador) | P3 |
| `src/v2/tipos.ts` | contrato `ClienteV2`, `PedidoV2`, `ErroV2` | P2 → P4 |
| `src/v2/contrato.ts`, `contrato/operacoes-v2.json` | manifesto das operações da V2 e drift | P2 → P4 |
| `src/v2/cliente.ts` | cliente HTTP da V2 (token por grant, escopo efetivo, erros) | P4 |
| `src/mcp/ferramenta.ts`, `src/mcp/servidor-mcp.ts`, `src/mcp/escopos.ts` | tipo `Ferramenta`, handler MCP que filtra por escopo | P2 → P5 |
| `src/mcp/*` (envelope, máscara, plano, cursor, auditoria) e `src/ferramentas/<dominio>.ts` | ferramentas | P5 |
| `src/demo/` | V2 falsa (fixtures em `fixtures.ts`) e IdP falso | P2; P4/P5 acrescentam fixtures |

Para ligar as peças novas, P3 troca `servidorAutorizacaoPendente()` e P4 troca `clienteV2Pendente()` em
`src/iniciar.ts` (uma linha cada). P5 acrescenta os domínios em `src/ferramentas/index.ts`.

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
3. nomes proibidos (`scripts/nomes-proibidos.ts`: a lista guarda só hashes, para o arquivo público não citar nomes);
4. `biome check`;
5. `tsc --noEmit`;
6. `vitest run`;
7. `drift:v2` contra o recorte versionado da OpenAPI da V2 (`contrato/openapi-v2.recorte.json`).

Entram depois: `catalogo:check` (P5) e `@modelcontextprotocol/conformance` (P6).

O `pre-commit` roda `gitleaks --staged` e os nomes proibidos no conteúdo preparado.

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
