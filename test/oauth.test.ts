import { generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { decodeJwt } from 'jose';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { iniciarIdpFalso } from '../src/demo/idp-falso.js';
import { iniciarV2Falsa } from '../src/demo/v2-falsa.js';
import { criarLimites } from '../src/limites.js';
import { criarLog } from '../src/log.js';
import type { Ferramenta } from '../src/mcp/ferramenta.js';
import { criarHandlerMcp } from '../src/mcp/servidor-mcp.js';
import { criarArmazemV2 } from '../src/oauth/armazem-v2.js';
import { cifrar, decifrar } from '../src/oauth/cifra.js';
import { sanearCimd } from '../src/oauth/cimd.js';
import { criarIdp } from '../src/oauth/keycloak.js';
import { criarServidorAutorizacao } from '../src/oauth/provider.js';
import { criarApp } from '../src/servidor.js';
import { clienteV2Pendente } from '../src/v2/pendente.js';
import { CIMD, CLAUDE, CLAUDE_CODE, CODEX, Navegador, pkce, REDIRECT } from './apoio-oauth.js';

const silencioso = criarLog('silent');
const fechar: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechar.splice(0)) await f();
});

const ferramentaQuemSou: Ferramenta = {
  nome: 'quem_sou_teste',
  titulo: 'Quem sou',
  descricao: 'teste',
  escopos: ['resgata:read.bi'],
  operacoes: [],
  paramsAuditaveis: {},
  anotacoes: { readOnlyHint: true },
  efeito: false,
  exemplos: [],
  entrada: z.object({}),
  saida: z.object({ sub: z.string(), grantId: z.string() }),
  executar: async (_a, ctx) => ({ sub: ctx.sub, grantId: ctx.grantId }),
};

/** Sobe AS + /mcp sobre a V2 falsa e o IdP falso, com relógio controlável e sem varredura periódica. */
async function montar() {
  const relogio = { t: Date.now() };
  const agora = () => relogio.t;
  const v2 = await iniciarV2Falsa(0, agora);
  const servidor = http.createServer();
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const idpFalso = await iniciarIdpFalso({ redirectMcp: `${url}/oauth/keycloak/callback` });
  const idp = criarIdp({
    issuer: idpFalso.issuer,
    clientId: idpFalso.clientes.mcp.clientId,
    clientSecret: idpFalso.clientes.mcp.segredo,
    svcClientId: idpFalso.clientes.svc.clientId,
    svcClientSecret: idpFalso.clientes.svc.segredo,
    redirectUri: `${url}/oauth/keycloak/callback`,
  });
  const buscas: string[] = [];
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const chaveUpstream = randomBytes(32);
  const registro = new Registry();
  const as = criarServidorAutorizacao({
    urlPublica: url,
    recurso: `${url}/mcp`,
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 't', alg: 'ES256', use: 'sig' }] },
    cookieKeys: [randomBytes(32).toString('base64url')],
    chaveUpstream,
    idp,
    armazem: criarArmazemV2({ baseUrl: v2.url, token: idp.tokenServico }),
    log: silencioso,
    registro,
    buscaCimd: async (u) => {
      buscas.push(String(u));
      const doc = CIMD[String(u)];
      return doc ? Response.json(doc) : new Response('', { status: 404 });
    },
    intervaloVarreduraMs: 0,
    agora,
  });
  const limites = criarLimites();
  servidor.on(
    'request',
    criarApp({
      urlPublica: url,
      recurso: `${url}/mcp`,
      saltosProxy: 0,
      autorizacao: as,
      mcp: criarHandlerMcp({
        versao: 't',
        ferramentas: [ferramentaQuemSou],
        desligadas: new Set(),
        efeitosLigados: false,
        transcricoesLigadas: false,
        v2: clienteV2Pendente(),
        auditoria: { registrar: () => {}, registrarAgora: async () => {}, esvaziar: async () => {} },
        log: silencioso,
        limites,
        chaves: { plano: Buffer.alloc(32), cursor: Buffer.alloc(32), auditoriaHmac: Buffer.alloc(32) },
      }),
      limites,
      log: silencioso,
      registro,
      dependencias: [],
      chavesCarregadas: true,
    }),
  );
  fechar.push(async () => {
    servidor.closeAllConnections();
    await new Promise<void>((ok) => servidor.close(() => ok()));
    await as.fechar();
    await v2.fechar();
    await idpFalso.fechar();
  });
  return { url, v2, idp, idpFalso, as, relogio, buscas, chaveUpstream, registro };
}
type Ambiente = Awaited<ReturnType<typeof montar>>;

function linkAutorizacao(amb: Ambiente, clientId = CLAUDE_CODE, extra: Record<string, string> = {}) {
  const p = pkce();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT[clientId] ?? '',
    response_type: 'code',
    code_challenge: p.desafio,
    code_challenge_method: 'S256',
    scope: 'resgata:read.bi',
    state: 'estado-do-cliente',
    resource: `${amb.url}/mcp`,
    ...extra,
  });
  return { link: `${amb.url}/oauth/authorize?${q}`, verificador: p.verificador, clientId };
}

const navegador = (amb: Ambiente) => new Navegador([amb.url, new URL(amb.idpFalso.issuer).origin]);

/** Abre o link até a tela de consentimento (sempre exigida) e decide. */
async function consentir(amb: Ambiente, nav: Navegador, link: string, decisao = 'aprovar') {
  const tela = await nav.ir(link);
  expect(tela.status).toBe(200);
  const html = tela.html ?? '';
  expect(html).toContain('Só aprove se você acabou de clicar em Conectar neste aplicativo');
  const acao = /action="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const fim = await nav.ir(`${amb.url}${acao}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, decisao }),
  });
  return { html, saida: fim.saida };
}

async function token(amb: Ambiente, form: Record<string, string>) {
  const r = await fetch(`${amb.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  return { status: r.status, corpo: (await r.json()) as Record<string, string> };
}

async function conectar(amb: Ambiente, clientId = CLAUDE_CODE) {
  const a = linkAutorizacao(amb, clientId);
  const { saida } = await consentir(amb, navegador(amb), a.link);
  const code = saida?.searchParams.get('code') ?? '';
  const t = await token(amb, {
    grant_type: 'authorization_code',
    code,
    code_verifier: a.verificador,
    client_id: clientId,
    redirect_uri: REDIRECT[clientId] ?? '',
    resource: `${amb.url}/mcp`,
  });
  expect(t.status).toBe(200);
  const { access_token = '', refresh_token = '' } = t.corpo;
  return { access_token, refresh_token, grantId: String(decodeJwt(access_token).grant_id), code, a };
}

const chamarMcp = (amb: Ambiente, accessToken: string) =>
  fetch(`${amb.url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

/** O refresh offline ainda vale no IdP? (usa o próprio refresh; só para conferir revogação). */
async function offlineVivo(amb: Ambiente, refresh: string) {
  const c = amb.idpFalso.clientes.mcp;
  const r = await fetch(`${amb.idpFalso.issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: c.clientId,
      client_secret: c.segredo,
    }),
  });
  return r.status === 200;
}

describe('metadados', () => {
  it('AS (RFC 8414) sem DCR, PRM e 401 com resource_metadata e escopo mínimo', async () => {
    const amb = await montar();
    const as = (await (await fetch(`${amb.url}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as).toMatchObject({
      issuer: amb.url,
      authorization_endpoint: `${amb.url}/oauth/authorize`,
      token_endpoint: `${amb.url}/oauth/token`,
      revocation_endpoint: `${amb.url}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(as.registration_endpoint).toBeUndefined();
    expect(as.scopes_supported).toEqual(expect.arrayContaining(['resgata:read.bi', 'resgata:reprocess']));
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));

    const r = await fetch(`${amb.url}/mcp`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    const desafio = r.headers.get('www-authenticate') ?? '';
    expect(desafio).toContain(`resource_metadata="${amb.url}/.well-known/oauth-protected-resource/mcp"`);
    expect(desafio).toContain('scope="resgata:read.bi"');
  });
});

describe('autorização', () => {
  it('fluxo completo: IdP, consentimento com o escopo efetivo, token ES256 de 10 min e /mcp', async () => {
    const amb = await montar();
    const a = linkAutorizacao(amb);
    const nav = navegador(amb);
    const { html, saida } = await consentir(amb, nav, a.link);
    expect(nav.visitados.some((u) => u.startsWith(`${amb.idpFalso.issuer}/protocol/openid-connect/auth`))).toBe(true);
    expect(nav.visitados.find((u) => u.includes('/openid-connect/auth'))).toContain('max_age=300');
    expect(html).toContain('Claude Code');
    expect(html).toContain('roda <strong>no seu computador</strong>');
    expect(html).toContain('localhost:53682');
    expect(html).toContain('pessoa.demo@exemplo.invalid');
    expect(html).toContain('Ler registros de clientes'); // MCP_READ_CLIENTES do usuário, mesmo com o cliente pedindo só read.bi
    expect(html).not.toContain('Ver CPF, telefone'); // sem MCP_PII
    expect(saida?.origin + (saida?.pathname ?? '')).toBe(REDIRECT[CLAUDE_CODE]);
    expect(saida?.searchParams.get('iss')).toBe(amb.url);
    expect(saida?.searchParams.get('state')).toBe('estado-do-cliente');

    const t = await token(amb, {
      grant_type: 'authorization_code',
      code: saida?.searchParams.get('code') ?? '',
      code_verifier: a.verificador,
      client_id: CLAUDE_CODE,
      redirect_uri: REDIRECT[CLAUDE_CODE] ?? '',
      resource: `${amb.url}/mcp`,
    });
    const at = decodeJwt(t.corpo.access_token ?? '');
    expect(at).toMatchObject({ iss: amb.url, aud: `${amb.url}/mcp`, sub: 'demo-usuario-1', client_id: CLAUDE_CODE });
    expect(Number(at.exp) - Number(at.iat)).toBe(600);
    expect(String(at.scope).split(' ').sort()).toEqual(['resgata:contact', 'resgata:read.bi', 'resgata:read.clientes']);
    expect(t.corpo.refresh_token).toBeTruthy();

    // Grant na V2: escopos efetivos e o refresh offline só cifrado, com AAD = grant_id.
    const g = amb.v2.oauth.grants.get(String(at.grant_id));
    expect(g).toMatchObject({ userSub: 'demo-usuario-1', clientId: CLAUDE_CODE, clientName: 'Claude Code' });
    const offline = decifrar(amb.chaveUpstream, Buffer.from(g?.upstream ?? '', 'base64'), String(at.grant_id));
    expect(await offlineVivo(amb, offline)).toBe(true);
    // Nada de token em claro nem refresh cifrado sobrando nas interações do armazém.
    const armazenado = JSON.stringify([...amb.v2.oauth.artefatos]);
    expect(armazenado).not.toContain(t.corpo.refresh_token);
    expect([...amb.v2.oauth.artefatos.values()].every((l) => !l.upstream)).toBe(true);

    const c = new Client({ name: 't', version: '0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${amb.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${t.corpo.access_token}` } },
      }),
    );
    fechar.push(() => c.close());
    expect((await c.callTool({ name: 'quem_sou_teste', arguments: {} })).structuredContent).toEqual({
      sub: 'demo-usuario-1',
      grantId: at.grant_id,
    });
    // JWT do IdP não serve no /mcp.
    const svc = amb.idpFalso.clientes.svc;
    const doIdp = await fetch(`${amb.idpFalso.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: svc.clientId,
        client_secret: svc.segredo,
      }),
    });
    expect((await chamarMcp(amb, ((await doIdp.json()) as { access_token: string }).access_token)).status).toBe(401);
  });

  it('link de autorização aberto por outro usuário sempre passa por login e consentimento', async () => {
    const amb = await montar();
    amb.idpFalso.definirPapeis('demo-usuario-2', ['ADMIN', 'MCP_ACCESS', 'MCP_READ_BI']);
    // A pessoa 1 conecta normalmente no próprio navegador.
    const nav1 = navegador(amb);
    await consentir(amb, nav1, linkAutorizacao(amb).link);

    // Um link montado por outra pessoa, aberto no navegador da pessoa 2: IdP + tela, nunca código direto.
    amb.idpFalso.entrarComo('demo-usuario-2');
    const nav2 = navegador(amb);
    const tela = await nav2.ir(linkAutorizacao(amb, CLAUDE).link);
    expect(tela.saida).toBeUndefined();
    expect(tela.status).toBe(200);
    expect(nav2.visitados.some((u) => u.includes('/protocol/openid-connect/auth'))).toBe(true);
    expect(tela.html).toContain('Só aprove se você acabou de clicar em Conectar neste aplicativo');
    expect(tela.html).toContain('outra.demo@exemplo.invalid');
    expect(tela.html).not.toContain('roda <strong>no seu computador</strong>'); // retorno web, sem aviso de app local

    // E o mesmo navegador da pessoa 1, logo depois, também volta ao IdP e à tela (nada é lembrado).
    amb.idpFalso.entrarComo('demo-usuario-1');
    const antes = nav1.visitados.length;
    const deNovo = await nav1.ir(linkAutorizacao(amb).link);
    expect(deNovo.saida).toBeUndefined();
    expect(deNovo.html).toContain('Só aprove se você acabou de clicar');
    expect(nav1.visitados.slice(antes).some((u) => u.includes('/protocol/openid-connect/auth'))).toBe(true);
  });

  it('sem MCP_ACCESS (mesmo ADMIN) → recusa, offline revogado e access_denied para o cliente', async () => {
    const amb = await montar();
    amb.idpFalso.entrarComo('demo-usuario-2');
    const nav = navegador(amb);
    const r = await nav.ir(linkAutorizacao(amb).link);
    expect(r.status).toBe(403);
    expect(r.html).toContain('Sem acesso ao MCP');
    const voltar = /href="([^"]+)"/.exec(r.html ?? '')?.[1]?.replace(/&amp;/g, '&') ?? '';
    const fim = await nav.ir(new URL(voltar, amb.url).href);
    expect(fim.saida?.searchParams.get('error')).toBe('access_denied');
    expect(amb.v2.oauth.grants.size).toBe(0);
  });

  it('recusar na tela devolve access_denied e não cria grant', async () => {
    const amb = await montar();
    const { saida } = await consentir(amb, navegador(amb), linkAutorizacao(amb, CODEX).link, 'recusar');
    expect(saida?.searchParams.get('error')).toBe('access_denied');
    expect(amb.v2.oauth.grants.size).toBe(0);
  });

  it('dois envios da mesma aprovação criam um grant só', async () => {
    const amb = await montar();
    const nav = navegador(amb);
    const tela = await nav.ir(linkAutorizacao(amb).link);
    const acao = /action="([^"]+)"/.exec(tela.html ?? '')?.[1] ?? '';
    const csrf = /name="csrf" value="([^"]+)"/.exec(tela.html ?? '')?.[1] ?? '';
    const enviar = () =>
      nav.ir(`${amb.url}${acao}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, decisao: 'aprovar' }),
      });
    const respostas = await Promise.all([enviar(), enviar()]);
    expect(respostas.filter((r) => r.saida?.searchParams.get('code')).length).toBe(1);
    expect(amb.v2.oauth.grants.size).toBe(1);
  });

  it('CIMD fora da lista não é buscado; retorno fora do documento, resource errado e PKCE plain são recusados', async () => {
    const amb = await montar();
    const fora = await navegador(amb).ir(linkAutorizacao(amb, 'https://exemplo.invalid/cimd.json').link);
    expect(fora.status).toBe(400);
    expect(fora.html).toContain('não está liberado');
    expect(amb.buscas).not.toContain('https://exemplo.invalid/cimd.json');

    const outroRetorno = await navegador(amb).ir(
      linkAutorizacao(amb, CLAUDE, { redirect_uri: 'https://exemplo.invalid/cb' }).link,
    );
    expect(outroRetorno.saida).toBeUndefined();
    expect(outroRetorno.status).toBe(400);

    const recurso = await navegador(amb).ir(
      linkAutorizacao(amb, CLAUDE, { resource: 'https://exemplo.invalid/mcp' }).link,
    );
    expect(recurso.saida?.searchParams.get('error')).toBe('invalid_target');

    const plain = await navegador(amb).ir(linkAutorizacao(amb, CLAUDE, { code_challenge_method: 'plain' }).link);
    expect(plain.saida?.searchParams.get('error')).toBe('invalid_request');

    // O documento com jwks_uri, sector_identifier_uri e logo_uri não gera nenhuma busca além dele mesmo.
    expect(amb.buscas.every((u) => u in CIMD)).toBe(true);
    expect(sanearCimd(CIMD[CLAUDE] ?? {})).not.toHaveProperty('jwks_uri');
    expect(sanearCimd(CIMD[CLAUDE_CODE] ?? {})).toMatchObject({ application_type: 'native' });
  });

  it('callback do IdP repassado a outro navegador (sem o verificador PKCE) ou repetido é recusado', async () => {
    const amb = await montar();
    const nav = navegador(amb);
    const r = await fetch(linkAutorizacao(amb).link, { redirect: 'manual' });
    const cookies = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const interacao = await fetch(new URL(r.headers.get('location') ?? '', amb.url), {
      redirect: 'manual',
      headers: { cookie: cookies },
    });
    const noIdp = await fetch(interacao.headers.get('location') ?? '', { redirect: 'manual' });
    const callback = noIdp.headers.get('location') ?? '';
    const alheio = await nav.ir(callback);
    expect(alheio.status).toBe(400);
    expect(alheio.html).toContain('Sessão expirada');
    expect(amb.v2.oauth.grants.size).toBe(0);
  });
});

describe('renovação e revogação', () => {
  it('reuso de refresh em menos de 30 s não revoga; depois de 30 s revoga o grant e alerta', async () => {
    const amb = await montar();
    const t = await conectar(amb, CODEX);
    const renovar = (refresh: string) =>
      token(amb, { grant_type: 'refresh_token', refresh_token: refresh, client_id: CODEX });

    const r1 = await renovar(t.refresh_token);
    expect(r1.status).toBe(200);
    expect(decodeJwt(r1.corpo.access_token ?? '').aud).toBe(`${amb.url}/mcp`); // refresh sem resource (Codex)
    expect(r1.corpo.refresh_token).not.toBe(t.refresh_token);

    // Segunda sessão renovando junto, com o refresh antigo: invalid_grant e o grant segue vivo.
    amb.relogio.t += 10_000;
    const junto = await renovar(t.refresh_token);
    expect(junto).toMatchObject({ status: 400, corpo: { error: 'invalid_grant' } });
    expect(amb.v2.oauth.grants.get(t.grantId)?.revogadoEm).toBeUndefined();
    const r2 = await renovar(r1.corpo.refresh_token ?? '');
    expect(r2.status).toBe(200);

    // O antigo reaparece depois da janela: reuso → grant revogado na V2, sucessor morto, métrica.
    amb.relogio.t += 31_000;
    const tarde = await renovar(r1.corpo.refresh_token ?? '');
    expect(tarde).toMatchObject({ status: 400, corpo: { error: 'invalid_grant' } });
    expect(amb.v2.oauth.grants.get(t.grantId)).toMatchObject({ motivo: 'refresh_reuse' });
    expect((await renovar(r2.corpo.refresh_token ?? '')).status).toBe(400);
    expect(await amb.registro.getSingleMetricAsString('mcp_refresh_reuse_total')).toMatch(
      /mcp_refresh_reuse_total 1$/m,
    );
    expect((await chamarMcp(amb, r2.corpo.access_token ?? '')).status).toBe(401);
  });

  it('/oauth/revoke marca o grant na V2 e o varredor revoga o offline no IdP', async () => {
    const amb = await montar();
    const t = await conectar(amb);
    const offline = decifrar(
      amb.chaveUpstream,
      Buffer.from(amb.v2.oauth.grants.get(t.grantId)?.upstream ?? '', 'base64'),
      t.grantId,
    );
    const r = await fetch(`${amb.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: t.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: CLAUDE_CODE,
      }),
    });
    expect(r.status).toBe(200);
    expect(amb.v2.oauth.grants.get(t.grantId)).toMatchObject({ motivo: 'client_revoked' });
    expect(
      (await token(amb, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLAUDE_CODE })).corpo
        .error,
    ).toBe('invalid_grant');
    expect(await amb.registro.getSingleMetricAsString('mcp_refresh_reuse_total')).toMatch(
      /mcp_refresh_reuse_total 0$/m,
    );

    expect(await amb.as.varrer()).toBe(1);
    expect(await offlineVivo(amb, offline)).toBe(false);
    expect(amb.v2.oauth.grants.get(t.grantId)?.upstream).toBeUndefined();
  });

  it('grant revogado no painel recebe 401 em até 30 s; o refresh vira invalid_grant', async () => {
    const amb = await montar();
    const t = await conectar(amb);
    expect((await chamarMcp(amb, t.access_token)).status).toBe(200);
    amb.v2.oauth.revogarComoPainel(t.grantId);
    amb.relogio.t += 30_001;
    const r = await chamarMcp(amb, t.access_token);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    expect(
      (await token(amb, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLAUDE_CODE })).corpo
        .error,
    ).toBe('invalid_grant');
  });

  it('código reapresentado revoga o grant', async () => {
    const amb = await montar();
    const t = await conectar(amb);
    const de_novo = await token(amb, {
      grant_type: 'authorization_code',
      code: t.code,
      code_verifier: t.a.verificador,
      client_id: CLAUDE_CODE,
      redirect_uri: REDIRECT[CLAUDE_CODE] ?? '',
    });
    expect(de_novo.corpo.error).toBe('invalid_grant');
    expect(amb.v2.oauth.grants.get(t.grantId)?.revogadoEm).toBeDefined();
  });

  it('grant vencido (90 dias): o varredor revoga o offline no IdP', async () => {
    const amb = await montar();
    const t = await conectar(amb);
    const cifra = Buffer.from(amb.v2.oauth.grants.get(t.grantId)?.upstream ?? '', 'base64');
    expect(await amb.as.varrer()).toBe(0);
    amb.relogio.t += 90 * 86_400_000 + 1_000;
    expect(await amb.as.varrer()).toBe(1);
    expect(await offlineVivo(amb, decifrar(amb.chaveUpstream, cifra, t.grantId))).toBe(false);
  });

  it('interação abandonada depois do login: o varredor revoga o offline e a V2 apaga a linha', async () => {
    const amb = await montar();
    const tela = await navegador(amb).ir(linkAutorizacao(amb).link);
    expect(tela.status).toBe(200);
    const [chave, linha] = [...amb.v2.oauth.artefatos].find(([k]) => k.startsWith('Interaction/')) ?? [];
    expect(linha?.upstream).toBeTruthy();
    const offline = decifrar(amb.chaveUpstream, Buffer.from(linha?.upstream ?? '', 'base64'), linha?.uid ?? '');
    expect(await amb.as.varrer()).toBe(0); // ainda dentro do prazo da interação
    amb.relogio.t += 601_000;
    expect(await amb.as.varrer()).toBe(1);
    expect(await offlineVivo(amb, offline)).toBe(false);
    expect(amb.v2.oauth.artefatos.has(chave ?? '')).toBe(false);
  });
});

describe('IdP para o P4', () => {
  it('renovar devolve o token da V2 com os papéis atuais do realm', async () => {
    const amb = await montar();
    const t = await conectar(amb);
    const cifra = Buffer.from(amb.v2.oauth.grants.get(t.grantId)?.upstream ?? '', 'base64');
    const r = await amb.idp.renovar(decifrar(amb.chaveUpstream, cifra, t.grantId));
    expect(decodeJwt(r.accessToken)).toMatchObject({ azp: 'resgata-mcp', aud: ['resgata-api'] });
    expect(r.papeis).toContain('MCP_CONTACT');
    amb.idpFalso.definirPapeis('demo-usuario-1', ['ADMIN', 'MCP_ACCESS']);
    expect((await amb.idp.renovar(r.refresh ?? '')).papeis).not.toContain('MCP_CONTACT');
  });
});

describe('cifra do refresh offline', () => {
  it('AAD prende o texto ao dono', () => {
    const chave = randomBytes(32);
    const c = cifrar(chave, 'refresh-sintetico', 'uid-1');
    expect(decifrar(chave, c, 'uid-1')).toBe('refresh-sintetico');
    expect(() => decifrar(chave, c, 'grant-1')).toThrow();
    expect(() => decifrar(randomBytes(32), c, 'uid-1')).toThrow();
  });
});
