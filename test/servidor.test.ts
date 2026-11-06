import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { Router } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { carregarConfig } from '../src/config.js';
import { iniciar } from '../src/iniciar.js';
import { criarLimites } from '../src/limites.js';
import { criarLog } from '../src/log.js';
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

const ferramentaBi: Ferramenta = {
  nome: 'bi_teste',
  titulo: 'BI de teste',
  descricao: 'Ferramenta de teste',
  escopos: ['resgata:read.bi'],
  operacoes: [],
  paramsAuditaveis: {},
  anotacoes: { readOnlyHint: true },
  efeito: false,
  entrada: z.object({}),
  saida: z.object({ sub: z.string() }),
  executar: async (_args, ctx) => ({ sub: ctx.sub }),
};
const ferramentaEfeito: Ferramenta = { ...ferramentaBi, nome: 'efeito_teste', efeito: true, escopos: [] };

async function subir(dependencias: Dependencia[] = []) {
  const limites = criarLimites();
  const app = criarApp({
    urlPublica: 'http://localhost',
    recurso: 'http://localhost/mcp',
    saltosProxy: 0,
    autorizacao: autorizacaoDeTeste(),
    mcp: criarHandlerMcp({
      versao: 't',
      ferramentas: [ferramentaBi, ferramentaEfeito],
      desligadas: new Set(),
      efeitosLigados: false,
      v2: clienteV2Pendente(),
      log: silencioso,
      limites,
      chaveHmac: Buffer.alloc(32),
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

  it.each([
    ['2025-11-25', {}],
    ['2026-07-28', { versionNegotiation: { mode: { pin: '2026-07-28' } } }],
  ] as const)('cliente %s vê só as ferramentas do escopo, sem sessão', async (_versao, opcoes) => {
    const url = await subir();
    const conectar = async (token: string) => {
      const c = new Client({ name: 't', version: '0' }, opcoes);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      fechar.push(() => c.close());
      return c;
    };
    const comBi = await conectar('ok-ana-resgata:read.bi');
    expect((await comBi.listTools()).tools.map((t) => t.name)).toEqual(['bi_teste']);
    expect((await comBi.callTool({ name: 'bi_teste', arguments: {} })).structuredContent).toEqual({ sub: 'ana' });

    const semBi = await conectar('ok-beto-resgata:read.clientes');
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
