import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { Router } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { carregarConfig } from '../src/config.js';
import { iniciar } from '../src/iniciar.js';
import { criarLimites } from '../src/limites.js';
import { criarLog } from '../src/log.js';
import { type Auditoria, criarAuditoria, type LinhaAuditoria } from '../src/mcp/auditoria.js';
import type { Ferramenta } from '../src/mcp/ferramenta.js';
import { criarHandlerMcp } from '../src/mcp/servidor-mcp.js';
import type { ServidorAutorizacao } from '../src/oauth/tipos.js';
import { criarApp, type Dependencia } from '../src/servidor.js';
import { clienteV2Pendente } from '../src/v2/pendente.js';

const silencioso = criarLog('silent');
const fechar: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechar.splice(0)) await f();
});

/** Verificador de teste: `ok-<sub>-<escopos separados por +>`. */
const autorizacaoDeTeste = (): ServidorAutorizacao => ({
  rotas: Router(),
  verificador: {
    verifyAccessToken: async (token) => {
      const m = /^ok-([a-z0-9]+)-(.*)$/.exec(token);
      if (!m) throw new OAuthError(OAuthErrorCode.InvalidToken, 'token inválido');
      return {
        token,
        clientId: 'https://cliente.exemplo.invalid/cimd',
        scopes: (m[2] ?? '').split('+').filter(Boolean),
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        resource: new URL('http://localhost/mcp'),
        extra: { sub: m[1], grantId: `grant-${m[1]}`, clientId: 'https://cliente.exemplo.invalid/cimd' },
      };
    },
  },
  pronto: () => true,
  fechar: async () => {},
});

let execucoes = 0;
const ferramentaBi: Ferramenta = {
  nome: 'bi_teste',
  titulo: 'BI de teste',
  descricao: 'Ferramenta de teste',
  escopos: ['resgata:read.bi'],
  operacoes: [],
  paramsAuditaveis: {},
  anotacoes: { readOnlyHint: true },
  efeito: false,
  exemplos: ['teste'],
  entrada: z.object({}),
  saida: z.object({ sub: z.string() }),
  executar: async (_args, ctx) => {
    execucoes += 1;
    return { sub: ctx.sub };
  },
};
const ferramentaEfeito: Ferramenta = { ...ferramentaBi, nome: 'efeito_teste', efeito: true, escopos: [] };

const auditoriaMuda: Auditoria = {
  registrar: () => {},
  cheia: () => false,
  registrarAgora: async () => {},
  esvaziar: async () => {},
};

async function subir(dependencias: Dependencia[] = [], auditoria = auditoriaMuda) {
  const limites = criarLimites();
  const app = criarApp({
    urlPublica: 'http://localhost',
    recurso: 'http://localhost/mcp',
    hostsPermitidos: ['localhost', '127.0.0.1'],
    saltosProxy: 0,
    autorizacao: autorizacaoDeTeste(),
    mcp: criarHandlerMcp({
      versao: 't',
      ferramentas: [ferramentaBi, ferramentaEfeito],
      desligadas: new Set(),
      efeitosLigados: false,
      transcricoesLigadas: false,
      v2: clienteV2Pendente(),
      auditoria,
      log: silencioso,
      limites,
      chaves: { plano: Buffer.alloc(32), cursor: Buffer.alloc(32), auditoriaHmac: Buffer.alloc(32) },
    }),
    limites,
    log: silencioso,
    dependencias,
    chavesCarregadas: true,
  });
  const s = app.listen(0, '127.0.0.1');
  await new Promise((ok) => s.once('listening', ok));
  fechar.push(() => new Promise((ok) => s.close(() => ok())));
  const porta = (s.address() as { port: number }).port;
  return `http://127.0.0.1:${porta}`;
}

async function conectar(url: string, token: string, opcoes = {}) {
  const c = new Client({ name: 't', version: '0' }, opcoes);
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  fechar.push(() => c.close());
  return c;
}

/** Requisição com `Host` escolhido (o fetch não deixa trocar esse cabeçalho). */
function comHost(url: string, caminho: string, host: string, metodo = 'GET') {
  return new Promise<number>((ok, falha) => {
    http
      .request(`${url}${caminho}`, { method: metodo, headers: { host, origin: `http://${host}` } }, (r) => {
        r.resume();
        ok(r.statusCode ?? 0);
      })
      .on('error', falha)
      .end();
  });
}

const postarMcp = (url: string, token: string, corpo: unknown) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify(corpo),
  });
const chamadaBi = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'bi_teste', arguments: {} },
});

describe('servidor', () => {
  it('fumaça: readyz, healthz, PRM, metrics e 401 com resource_metadata', async () => {
    const url = await subir();
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)).json()).toEqual({
      resource: 'http://localhost/mcp',
      authorization_servers: ['http://localhost'],
      scopes_supported: ['resgata:read.bi'],
      bearer_methods_supported: ['header'],
    });
    expect(await (await fetch(`${url}/metrics`)).text()).toContain('mcp_http_requests_total');
    const r = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('healthz?detalhe=1 mostra dependência fora do ar sem derrubar a readiness', async () => {
    const url = await subir([{ nome: 'v2', verificar: async () => false }]);
    const r = await fetch(`${url}/healthz?detalhe=1`);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: 'degradado', dependencias: [{ nome: 'v2', ok: false }] });
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
  });

  it('31ª chamada a /oauth/authorize do mesmo IP em 1 min → 429', async () => {
    const url = await subir();
    for (let i = 0; i < 30; i++) expect((await fetch(`${url}/oauth/authorize`)).status).not.toBe(429);
    const r = await fetch(`${url}/oauth/authorize`);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it('/oauth/token não conta por IP (servidores compartilhados): o limite é por cliente + credencial', async () => {
    const url = await subir();
    const token = (refresh: string) =>
      fetch(`${url}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: 'c' }),
      });
    for (let i = 0; i < 40; i++) expect((await token(`r${i}`)).status).not.toBe(429);
    for (let i = 0; i < 10; i++) expect((await token('mesmo')).status).not.toBe(429);
    const r = await token('mesmo');
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: 'too_many_requests' });
    expect((await fetch(`${url}/oauth/authorize`)).status).not.toBe(429);
    // corpo acima do limite do oidc-provider (56 KB) é erro de quem chamou, não 500
    const grande = await fetch(`${url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `code=${'a'.repeat(60_000)}`,
    });
    expect(grande.status).toBe(413);
  });

  it('Host fora da lista → 421 (DNS rebinding); sondas e métricas não conferem o Host', async () => {
    const url = await subir();
    const porta = new URL(url).port;
    expect(await comHost(url, '/mcp', 'evil.example.com', 'POST')).toBe(421);
    expect(await comHost(url, '/oauth/authorize', `evil.example.com:${porta}`)).toBe(421);
    expect(await comHost(url, '/.well-known/oauth-protected-resource/mcp', 'localhost.evil.example.com')).toBe(421);
    expect(await comHost(url, '/mcp', `127.0.0.1:${porta}`, 'POST')).toBe(401);
    expect(await comHost(url, '/.well-known/oauth-protected-resource/mcp', `localhost:${porta}`)).toBe(200);
    // kubelet, health check do balanceador e coletor chamam pelo IP do pod
    for (const caminho of ['/readyz', '/healthz', '/metrics']) {
      expect(await comHost(url, caminho, '203.0.113.7:8080')).toBe(200);
    }
  });

  it('lote JSON-RPC → 400 sem executar nada (furaria o limite por grant)', async () => {
    const url = await subir();
    const antes = execucoes;
    const r = await postarMcp(
      url,
      'ok-ana-resgata:read.bi',
      Array.from({ length: 100 }, (_, i) => chamadaBi(i)),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(execucoes).toBe(antes);
    expect((await postarMcp(url, 'ok-ana-resgata:read.bi', chamadaBi(1))).status).toBe(200);
    expect(execucoes).toBe(antes + 1);
  });

  it('fila de auditoria cheia: chamada nova recusada com ocupado, sem executar, e nenhuma linha se perde', async () => {
    const entregues: LinhaAuditoria[] = [];
    let soltar = () => {};
    const segura = new Promise<void>((ok) => {
      soltar = ok;
    });
    const auditoria = criarAuditoria({
      servico: {
        chamar: async <T>(_m: string, _c: string, linha?: unknown) => {
          await segura;
          entregues.push(linha as LinhaAuditoria);
          return undefined as T;
        },
      },
      log: silencioso,
      capacidade: 1,
    });
    const c = await conectar(await subir([], auditoria), 'ok-ana-resgata:read.bi');
    const antes = execucoes;
    // 1ª linha sai da fila e fica presa no envio; a 2ª enche a fila (capacidade 1)
    for (let i = 0; i < 2; i++) expect((await c.callTool({ name: 'bi_teste', arguments: {} })).isError).toBeFalsy();
    expect(auditoria.cheia()).toBe(true);
    const r = await c.callTool({ name: 'bi_teste', arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ erro: { codigo: 'ocupado', tentar_novamente: true } });
    expect(execucoes).toBe(antes + 2);
    soltar();
    await auditoria.esvaziar();
    expect(entregues.map((l) => l.outcome)).toEqual(['ok', 'ok']);
    expect(auditoria.cheia()).toBe(false);
    expect((await c.callTool({ name: 'bi_teste', arguments: {} })).isError).toBeFalsy();
    await auditoria.esvaziar();
    expect(entregues).toHaveLength(3);
  });

  it.each([
    ['2025-11-25', {}],
    ['2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
  ] as const)('cliente %s vê só as ferramentas do escopo, sem sessão', async (_versao, opcoes) => {
    const url = await subir();
    const comBi = await conectar(url, 'ok-ana-resgata:read.bi', opcoes);
    expect((await comBi.listTools()).tools.map((t) => t.name)).toEqual(['bi_teste']);
    expect((await comBi.callTool({ name: 'bi_teste', arguments: {} })).structuredContent).toEqual({ sub: 'ana' });

    const semBi = await conectar(url, 'ok-beto-resgata:read.clientes', opcoes);
    expect((await semBi.listTools()).tools).toEqual([]);
  });
});

describe('modo demo', () => {
  it('sobe com V2 falsa e IdP falso; readyz continua 200 com a V2 fora do ar', async () => {
    const config = carregarConfig({ MCP_MODO: 'demo', PORT: '0', LOG_LEVEL: 'silent' });
    const inst = await iniciar(config, silencioso);
    fechar.push(inst.fechar);
    const detalhe = await (await fetch(`${inst.url}/healthz?detalhe=1`)).json();
    expect(detalhe).toMatchObject({ status: 'ok' });
    // V2 inalcançável (porta 9 fechada): a readiness olha só o processo; o detalhe mostra a falha
    const url = await subir([
      { nome: 'v2', verificar: async (s) => (await fetch('http://127.0.0.1:9/v2/health/ready', { signal: s })).ok },
    ]);
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
    expect((await fetch(`${url}/healthz?detalhe=1`)).status).toBe(503);
  });
});
