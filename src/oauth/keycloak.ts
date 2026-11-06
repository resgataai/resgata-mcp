import { decodeJwt } from 'jose';
import * as oidc from 'openid-client';

/** Toda autorização passa pelo IdP; só reaproveita login feito nos últimos 5 min (DESENHO §5.2 passo 4). */
export const MAX_AGE_S = 300;

export type OpcoesIdp = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  svcClientId: string;
  svcClientSecret: string;
  /** Redirect exato registrado no client: `<MCP_PUBLIC_URL>/oauth/keycloak/callback`. */
  redirectUri: string;
  agora?: () => number;
};

export type LoginIdp = { sub: string; email?: string; papeis: string[]; refresh?: string; authTime: number };

export type Idp = ReturnType<typeof criarIdp>;

/**
 * Cliente do IdP (Keycloak, realm da Resgata): login das pessoas pelo client confidencial e credencial de serviço
 * (`client_credentials`) para o armazém OAuth e a auditoria. Descoberta preguiçosa: o IdP fora do ar não derruba a subida.
 */
export function criarIdp(o: OpcoesIdp) {
  const agora = o.agora ?? Date.now;
  // Só o modo demo usa http (IdP falso em 127.0.0.1); a configuração de produção exige https.
  const opcoes = o.issuer.startsWith('http:') ? { execute: [oidc.allowInsecureRequests] } : undefined;
  const memo = (id: string, segredo: string) => {
    let p: Promise<oidc.Configuration> | undefined;
    return () => {
      p ??= oidc.discovery(new URL(o.issuer), id, segredo, undefined, opcoes).catch((e: unknown) => {
        p = undefined;
        throw e;
      });
      return p;
    };
  };
  const pessoas = memo(o.clientId, o.clientSecret);
  const servico = memo(o.svcClientId, o.svcClientSecret);
  let tokenServico: { valor: string; ate: number } | undefined;
  let emVoo: Promise<string> | undefined;

  return {
    async urlDeLogin(p: { state: string; nonce: string; verificador: string }): Promise<URL> {
      return oidc.buildAuthorizationUrl(await pessoas(), {
        redirect_uri: o.redirectUri,
        response_type: 'code',
        scope: 'openid offline_access',
        state: p.state,
        nonce: p.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(p.verificador),
        code_challenge_method: 'S256',
        max_age: String(MAX_AGE_S),
      });
    },

    /** Troca o código, valida `state`, `nonce`, `iss` e `auth_time` (≤ 300 s) e lê os papéis do access token. */
    async trocarCodigo(urlAtual: URL, p: { state: string; nonce: string; verificador: string }): Promise<LoginIdp> {
      const t = await oidc.authorizationCodeGrant(await pessoas(), urlAtual, {
        pkceCodeVerifier: p.verificador,
        expectedState: p.state,
        expectedNonce: p.nonce,
        maxAge: MAX_AGE_S,
      });
      const claims = t.claims();
      if (!claims) throw new Error('IdP não devolveu id_token');
      return {
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        papeis: papeisDo(t.access_token),
        refresh: t.refresh_token,
        authTime: typeof claims.auth_time === 'number' ? claims.auth_time : Math.floor(agora() / 1000),
      };
    },

    /**
     * Token da V2 a partir do refresh offline do grant (P4). O IdP recusar (`invalid_grant`) lança: o grant deve ser
     * revogado com `upstream_failed`. `refresh` só vem se o IdP girar o offline; aí o P4 regrava o grant cifrado.
     */
    async renovar(
      refresh: string,
    ): Promise<{ accessToken: string; expiraEmS: number; papeis: string[]; refresh?: string }> {
      const t = await oidc.refreshTokenGrant(await pessoas(), refresh);
      return {
        accessToken: t.access_token,
        expiraEmS: t.expires_in ?? 300,
        papeis: papeisDo(t.access_token),
        refresh: t.refresh_token === refresh ? undefined : t.refresh_token,
      };
    },

    /** Revoga o refresh offline (encerra a sessão offline do client no IdP). */
    async revogar(refresh: string): Promise<void> {
      await oidc.tokenRevocation(await pessoas(), refresh, { token_type_hint: 'refresh_token' });
    },

    /** Token da credencial de serviço, reaproveitado até 30 s antes de vencer. */
    async tokenServico(): Promise<string> {
      if (tokenServico && agora() < tokenServico.ate) return tokenServico.valor;
      emVoo ??= (async () => {
        const t = await oidc.clientCredentialsGrant(await servico(), { scope: 'mcp:oauth-store mcp:audit' });
        tokenServico = { valor: t.access_token, ate: agora() + ((t.expires_in ?? 60) - 30) * 1000 };
        return t.access_token;
      })().finally(() => {
        emVoo = undefined;
      });
      return emVoo;
    },
  };
}

/** Papéis do realm no access token do IdP (o id_token do Keycloak não os traz por padrão). */
function papeisDo(accessToken: string): string[] {
  const papeis = (decodeJwt(accessToken) as { realm_access?: { roles?: unknown } }).realm_access?.roles;
  return Array.isArray(papeis) ? papeis.filter((x): x is string => typeof x === 'string') : [];
}
