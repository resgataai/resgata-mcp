import { ErroV2 } from './tipos.js';

/** Endpoint de token do realm (formato do Keycloak; o IdP falso imita os mesmos caminhos). */
export const urlTokenKeycloak = (issuer: string) => `${issuer}/protocol/openid-connect/token`;

export type TokenCliente = { access_token: string; expires_in: number; refresh_token?: string };

/** POST no endpoint de token com o client confidencial em Basic. Lança `ErroV2`; nunca põe o corpo na mensagem. */
export async function pedirToken(
  tokenUrl: string,
  cliente: { id: string; segredo: string },
  form: Record<string, string>,
): Promise<TokenCliente> {
  let r: Response;
  try {
    r = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(cliente.id)}:${encodeURIComponent(cliente.segredo)}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ErroV2('tentar_novamente', 'servidor de login indisponível', { tentarNovamenteEmS: 30 });
  }
  const corpo = (await r.json().catch(() => ({}))) as Partial<TokenCliente> & { error?: string };
  if (r.ok && typeof corpo.access_token === 'string') {
    return { access_token: corpo.access_token, expires_in: Number(corpo.expires_in ?? 60), ...corpo };
  }
  if (r.status === 400 && corpo.error === 'invalid_grant') {
    throw new ErroV2('reautenticar', 'a sessão no servidor de login acabou', { status: 400 });
  }
  if (r.status >= 500) throw new ErroV2('tentar_novamente', 'servidor de login indisponível', { status: r.status });
  throw new ErroV2('erro_interno', 'servidor de login recusou a credencial do MCP', { status: r.status });
}

/** Lê o corpo da V2 sem quebrar em corpo vazio ou não JSON. */
export async function lerCorpo(r: Response): Promise<unknown> {
  const texto = await r.text();
  if (!texto) return undefined;
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return undefined;
  }
}

/** Tira o envelope `ApiResponse` ({success, data, …}) quando houver. */
export function semEnvelope(corpo: unknown): unknown {
  if (corpo && typeof corpo === 'object' && 'success' in corpo && 'data' in corpo)
    return (corpo as { data: unknown }).data;
  return corpo;
}

export type CredencialServico = {
  /** Chamada interna da V2 (`/v2/internal/mcp/**`) com o token de serviço; devolve o corpo sem envelope. */
  chamar<T = unknown>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown, requestId?: string): Promise<T>;
};

/**
 * Credencial `resgata-mcp-svc` (client_credentials, escopos padrão `mcp:oauth-store` e `mcp:audit`): só o armazém
 * OAuth e a auditoria. Token em memória até 30 s antes de vencer, com uma renovação por vez.
 */
export function criarCredencialServico(o: {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  agora?: () => number;
}): CredencialServico {
  const agora = o.agora ?? Date.now;
  let atual: { token: string; venceEm: number } | undefined;
  let emCurso: Promise<string> | undefined;

  const token = async (): Promise<string> => {
    if (atual && atual.venceEm - 30_000 > agora()) return atual.token;
    emCurso ??= pedirToken(
      o.tokenUrl,
      { id: o.clientId, segredo: o.clientSecret },
      { grant_type: 'client_credentials' },
    )
      .then((t) => {
        atual = { token: t.access_token, venceEm: agora() + t.expires_in * 1000 };
        return t.access_token;
      })
      .finally(() => {
        emCurso = undefined;
      });
    return emCurso;
  };

  return {
    async chamar<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown, requestId?: string): Promise<T> {
      const t = await token();
      let r: Response;
      try {
        r = await fetch(`${o.baseUrl}${caminho}`, {
          method: metodo,
          headers: {
            authorization: `Bearer ${t}`,
            accept: 'application/json',
            ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
            ...(requestId ? { 'x-request-id': requestId } : {}),
          },
          ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new ErroV2('tentar_novamente', 'plataforma indisponível', { tentarNovamenteEmS: 30 });
      }
      const dados = await lerCorpo(r);
      if (r.ok) return semEnvelope(dados) as T;
      if (r.status === 401) atual = undefined;
      if (r.status === 404) throw new ErroV2('nao_encontrado', 'registro interno não encontrado', { status: 404 });
      if (r.status >= 500 || r.status === 401) {
        throw new ErroV2('tentar_novamente', 'plataforma indisponível', { status: r.status });
      }
      throw new ErroV2('erro_interno', 'a plataforma recusou a chamada interna do MCP', { status: r.status });
    },
  };
}
