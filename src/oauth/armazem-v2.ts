/**
 * Cliente do armazém OAuth da V2 (`/v2/internal/mcp/oauth/**`, contrato interno `mcp-oauth-store-v1`), chamado com a
 * credencial de serviço do MCP. A V2 só vê o SHA-256 dos ids e o refresh offline do IdP só cifrado.
 * Respostas no envelope `{ success, data }` da V2; binários (`upstreamCiphertext`) em base64.
 */

export const MODELOS = new Set([
  'Session',
  'Interaction',
  'AuthorizationCode',
  'RefreshToken',
  'Grant',
  'AccessToken',
  'ReplayDetection',
]);
const ID_HASH = /^[A-Za-z0-9_-]{43}$/;
const ID_OPACO = /^[A-Za-z0-9_-]{1,128}$/;

export type Artefato = {
  payload: Record<string, unknown>;
  consumedAt?: string | null;
  expiresAt: string;
  upstreamCiphertext?: string | null;
};

export type GravacaoArtefato = {
  payload: Record<string, unknown>;
  grantId?: string;
  uid?: string;
  userSub?: string;
  clientId?: string;
  upstreamCiphertext?: string;
  expiresAt: string;
};

export type GravacaoGrant = {
  userSub: string;
  userEmail?: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  expiresAt: string;
  upstreamCiphertext: string;
};

export type EstadoGrant = {
  status: 'active' | 'revoked' | 'expired';
  userSub: string;
  clientId: string;
  scopes: string[];
  expiresAt: string;
  upstreamCiphertext?: string | null;
};

export type Pendente = { kind: 'grant' | 'interaction'; id: string; upstreamCiphertext: string; aad: string };

/** Motivos que o MCP pode mandar (os do painel e dos ganchos de usuário são da V2). */
export type MotivoRevogacao = 'client_revoked' | 'refresh_reuse' | 'role_removed' | 'upstream_failed';

export class ErroArmazem extends Error {
  override name = 'ErroArmazem';
  constructor(readonly status: number) {
    super(`armazém OAuth respondeu ${status}`);
  }
}

export type ArmazemV2 = ReturnType<typeof criarArmazemV2>;

export function criarArmazemV2(o: { baseUrl: string; token: () => Promise<string>; timeoutMs?: number }) {
  const modelo = (m: string) => {
    if (!MODELOS.has(m)) throw new Error('modelo OAuth desconhecido');
    return m;
  };
  const id = (v: string, padrao: RegExp) => {
    if (!padrao.test(v)) throw new Error('identificador OAuth fora do formato');
    return v;
  };

  async function chamar(metodo: string, caminho: string, corpo?: unknown, aceitos: number[] = []): Promise<Response> {
    const r = await fetch(`${o.baseUrl}/v2/internal/mcp/oauth${caminho}`, {
      method: metodo,
      headers: {
        authorization: `Bearer ${await o.token()}`,
        accept: 'application/json',
        ...(corpo === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeoutMs ?? 5_000),
    });
    if (!r.ok && !aceitos.includes(r.status)) {
      await r.body?.cancel();
      throw new ErroArmazem(r.status);
    }
    return r;
  }
  const dados = async <T>(r: Response): Promise<T> => ((await r.json()) as { data: T }).data;
  const art = (m: string, h: string) => `/artifacts/${modelo(m)}/${id(h, ID_HASH)}`;
  const grant = (g: string) => `/grants/${id(g, ID_OPACO)}`;

  return {
    async gravarArtefato(m: string, h: string, corpo: GravacaoArtefato): Promise<void> {
      await chamar('PUT', art(m, h), corpo);
    },
    async lerArtefato(m: string, h: string): Promise<Artefato | undefined> {
      const r = await chamar('GET', art(m, h), undefined, [404]);
      return r.status === 404 ? undefined : dados<Artefato>(r);
    },
    /** Atômico na V2: só um consumidor ganha. */
    async consumir(m: string, h: string): Promise<'ok' | 'ja_consumido' | 'ausente'> {
      const r = await chamar('POST', `${art(m, h)}/consume`, undefined, [404, 409]);
      await r.body?.cancel();
      return r.status === 409 ? 'ja_consumido' : r.status === 404 ? 'ausente' : 'ok';
    },
    async apagarArtefato(m: string, h: string): Promise<void> {
      await chamar('DELETE', art(m, h));
    },
    /** `revokeByGrantId`: apaga os artefatos do grant e marca o `mcp_grant` revogado. */
    async revogarPorGrant(g: string, reason: 'client_revoked' | 'refresh_reuse'): Promise<void> {
      await chamar('POST', `/artifacts/by-grant/${id(g, ID_OPACO)}/revoke`, { reason });
    },
    async interacaoUpstreamRevogada(h: string): Promise<void> {
      await chamar('POST', `/artifacts/Interaction/${id(h, ID_HASH)}/upstream-revoked`);
    },
    async gravarGrant(g: string, corpo: GravacaoGrant): Promise<void> {
      await chamar('PUT', grant(g), corpo);
    },
    async lerGrant(g: string): Promise<EstadoGrant | undefined> {
      const r = await chamar('GET', grant(g), undefined, [404]);
      return r.status === 404 ? undefined : dados<EstadoGrant>(r);
    },
    async tocarGrant(g: string): Promise<void> {
      await chamar('POST', `${grant(g)}/touch`, undefined, [404]);
    },
    async revogarGrant(g: string, reason: MotivoRevogacao): Promise<void> {
      await chamar('POST', `${grant(g)}/revoke`, { reason }, [404]);
    },
    async pendentesUpstream(limite = 50): Promise<Pendente[]> {
      return dados<Pendente[]>(await chamar('GET', `/grants/upstream-pending?limit=${limite}`));
    },
    async grantUpstreamRevogado(g: string): Promise<void> {
      await chamar('POST', `${grant(g)}/upstream-revoked`, undefined, [404, 409]);
    },
  };
}
