import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  type McpHttpHandler,
  verifyBearerToken,
} from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { Counter, collectDefaultMetrics, Registry } from 'prom-client';
import type { LimiteJanela, Limites } from './limites.js';
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
  /** Hosts aceitos no cabeçalho `Host` (sem porta): o de `MCP_PUBLIC_URL`; no modo demo, também os de loopback. */
  hostsPermitidos: readonly string[];
  saltosProxy: number;
  autorizacao: ServidorAutorizacao;
  mcp: McpHttpHandler;
  /** Portão de escopo efetivo e auditoria de negadas (`src/mcp/portao.ts`), depois do corpo lido. */
  portaoMcp?: RequestHandler;
  limites: Limites;
  log: Registrador;
  dependencias: readonly Dependencia[];
  /** Chaves e configuração carregadas. */
  chavesCarregadas: boolean;
  /** Registro de métricas compartilhado com o servidor de autorização. */
  registro?: Registry;
};

const ID_VALIDO = /^[A-Za-z0-9._-]{8,64}$/;

export function criarApp(d: DependenciasServidor) {
  const registro = d.registro ?? new Registry();
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

  // DNS rebinding: só o host público (e loopback no modo demo). Sondas e /metrics ficam acima, sem esta checagem,
  // porque o kubelet, o health check do balanceador e o coletor chamam pelo IP do pod.
  const hosts = new Set(d.hostsPermitidos.map((h) => h.toLowerCase()));
  app.use((req, res, next) => {
    if (hosts.has((req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''))) return next();
    res.status(421).json({ erro: { codigo: 'host_invalido', mensagem: 'host não atendido por este servidor' } });
  });

  /** 429 com `Retry-After` quando a chave passou do limite na janela. */
  const limitar =
    (
      nome: string,
      limite: LimiteJanela,
      chave: (req: Request, res: Response) => string,
      corpo: object,
    ): RequestHandler =>
    (req, res, next) => {
      const r = limite.consumir(chave(req, res));
      if (r.ok) return next();
      limitados.inc({ limite: nome });
      res.setHeader('retry-after', String(Math.ceil(r.reiniciaEmMs / 1000)));
      res.status(429).json(corpo);
    };
  const muitas = { error: 'too_many_requests', error_description: 'muitas tentativas; aguarde e tente de novo' };

  const urlPrm = `${d.urlPublica}/.well-known/oauth-protected-resource/mcp`;
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({
      resource: d.recurso,
      authorization_servers: [d.urlPublica],
      scopes_supported: [ESCOPO_MINIMO],
      bearer_methods_supported: ['header'],
    });
  });

  // Limite por IP só nas rotas de navegador. /mcp, o token e a revogação chegam dos servidores dos clientes de IA por
  // IPs compartilhados: token e revogação contam por cliente + credencial (um grant), /mcp por grant.
  app.use(
    ['/oauth/authorize', '/oauth/interacao', '/oauth/keycloak/callback'],
    limitar('oauth_ip', d.limites.oauthPorIp, (req) => req.ip ?? 'desconhecido', muitas),
  );
  app.use(
    ['/oauth/token', '/oauth/revoke'],
    // O oidc-provider usa o corpo já lido (Buffer) e o interpreta como faria com o fluxo; avisa uma vez no console.
    express.raw({ type: 'application/x-www-form-urlencoded', limit: '56kb' }),
    limitar('oauth_credencial', d.limites.oauthPorCredencial, chaveCredencial, muitas),
  );

  app.use(d.autorizacao.rotas);

  const bearer = {
    verifier: d.autorizacao.verificador,
    resourceMetadataUrl: urlPrm,
    expectedResource: new URL(d.recurso),
  };
  app.all(
    '/mcp',
    async (req, res, next) => {
      try {
        res.locals.auth = await verifyBearerToken(req.headers.authorization, bearer);
        return next();
      } catch (e) {
        // O 401 anuncia o escopo mínimo (DESENHO §5.1) sem exigi-lo de todo token, o que daria 403 via requiredScopes.
        const r = bearerAuthChallengeResponse(e, { ...bearer, requiredScopes: [ESCOPO_MINIMO] });
        r.headers.forEach((v, k) => {
          res.setHeader(k, v);
        });
        res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
      }
    },
    limitar('grant', d.limites.porGrant, (_req, res) => extraDoToken(res.locals.auth?.extra)?.grantId ?? 'sem-grant', {
      erro: { codigo: 'limite', mensagem: 'limite de chamadas por minuto atingido' },
    }),
    express.json({ limit: '1mb' }),
    // Lote JSON-RPC saiu do MCP em 2025-06-18: aceitá-lo faria uma requisição valer N chamadas no limite por grant.
    (req, res, next) => {
      if (!Array.isArray(req.body)) return next();
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'lote JSON-RPC não é aceito: envie uma mensagem por requisição' },
      });
    },
    d.portaoMcp ?? ((_req, _res, next) => next()),
    async (req, res, next) => {
      try {
        await responder(
          res,
          await d.mcp.fetch(paraRequest(req), { authInfo: res.locals.auth as AuthInfo, parsedBody: req.body }),
        );
      } catch (e) {
        next(e);
      }
    },
  );

  app.use((_req, res) => {
    res.status(404).json({ erro: { codigo: 'nao_encontrado' } });
  });

  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Corpo grande demais ou malformado (leitores de corpo) é erro de quem chamou: devolve o 4xx, não um 500.
    const status = (e as { status?: unknown })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      if (!res.headersSent) res.status(status).json({ erro: { codigo: 'invalido', request_id: res.locals.requestId } });
      return;
    }
    d.log.error('http.erro', { request_id: res.locals.requestId, codigo: (e as Error)?.name ?? 'Error' });
    if (!res.headersSent) res.status(500).json({ erro: { codigo: 'erro_interno', request_id: res.locals.requestId } });
  });

  return app;
}

/** Cliente + hash da credencial (refresh, código ou token a revogar): o limite cai num grant, não num IP. */
function chaveCredencial(req: Request): string {
  const f = new URLSearchParams(Buffer.isBuffer(req.body) ? req.body.toString() : '');
  const credencial = f.get('refresh_token') ?? f.get('code') ?? f.get('token') ?? '';
  return `${f.get('client_id') ?? ''}|${createHash('sha256').update(credencial).digest('base64url')}`;
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
