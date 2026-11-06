import type { Registrador } from '../log.js';

/**
 * Lista fechada de clientes de IA (CIMD, DESENHO §5.2 passo 3). O nome exibido no consentimento vem daqui,
 * nunca do `client_name` do documento.
 */
const EXATOS = new Map([
  ['https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude'],
  ['https://claude.ai/oauth/claude-code-client-metadata', 'Claude Code'],
  ['https://chatgpt.com/oauth/codex/client.json', 'Codex'],
]);
const CODEX_COM_ID = /^https:\/\/chatgpt\.com\/oauth\/codex\/[A-Za-z0-9_-]{1,64}\/client\.json$/;

export function nomeDoCliente(clientId: string): string | undefined {
  return EXATOS.get(clientId) ?? (CODEX_COM_ID.test(clientId) ? 'Codex' : undefined);
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;
export const ehLoopback = (uri: string) => LOOPBACK.test(uri);

/** URLs que o provider buscaria a partir do documento: removidas, para a única busca externa ser o próprio CIMD. */
const IGNORADOS = ['jwks_uri', 'jwks', 'sector_identifier_uri', 'logo_uri', 'policy_uri', 'tos_uri', 'client_uri'];

export function sanearCimd(doc: Record<string, unknown>): Record<string, unknown> {
  const saida = { ...doc };
  for (const k of IGNORADOS) delete saida[k];
  const redirects = saida.redirect_uris;
  // O documento do Claude Code não declara application_type; sem `native` a porta variável do loopback é recusada.
  if (
    Array.isArray(redirects) &&
    redirects.length > 0 &&
    redirects.every((u) => typeof u === 'string' && ehLoopback(u))
  ) {
    saida.application_type = 'native';
  }
  return saida;
}

type Busca = (url: string | URL, opcoes?: RequestInit) => Promise<Response>;

/**
 * Hook `fetch` do provider. Recebe as opções dele intactas (prazo de 2,5 s, sem redirect, proteção contra IP de uso
 * especial); só troca o user-agent vazio por um nome e saneia o documento.
 */
export function criarBuscaCimd(busca: Busca = fetch): Busca {
  return async (url, opcoes = {}) => {
    const headers = new Headers(opcoes.headers);
    headers.set('user-agent', 'resgata-mcp');
    const r = await busca(url, { ...opcoes, headers });
    if (r.status !== 200) return r;
    let doc: unknown;
    try {
      doc = await r.json();
    } catch {
      return new Response('{}', { status: 502 });
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return new Response('{}', { status: 502 });
    return Response.json(sanearCimd(doc as Record<string, unknown>));
  };
}

/** Na subida de produção: busca os três documentos e registra o resultado (prova do egress, aceite X1). */
export async function sondarCimd(busca: Busca, log: Registrador): Promise<void> {
  await Promise.all(
    [...EXATOS.keys()].map(async (url) => {
      try {
        const r = await busca(url, { redirect: 'manual', signal: AbortSignal.timeout(3_000) });
        await r.body?.cancel();
        log.info('oauth.cimd_sonda', { client_id: url, status: r.status });
      } catch (e) {
        log.warn('oauth.cimd_sonda', { client_id: url, resultado: 'falha', codigo: (e as Error).name });
      }
    }),
  );
}
