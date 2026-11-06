import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { requireBearerAuth } from '@modelcontextprotocol/express';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Counter, collectDefaultMetrics, Registry } from 'prom-client';
import type { Limites } from './limites.js';
import type { Registrador } from './log.js';
import { ESCOPO_MINIMO } from './mcp/escopos.js';
import { extraDoToken, type ServidorAutorizacao } from './oauth/tipos.js';

/** Dependência externa checada só em `/healthz?detalhe=1` (nunca na readiness). */
export type Dependencia = { nome: string; verificar(sinal: AbortSignal): Promise<boolean> };

/** GET simples: alcançável = respondeu sem 5xx dentro do prazo. */
export function dependenciaHttp(nome: string, url: string): Dependencia {
  return {
    nome,
    verificar: async (sinal) => (await fetch(url, { signal: sinal, redirect: 'manual' })).status < 500,
  };
}

export type DependenciasServidor = {
  urlPublica: string;
  recurso: string;
  saltosProxy: number;
  autorizacao: ServidorAutorizacao;
  mcp: McpHttpHandler;
  limites: Limites;
  log: Registrador;
  dependencias: readonly Dependencia[];
  /** Chaves e configuração carregadas. */
  chavesCarregadas: boolean;
};

const ID_VALIDO = /^[A-Za-z0-9._-]{8,64}$/;

export function criarApp(d: DependenciasServidor) {
  const registro = new Registry();
  collectDefaultMetrics({ register: registro });
  const http = new Counter({
    name: 'mcp_http_requests_total',
    help: 'Requisições HTTP por rota e status',
    labelNames: ['rota', 'status'],
    registers: [registro],
  });
  const limitados = new Counter({
    name: 'mcp_rate_limited_total',
    help: 'Requisições recusadas por limite',
    labelNames: ['limite'],
    registers: [registro],
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', d.saltosProxy);

  // X-Request-Id: aproveita o da borda se for bem formado; log por lista positiva e sem query string.
  app.use((req, res, next) => {
    const recebido = req.get('x-request-id');
    const id = recebido && ID_VALIDO.test(recebido) ? recebido : randomUUID();
    res.locals.requestId = id;
    res.setHeader('x-request-id', id);
    const inicio = performance.now();
    res.on('finish', () => {
      const rota = rotaRotulo(req.path);
      http.inc({ rota, status: String(res.statusCode) });
      if (rota === '/healthz' || rota === '/readyz' || rota === '/metrics') return;
      d.log.info('http', {
        request_id: id,
        metodo: req.method,
        rota,
        status: res.statusCode,
        latencia_ms: Math.round(performance.now() - inicio),
      });
    });
    next();
  });

  app.get('/readyz', (_req, res) => {
    const pronto = d.chavesCarregadas && d.autorizacao.pronto();
    res.status(pronto ? 200 : 503).json({ pronto });
  });

  app.get('/healthz', async (req, res) => {
    if (req.query.detalhe !== '1') {
      res.json({ status: 'ok' });
      return;
    }
    const resultados = await Promise.all(
      d.dependencias.map(async (dep) => {
        const inicio = performance.now();
        let ok = false;
        try {
          ok = await dep.verificar(AbortSignal.timeout(2_000));
        } catch {
          ok = false;
        }
        return { nome: dep.nome, ok, latencia_ms: Math.round(performance.now() - inicio) };
      }),
    );
    const ok = resultados.every((r) => r.ok);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degradado', dependencias: resultados });
  });

  app.get('/metrics', async (_req, res) => {
    res.type(registro.contentType).send(await registro.metrics());
  });

  const urlPrm = `${d.urlPublica}/.well-known/oauth-protected-resource/mcp`;
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({
      resource: d.recurso,
      authorization_servers: [d.urlPublica],
      scopes_supported: [ESCOPO_MINIMO],
      bearer_methods_supported: ['header'],
    });
  });

  // Limite por IP só em /oauth/* (tráfego de navegador); nunca em /mcp, que chega por IPs compartilhados.
  app.use('/oauth', (req, res, next) => {
    const r = d.limites.oauthPorIp.consumir(req.ip ?? 'desconhecido');
    if (r.ok) return next();
    limitados.inc({ limite: 'oauth_ip' });
    res.setHeader('retry-after', String(Math.ceil(r.reiniciaEmMs / 1000)));
    res
      .status(429)
      .json({ error: 'too_many_requests', error_description: 'muitas tentativas; aguarde e tente de novo' });
  });

  app.use(d.autorizacao.rotas);

  app.all(
    '/mcp',
    requireBearerAuth({
      verifier: d.autorizacao.verificador,
      resourceMetadataUrl: urlPrm,
      expectedResource: new URL(d.recurso),
    }),
    (req, res, next) => {
      const grantId = extraDoToken(req.auth?.extra)?.grantId;
      const r = d.limites.porGrant.consumir(grantId ?? 'sem-grant');
      if (r.ok) return next();
      limitados.inc({ limite: 'grant' });
      res.setHeader('retry-after', String(Math.ceil(r.reiniciaEmMs / 1000)));
      res.status(429).json({ erro: { codigo: 'limite', mensagem: 'limite de chamadas por minuto atingido' } });
    },
    express.json({ limit: '1mb' }),
    async (req, res, next) => {
      try {
        await responder(res, await d.mcp.fetch(paraRequest(req), { authInfo: req.auth, parsedBody: req.body }));
      } catch (e) {
        next(e);
      }
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ erro: { codigo: 'nao_encontrado' } });
  });

  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    d.log.error('http.erro', { request_id: res.locals.requestId, codigo: (e as Error)?.name ?? 'Error' });
    if (!res.headersSent) res.status(500).json({ erro: { codigo: 'erro_interno', request_id: res.locals.requestId } });
  });

  return app;
}

/** Rótulo fixo para métricas e log: nunca o caminho cru (pode trazer lixo de quem chama). */
function rotaRotulo(caminho: string): string {
  for (const r of ['/mcp', '/oauth', '/.well-known', '/healthz', '/readyz', '/metrics', '/interacao']) {
    if (caminho === r || caminho.startsWith(`${r}/`)) return r;
  }
  return 'outra';
}

function paraRequest(req: Request): globalThis.Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    // O corpo é reserializado: o tamanho original não vale mais.
    if (k === 'content-length' || k === 'transfer-encoding') continue;
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
  }
  const url = new URL(req.originalUrl, `http://${req.get('host') ?? 'localhost'}`);
  const corpo = req.method === 'POST' ? JSON.stringify(req.body ?? null) : undefined;
  return new Request(url, { method: req.method, headers, body: corpo });
}

async function responder(res: Response, r: globalThis.Response): Promise<void> {
  res.status(r.status);
  r.headers.forEach((v, k) => {
    res.setHeader(k, v);
  });
  if (!r.body) {
    res.end();
    return;
  }
  Readable.fromWeb(r.body as import('node:stream/web').ReadableStream).pipe(res);
}
