import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * IdP falso (OIDC mínimo, caminhos no formato do Keycloak) para o modo demo e os testes.
 * Login automático com o usuário escolhido em `entrarComo`; papéis mutáveis para simular retirada no realm.
 */
export type UsuarioFalso = { sub: string; email: string; papeis: string[]; ativo: boolean };
export type ClienteFalso = { clientId: string; segredo: string; redirects?: string[] };

export type IdpFalso = {
  issuer: string;
  clientes: Record<'mcp' | 'svc', ClienteFalso>;
  usuarios: Map<string, UsuarioFalso>;
  entrarComo(sub: string): void;
  definirPapeis(sub: string, papeis: string[]): void;
  fechar(): Promise<void>;
};

const segredo = () => randomBytes(24).toString('base64url');

export async function iniciarIdpFalso(opcoes: { redirectMcp?: string; porta?: number } = {}): Promise<IdpFalso> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'idp-demo', alg: 'ES256', use: 'sig' };
  const usuarios = new Map<string, UsuarioFalso>([
    [
      'demo-usuario-1',
      {
        sub: 'demo-usuario-1',
        email: 'pessoa.demo@exemplo.invalid',
        papeis: ['ADMIN', 'MCP_ACCESS', 'MCP_READ_BI', 'MCP_READ_CLIENTES', 'MCP_CONTACT'],
        ativo: true,
      },
    ],
    ['demo-usuario-2', { sub: 'demo-usuario-2', email: 'outra.demo@exemplo.invalid', papeis: ['ADMIN'], ativo: true }],
  ]);
  const clientes: Record<'mcp' | 'svc', ClienteFalso> = {
    mcp: { clientId: 'resgata-mcp', segredo: segredo(), redirects: opcoes.redirectMcp ? [opcoes.redirectMcp] : [] },
    svc: { clientId: 'resgata-mcp-svc', segredo: segredo() },
  };
  let atual = 'demo-usuario-1';
  const codigos = new Map<
    string,
    { sub: string; clientId: string; redirect: string; desafio: string; nonce?: string; scope: string; exp: number }
  >();
  const refreshes = new Map<string, { sub: string; clientId: string; scope: string }>();

  const servidor = http.createServer();
  await new Promise<void>((ok) => servidor.listen(opcoes.porta ?? 0, '127.0.0.1', ok));
  const issuer = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/realms/demo`;
  const oidc = `${issuer}/protocol/openid-connect`;

  const assinar = (claims: Record<string, unknown>, ttl: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(privateKey);

  const autenticarCliente = (req: http.IncomingMessage, form: URLSearchParams): ClienteFalso | undefined => {
    let id = form.get('client_id');
    let sec = form.get('client_secret');
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (basic) {
      const [u, s] = Buffer.from(basic, 'base64').toString().split(':');
      id = decodeURIComponent(u ?? '');
      sec = decodeURIComponent(s ?? '');
    }
    const c = Object.values(clientes).find((x) => x.clientId === id);
    if (!c || !sec || sec.length !== c.segredo.length) return undefined;
    return timingSafeEqual(Buffer.from(sec), Buffer.from(c.segredo)) ? c : undefined;
  };

  const emitir = async (u: UsuarioFalso, clientId: string, scope: string, nonce?: string) => {
    const refresh = randomBytes(32).toString('base64url');
    refreshes.set(refresh, { sub: u.sub, clientId, scope });
    const papeis = { realm_access: { roles: u.papeis } };
    return {
      access_token: await assinar({ sub: u.sub, azp: clientId, aud: ['resgata-api'], scope, ...papeis }, 300),
      id_token: await assinar(
        {
          sub: u.sub,
          aud: clientId,
          azp: clientId,
          email: u.email,
          auth_time: Math.floor(Date.now() / 1000),
          nonce,
          ...papeis,
        },
        300,
      ),
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 300,
      scope,
    };
  };

  servidor.on('request', async (req, res) => {
    const json = (status: number, corpo: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(corpo));
    };
    const url = new URL(req.url ?? '/', issuer);
    let texto = '';
    for await (const parte of req) texto += parte;
    const form = new URLSearchParams(texto);

    switch (url.pathname) {
      case '/realms/demo/.well-known/openid-configuration':
        return json(200, {
          issuer,
          authorization_endpoint: `${oidc}/auth`,
          token_endpoint: `${oidc}/token`,
          revocation_endpoint: `${oidc}/revoke`,
          jwks_uri: `${oidc}/certs`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['ES256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          subject_types_supported: ['public'],
        });
      case '/realms/demo/protocol/openid-connect/certs':
        return json(200, { keys: [jwk] });
      case '/realms/demo/protocol/openid-connect/auth': {
        const p = url.searchParams;
        const redirect = p.get('redirect_uri') ?? '';
        const cliente = Object.values(clientes).find((c) => c.clientId === p.get('client_id'));
        if (!cliente?.redirects?.includes(redirect)) return json(400, { error: 'invalid_redirect_uri' });
        if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
          return json(400, { error: 'invalid_request', error_description: 'PKCE S256 obrigatório' });
        }
        const u = usuarios.get(atual);
        const destino = new URL(redirect);
        destino.searchParams.set('state', p.get('state') ?? '');
        destino.searchParams.set('iss', issuer);
        if (!u?.ativo) {
          destino.searchParams.set('error', 'access_denied');
        } else {
          const code = randomBytes(24).toString('base64url');
          const nonce = p.get('nonce') ?? undefined;
          codigos.set(code, {
            sub: u.sub,
            clientId: cliente.clientId,
            redirect,
            desafio: p.get('code_challenge') ?? '',
            scope: p.get('scope') ?? 'openid',
            exp: Date.now() + 60_000,
            ...(nonce ? { nonce } : {}),
          });
          destino.searchParams.set('code', code);
        }
        res.writeHead(302, { location: destino.href });
        return res.end();
      }
      case '/realms/demo/protocol/openid-connect/token': {
        if (req.method !== 'POST') return json(405, { error: 'invalid_request' });
        const cliente = autenticarCliente(req, form);
        if (!cliente) return json(401, { error: 'invalid_client' });
        const tipo = form.get('grant_type');
        if (tipo === 'client_credentials') {
          // Como o realm: sem `scope` no pedido, valem os client scopes padrão do client de serviço.
          const scope = form.get('scope') ?? (cliente === clientes.svc ? 'mcp:oauth-store mcp:audit' : '');
          return json(200, {
            access_token: await assinar(
              { sub: `service-account-${cliente.clientId}`, azp: cliente.clientId, scope },
              300,
            ),
            token_type: 'Bearer',
            expires_in: 300,
            scope,
          });
        }
        if (tipo === 'authorization_code') {
          const code = form.get('code') ?? '';
          const c = codigos.get(code);
          codigos.delete(code);
          const verificador = form.get('code_verifier') ?? '';
          const desafio = createHash('sha256').update(verificador).digest('base64url');
          if (
            !c ||
            c.exp < Date.now() ||
            c.clientId !== cliente.clientId ||
            c.redirect !== form.get('redirect_uri') ||
            c.desafio !== desafio
          ) {
            return json(400, { error: 'invalid_grant' });
          }
          const u = usuarios.get(c.sub);
          if (!u?.ativo) return json(400, { error: 'invalid_grant' });
          return json(200, await emitir(u, cliente.clientId, c.scope, c.nonce));
        }
        if (tipo === 'refresh_token') {
          const antigo = form.get('refresh_token') ?? '';
          const r = refreshes.get(antigo);
          const u = r ? usuarios.get(r.sub) : undefined;
          if (!r || r.clientId !== cliente.clientId || !u?.ativo) return json(400, { error: 'invalid_grant' });
          // Como o realm (revokeRefreshToken=false): o refresh offline continua valendo depois de usado.
          return json(200, await emitir(u, cliente.clientId, r.scope));
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      case '/realms/demo/protocol/openid-connect/revoke': {
        if (!autenticarCliente(req, form)) return json(401, { error: 'invalid_client' });
        refreshes.delete(form.get('token') ?? '');
        res.writeHead(200);
        return res.end();
      }
      default:
        return json(404, { error: 'not_found' });
    }
  });

  return {
    issuer,
    clientes,
    usuarios,
    entrarComo: (sub) => {
      atual = sub;
    },
    definirPapeis: (sub, papeis) => {
      const u = usuarios.get(sub);
      if (u) u.papeis = papeis;
    },
    fechar: () =>
      new Promise((ok) => {
        servidor.closeAllConnections();
        servidor.close(() => ok());
      }),
  };
}
