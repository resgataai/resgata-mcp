// Ambiente de teste das ferramentas: V2 falsa + IdP falso + cliente real da V2 + auditoria + portão + servidor.
// O token do MCP é simulado por um verificador de teste (o servidor de autorização é do P3): Bearer = grant_id.
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { Router } from 'express';
import { type IdpFalso, iniciarIdpFalso } from '../src/demo/idp-falso.js';
import { iniciarV2Falsa, type V2Falsa } from '../src/demo/v2-falsa.js';
import { FERRAMENTAS } from '../src/ferramentas/index.js';
import { criarLimites, type Limites } from '../src/limites.js';
import { criarLog } from '../src/log.js';
import { type Auditoria, criarAuditoria } from '../src/mcp/auditoria.js';
import { criarPortao } from '../src/mcp/portao.js';
import { criarHandlerMcp } from '../src/mcp/servidor-mcp.js';
import { cifrar } from '../src/oauth/cifra.js';
import type { ServidorAutorizacao } from '../src/oauth/tipos.js';
import { criarApp } from '../src/servidor.js';
import { criarClienteV2 } from '../src/v2/cliente.js';
import { criarCredencialServico, urlTokenKeycloak } from '../src/v2/servico.js';
import type { ClienteV2 } from '../src/v2/tipos.js';

export const TODOS = ['resgata:read.bi', 'resgata:read.clientes', 'resgata:contact'];
export const CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const REDIRECT = 'http://127.0.0.1:1/oauth/keycloak/callback';

export type Ambiente = {
  url: string;
  v2: V2Falsa;
  idp: IdpFalso;
  cliente: ClienteV2;
  auditoria: Auditoria;
  limites: Limites;
  chaves: { upstream: Buffer; plano: Buffer; cursor: Buffer; auditoriaHmac: Buffer };
  /** Relógio do cliente da V2 (vence o token da V2 sem esperar 5 min). */
  relogio: { ms: number };
  /** Cria um grant ativo na V2 falsa com o refresh offline real do IdP falso; devolve o Bearer (= grant_id). */
  conectar(sub: string, escopos?: string[]): Promise<string>;
  mcp(token: string): Promise<Client>;
  chamarHttp(token: string, nome: string, args?: Record<string, unknown>): Promise<Response>;
  fechar(): Promise<void>;
};

export async function subirAmbiente(
  o: { efeitos?: boolean; transcricoes?: boolean; desligadas?: string[] } = {},
): Promise<Ambiente> {
  const log = criarLog('silent');
  const v2 = await iniciarV2Falsa();
  const idp = await iniciarIdpFalso({ redirectMcp: REDIRECT });
  const chaves = {
    upstream: randomBytes(32),
    plano: randomBytes(32),
    cursor: randomBytes(32),
    auditoriaHmac: randomBytes(32),
  };
  const relogio = { ms: Date.now() };
  const tokenUrl = urlTokenKeycloak(idp.issuer);
  const servico = criarCredencialServico({
    baseUrl: v2.url,
    tokenUrl,
    clientId: idp.clientes.svc.clientId,
    clientSecret: idp.clientes.svc.segredo,
  });
  const limites = criarLimites();
  const cliente = criarClienteV2({
    baseUrl: v2.url,
    idp: { tokenUrl, clientId: idp.clientes.mcp.clientId, clientSecret: idp.clientes.mcp.segredo },
    servico,
    chaveUpstream: chaves.upstream,
    limites,
    log,
    agora: () => relogio.ms,
  });
  const auditoria = criarAuditoria({ servico, log });
  const conexoes = new Map<string, { sub: string; escopos: string[] }>();
  const autorizacao: ServidorAutorizacao = {
    rotas: Router(),
    verificador: {
      verifyAccessToken: async (token) => {
        const c = conexoes.get(token);
        if (!c) throw new OAuthError(OAuthErrorCode.InvalidToken, 'token desconhecido');
        return {
          token,
          clientId: CLIENT_ID,
          scopes: [...c.escopos],
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          resource: new URL('http://localhost/mcp'),
          extra: { sub: c.sub, grantId: token, clientId: CLIENT_ID },
        };
      },
    },
    pronto: () => true,
    fechar: async () => {},
  };
  const desligadas = new Set(o.desligadas ?? []);
  const efeitosLigados = o.efeitos ?? false;
  const app = criarApp({
    urlPublica: 'http://localhost',
    recurso: 'http://localhost/mcp',
    saltosProxy: 0,
    autorizacao,
    mcp: criarHandlerMcp({
      versao: 't',
      ferramentas: FERRAMENTAS,
      desligadas,
      efeitosLigados,
      transcricoesLigadas: o.transcricoes ?? false,
      v2: cliente,
      auditoria,
      log,
      limites,
      chaves,
    }),
    portaoMcp: criarPortao({
      ferramentas: FERRAMENTAS,
      desligadas,
      efeitosLigados,
      v2: cliente,
      auditoria,
      log,
      chaveHmac: chaves.auditoriaHmac,
      urlPrm: 'http://localhost/.well-known/oauth-protected-resource/mcp',
    }),
    limites,
    log,
    dependencias: [],
    chavesCarregadas: true,
  });
  const s = app.listen(0, '127.0.0.1');
  await new Promise((ok) => s.once('listening', ok));
  const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const clientes: Client[] = [];

  const refreshOffline = async (sub: string) => {
    idp.entrarComo(sub);
    const verificador = randomBytes(32).toString('base64url');
    const auth = new URL(`${idp.issuer}/protocol/openid-connect/auth`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: idp.clientes.mcp.clientId,
      redirect_uri: REDIRECT,
      code_challenge: createHash('sha256').update(verificador).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'openid offline_access',
      state: 's',
    }))
      auth.searchParams.set(k, v);
    const code = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location') ?? '').searchParams.get(
      'code',
    );
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${idp.clientes.mcp.clientId}:${idp.clientes.mcp.segredo}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: REDIRECT,
        code_verifier: verificador,
      }),
    });
    return ((await r.json()) as { refresh_token: string }).refresh_token;
  };

  return {
    url,
    v2,
    idp,
    cliente,
    auditoria,
    limites,
    chaves,
    relogio,
    async conectar(sub, escopos = TODOS) {
      const grantId = `grant-${randomBytes(6).toString('hex')}`;
      const refresh = await refreshOffline(sub);
      v2.oauth.grants.set(grantId, {
        userSub: sub,
        clientId: CLIENT_ID,
        clientName: 'Claude Code',
        scopes: escopos,
        expira: Date.now() + 86_400_000,
        upstream: cifrar(chaves.upstream, refresh, grantId).toString('base64'),
      });
      conexoes.set(grantId, { sub, escopos });
      return grantId;
    },
    async mcp(token) {
      const c = new Client({ name: 't', version: '0' });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      clientes.push(c);
      return c;
    },
    chamarHttp: (token, nome, args = {}) =>
      fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: nome, arguments: args } }),
      }),
    async fechar() {
      for (const c of clientes) await c.close();
      await new Promise((ok) => {
        s.closeAllConnections();
        s.close(() => ok(undefined));
      });
      await auditoria.esvaziar();
      await v2.fechar();
      await idp.fechar();
    },
  };
}

/** Texto com dado pessoal em claro dos fixtures (CPF, telefone, e-mail, CEP) ou campo que nunca deveria sair. */
export function vazamentos(saida: unknown): string[] {
  const t = JSON.stringify(saida);
  const achados: string[] = [];
  if (/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t) || t.includes('00000000191')) achados.push('cpf');
  if (t.includes('cliente.um@exemplo.invalid') || t.includes('pessoa.demo@exemplo.invalid')) achados.push('email');
  if (t.includes('90000-0001') || t.includes('900000001')) achados.push('telefone');
  if (t.includes('01000-000')) achados.push('cep');
  if (t.includes('nunca sai')) achados.push('campo fora do schema');
  return achados;
}
