import { Router } from 'express';
import Provider, { errors, type KoaContext } from 'oidc-provider';
import { Counter, type Registry } from 'prom-client';
import type { Registrador } from '../log.js';
import { ESCOPOS } from '../mcp/escopos.js';
import { classeAdaptador } from './adaptador-v2.js';
import type { ArmazemV2 } from './armazem-v2.js';
import { criarBuscaCimd, nomeDoCliente, sondarCimd } from './cimd.js';
import { paginaAviso } from './consentimento.js';
import { rotasInteracao, VIDA_GRANT_S } from './interacoes.js';
import type { Idp } from './keycloak.js';
import { criarVerificador } from './recurso.js';
import { criarRevogador } from './revogador.js';
import type { ServidorAutorizacao } from './tipos.js';

const DIA = 86_400;

export type OpcoesServidorAutorizacao = {
  urlPublica: string;
  recurso: string;
  jwks: { keys: Array<Record<string, unknown>> };
  cookieKeys: string[];
  chaveUpstream: Buffer;
  idp: Idp;
  armazem: ArmazemV2;
  log: Registrador;
  registro: Registry;
  /** Busca dos documentos CIMD (o padrão é a internet; testes injetam documentos). */
  buscaCimd?: (url: string | URL, opcoes?: RequestInit) => Promise<Response>;
  /** Busca os três CIMD na subida e registra o resultado (produção). */
  sondarCimd?: boolean;
  /** 0 desliga a varredura periódica (testes chamam `varrer()`). */
  intervaloVarreduraMs?: number;
  agora?: () => number;
  janelaReusoMs?: number;
  cacheGrantMs?: number;
};

/**
 * Servidor de autorização federado (DESENHO §5): `oidc-provider` com CIMD em lista fechada, sem DCR, PKCE S256,
 * token JWT ES256 de 10 min, refresh rotativo com janela de reuso de 30 s, login sempre no IdP e consentimento
 * sempre. Estado inteiro no armazém da V2.
 */
export function criarServidorAutorizacao(o: OpcoesServidorAutorizacao): ServidorAutorizacao & {
  varrer(): Promise<number>;
} {
  const agora = o.agora ?? Date.now;
  const eventos = new Counter({
    name: 'mcp_oauth_events_total',
    help: 'Eventos do servidor de autorização',
    labelNames: ['event'],
    registers: [o.registro],
  });
  const reusos = new Counter({
    name: 'mcp_refresh_reuse_total',
    help: 'Reuso de refresh ou código já consumido (o grant foi revogado)',
    registers: [o.registro],
  });
  const evento = (nome: string, campos: Record<string, unknown> = {}) => {
    eventos.inc({ event: nome });
    o.log.info(`oauth.${nome}`, campos);
  };

  const recursoValido = async (_ctx: unknown, recurso: string) => {
    if (recurso !== o.recurso) throw new errors.InvalidTarget();
    return {
      scope: ESCOPOS.join(' '),
      audience: o.recurso,
      accessTokenFormat: 'jwt',
      accessTokenTTL: 600,
      jwt: { sign: { alg: 'ES256' } },
    };
  };

  const provider = new Provider(o.urlPublica, {
    adapter: classeAdaptador({
      armazem: o.armazem,
      agora,
      janelaReusoMs: o.janelaReusoMs ?? 30_000,
      aoReusoDetectado: (grantId) => {
        reusos.inc();
        o.log.warn('oauth.reuso_detectado', { grant_id: grantId });
      },
    }),
    jwks: o.jwks,
    cookies: { keys: o.cookieKeys },
    scopes: [...ESCOPOS],
    claims: { openid: ['sub'] },
    routes: {
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      revocation: '/oauth/revoke',
      jwks: '/oauth/jwks',
    },
    responseTypes: ['code'],
    pkce: { required: () => true },
    clientAuthMethods: ['none'],
    clientDefaults: {
      id_token_signed_response_alg: 'ES256',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    clientBasedCORS: () => false,
    // O PRM não anuncia offline_access: o refresh sai sempre, e não morre com a sessão (que dura só a interação).
    issueRefreshToken: async () => true,
    expiresWithSession: async () => false,
    rotateRefreshToken: true,
    allowOmittingSingleRegisteredRedirectUri: false,
    ttl: {
      AccessToken: 600,
      AuthorizationCode: 60,
      Interaction: 600,
      Session: 600,
      IdToken: 600,
      RefreshToken: 30 * DIA,
      Grant: VIDA_GRANT_S,
    },
    // Nunca reaproveita consentimento: só o grant aprovado nesta interação.
    loadExistingGrant: async (ctx: { oidc: { result?: { consent?: { grantId?: string } }; provider: Provider } }) => {
      const id = ctx.oidc.result?.consent?.grantId;
      return id
        ? (ctx.oidc.provider as unknown as { Grant: { find(id: string): Promise<unknown> } }).Grant.find(id)
        : undefined;
    },
    findAccount: async (_ctx: unknown, sub: string) => ({ accountId: sub, claims: async () => ({ sub }) }),
    extraTokenClaims: async (_ctx: unknown, token: { grantId?: string }) => ({ grant_id: token.grantId }),
    interactions: { url: async (_ctx: unknown, i: { uid: string }) => `/interacao/${i.uid}` },
    fetch: criarBuscaCimd(o.buscaCimd),
    renderError: async (ctx: { type: string; body: string }, saida: { error?: string }) => {
      ctx.type = 'html';
      ctx.body = paginaAviso(
        'Não foi possível continuar',
        saida.error === 'invalid_client'
          ? 'Este aplicativo não está liberado para o MCP da Resgata.ai.'
          : 'O pedido de autorização é inválido ou expirou. Volte ao aplicativo e tente de novo.',
      );
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      introspection: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      requestObjects: { enabled: false },
      revocation: {
        enabled: true,
        allowedPolicy: async (_ctx: unknown, client: { clientId: string }, token: { clientId: string }) =>
          token.clientId === client.clientId,
      },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        allowFetch: async (_ctx: unknown, id: string) => nomeDoCliente(id) !== undefined,
        allowClient: async (_ctx: unknown, client: { clientId: string }) =>
          nomeDoCliente(client.clientId) !== undefined,
        cacheDuration: { min: 3600, max: 3600 },
      },
      resourceIndicators: {
        enabled: true,
        // Refresh sem `resource` (Codex) continua emitindo JWT com aud = recurso.
        defaultResource: async () => o.recurso,
        useGrantedResource: async () => true,
        getResourceServerInfo: recursoValido,
      },
    },
  });
  // URLs sempre na origem pública, nunca no Host ou X-Forwarded-* de quem chama (fixado em `rotas` abaixo).
  provider.proxy = true;
  const origem = new URL(o.urlPublica);

  // O cliente pede o escopo mínimo do PRM; o consentimento pede o conjunto amplo e reduz aos papéis (DESENHO §6.1).
  provider.use(async (ctx: KoaContext, next) => {
    if (ctx.path === '/oauth/authorize' && ctx.method === 'GET') {
      const q = new URLSearchParams(ctx.querystring);
      const pedidos = (q.get('scope') ?? '').split(' ').filter(Boolean);
      q.set('scope', [...new Set([...pedidos, ...ESCOPOS])].join(' '));
      ctx.querystring = q.toString();
    }
    await next();
  });
  provider.on('server_error', (_ctx, e) => o.log.error('oauth.erro', { codigo: (e as Error)?.name }));
  provider.on('grant.revoked', (_ctx, grantId) => evento('grant_revogado', { grant_id: grantId }));
  provider.on('refresh_token.consumed', () => eventos.inc({ event: 'renovado' }));
  provider.on('authorization_code.consumed', () => eventos.inc({ event: 'codigo_trocado' }));

  const rotas = Router();
  const rotasDoProvider = [
    '/oauth/authorize',
    '/oauth/authorize/:uid',
    '/oauth/token',
    '/oauth/revoke',
    '/oauth/jwks',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ];
  rotas.use([...rotasDoProvider, '/oauth/keycloak/callback', '/interacao'], (req, _res, next) => {
    req.headers['x-forwarded-host'] = origem.host;
    req.headers['x-forwarded-proto'] = origem.protocol.slice(0, -1);
    next();
  });
  rotas.use(
    rotasInteracao({
      provider,
      idp: o.idp,
      armazem: o.armazem,
      chaveUpstream: o.chaveUpstream,
      recurso: o.recurso,
      redirectIdp: `${o.urlPublica}/oauth/keycloak/callback`,
      seguro: origem.protocol === 'https:',
      log: o.log,
      evento,
      agora,
    }),
  );
  rotas.all(rotasDoProvider, provider.callback());

  const varrer = criarRevogador({ armazem: o.armazem, idp: o.idp, chave: o.chaveUpstream, log: o.log });
  const intervalo = o.intervaloVarreduraMs ?? 300_000;
  const relogio =
    intervalo > 0
      ? setInterval(() => {
          varrer().catch((e: unknown) => o.log.warn('oauth.varredura_falhou', { codigo: (e as Error).name }));
        }, intervalo).unref()
      : undefined;
  if (o.sondarCimd) void sondarCimd(criarBuscaCimd(o.buscaCimd), o.log);

  return {
    rotas,
    verificador: criarVerificador({
      emissor: o.urlPublica,
      recurso: o.recurso,
      jwks: o.jwks,
      armazem: o.armazem,
      log: o.log,
      agora,
      cacheGrantMs: o.cacheGrantMs ?? 30_000,
      toqueMs: 300_000,
    }),
    pronto: () => true,
    fechar: async () => clearInterval(relogio),
    varrer,
  };
}
