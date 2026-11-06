import { OAuthError, OAuthErrorCode, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createLocalJWKSet, type JWTPayload, jwtVerify } from 'jose';
import type { Registrador } from '../log.js';
import type { ArmazemV2, EstadoGrant } from './armazem-v2.js';
import type { ExtraDoToken } from './tipos.js';

export type OpcoesVerificador = {
  emissor: string;
  recurso: string;
  /** JWKS privado do MCP: só a parte pública é usada aqui. */
  jwks: { keys: Array<Record<string, unknown>> };
  armazem: ArmazemV2;
  log: Registrador;
  agora: () => number;
  /** Revogação no painel vale em até este prazo (DESENHO §5.2 passo 10). */
  cacheGrantMs: number;
  /** `last_used_at` atualizado no máximo uma vez por este intervalo. */
  toqueMs: number;
};

const LIMITE_CACHE = 10_000;

/**
 * Valida o Bearer de `/mcp`: assinatura ES256, `typ`, `iss`, `aud`, `exp` e o estado do grant na V2 (cache por pod).
 * JWT do IdP, token de outro emissor ou grant revogado → 401. V2 fora do ar → 500, sem reautenticar (falha fechada).
 */
export function criarVerificador(o: OpcoesVerificador): OAuthTokenVerifier {
  const chaves = createLocalJWKSet({ keys: o.jwks.keys.map(({ d: _d, ...publica }) => publica) });
  const cache = new Map<string, { estado: EstadoGrant | undefined; ate: number }>();
  const toques = new Map<string, number>();

  async function estado(grantId: string): Promise<EstadoGrant | undefined> {
    const t = o.agora();
    const c = cache.get(grantId);
    if (c && t < c.ate) return c.estado;
    let e: EstadoGrant | undefined;
    try {
      e = await o.armazem.lerGrant(grantId);
    } catch (erro) {
      o.log.error('oauth.grant_indisponivel', { grant_id: grantId, codigo: (erro as Error).name });
      throw new OAuthError(OAuthErrorCode.ServerError, 'estado da autorização indisponível; tente de novo');
    }
    if (cache.size >= LIMITE_CACHE) cache.clear();
    cache.set(grantId, { estado: e, ate: t + o.cacheGrantMs });
    return e;
  }

  function tocar(grantId: string): void {
    const t = o.agora();
    if (t - (toques.get(grantId) ?? 0) < o.toqueMs) return;
    if (toques.size >= LIMITE_CACHE) toques.clear();
    toques.set(grantId, t);
    o.armazem.tocarGrant(grantId).catch((e: unknown) => {
      o.log.warn('oauth.toque_falhou', { grant_id: grantId, codigo: (e as Error).name });
    });
  }

  return {
    async verifyAccessToken(token) {
      let c: JWTPayload;
      try {
        ({ payload: c } = await jwtVerify(token, chaves, {
          issuer: o.emissor,
          audience: o.recurso,
          algorithms: ['ES256'],
          typ: 'at+jwt',
          currentDate: new Date(o.agora()),
        }));
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'token inválido ou vencido');
      }
      const { sub, grant_id: grantId, client_id: clientId, scope, exp } = c as JWTPayload & Record<string, unknown>;
      if (typeof sub !== 'string' || typeof grantId !== 'string' || typeof clientId !== 'string') {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'token sem grant');
      }
      const g = await estado(grantId);
      if (g?.status !== 'active' || g.userSub !== sub) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'autorização revogada ou vencida');
      }
      tocar(grantId);
      const doGrant = new Set(g.scopes);
      const extra: ExtraDoToken = { sub, grantId, clientId };
      return {
        token,
        clientId,
        scopes: (typeof scope === 'string' ? scope.split(' ') : []).filter((s) => doGrant.has(s)),
        expiresAt: exp,
        resource: new URL(o.recurso),
        extra,
      };
    },
  };
}
