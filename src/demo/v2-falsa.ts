import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { carregarManifesto, type OperacaoV2 } from '../v2/contrato.js';
import { FIXTURES, type Fixture } from './fixtures.js';

export type ChamadaRegistrada = {
  operacao: string;
  metodo: string;
  caminho: string;
  consulta: Record<string, string>;
  corpo: unknown;
  idempotencyKey?: string;
  cabecalhos: Record<string, string>;
};

/** Grant como o armazém OAuth da V2 devolve (`McpGrantState`). */
export type GrantFalso = {
  status: 'active' | 'revoked' | 'expired';
  userSub: string;
  clientId: string;
  scopes: string[];
  expiresAt: string;
  upstreamCiphertext?: string;
  revokedReason?: string;
};

export type V2Falsa = {
  url: string;
  chamadas: ChamadaRegistrada[];
  /** Armazém OAuth falso (`/v2/internal/mcp/oauth/grants/**`): os testes semeiam os grants. */
  grants: Map<string, GrantFalso>;
  /** Linhas recebidas em `/v2/internal/mcp/audit/tool-calls`. */
  auditoria: Array<Record<string, unknown>>;
  /** Simula a auditoria fora do ar (5xx). */
  auditoriaFalhando: boolean;
  /** Troca ou acrescenta a resposta de uma operação (testes). */
  definir(operacao: string, fixture: Fixture): void;
  fechar(): Promise<void>;
};

type Rota = { op: OperacaoV2; regex: RegExp; nomes: string[] };

function compilar(op: OperacaoV2): Rota {
  const nomes: string[] = [];
  const padrao = op.path.replace(/\{([^}]+)\}/g, (_m, nome: string) => {
    nomes.push(nome);
    return '([^/]+)';
  });
  return { op, regex: new RegExp(`^${padrao}$`), nomes };
}

/** `azp` do Bearer, se for JWT (a V2 falsa não confere assinatura; o IdP falso é quem emite). */
function azp(autorizacao: string): string | undefined {
  const partes = autorizacao.replace(/^Bearer /, '').split('.');
  if (partes.length !== 3) return undefined;
  try {
    return (JSON.parse(Buffer.from(partes[1] ?? '', 'base64url').toString()) as { azp?: string }).azp;
  } catch {
    return undefined;
  }
}

const envelope = (status: number, corpo: unknown) =>
  status < 300
    ? { success: true, message: 'ok', data: corpo, timestamp: new Date().toISOString() }
    : corpo && typeof corpo === 'object' && 'success' in corpo
      ? corpo
      : { success: false, message: 'erro', ...(corpo as object) };

/**
 * V2 falsa, em memória, com dados 100% sintéticos: responde às operações do manifesto no envelope `ApiResponse`.
 * Imita o IdempotencyService da V2 nas operações com chave obrigatória: mesma chave e corpo → replay com
 * `Idempotent-Replayed: true`; corpo diferente → 409 `idempotency_key_reused`; em andamento → 409
 * `idempotency_request_in_progress`. Também serve o armazém de grants e a auditoria internos do MCP, só para o
 * token de serviço; o token do usuário só serve às rotas de negócio.
 */
export async function iniciarV2Falsa(porta = 0): Promise<V2Falsa> {
  const rotas = carregarManifesto().operations.map(compilar);
  const fixtures = new Map(Object.entries(FIXTURES));
  const chamadas: ChamadaRegistrada[] = [];
  const grants = new Map<string, GrantFalso>();
  const auditoria: Array<Record<string, unknown>> = [];
  const idempotencia = new Map<string, { hash: string; resposta?: { status: number; corpo: unknown } }>();
  const estado = { auditoriaFalhando: false };

  const servidor = http.createServer(async (req, res) => {
    const responder = (status: number, corpo: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(envelope(status, corpo)));
    };
    const url = new URL(req.url ?? '/', 'http://v2-falsa');
    if (url.pathname === '/v2/health/ready') return responder(200, { status: 'UP' });
    const autorizacao = req.headers.authorization ?? '';
    if (!/^Bearer \S+$/.test(autorizacao)) return responder(401, { message: 'Unauthorized' });
    let texto = '';
    for await (const parte of req) texto += parte;
    const corpo = texto ? (JSON.parse(texto) as unknown) : undefined;

    if (url.pathname.startsWith('/v2/internal/')) {
      if (azp(autorizacao) !== 'resgata-mcp-svc') return responder(403, { message: 'Forbidden' });
      const g = /^\/v2\/internal\/mcp\/oauth\/grants\/([^/]+)(\/revoke)?$/.exec(url.pathname);
      if (g && req.method === 'GET' && !g[2]) {
        const grant = grants.get(decodeURIComponent(g[1] ?? ''));
        if (!grant) return responder(404, { message: 'Not Found', causeId: 'not_found' });
        const { upstreamCiphertext, revokedReason: _r, ...resto } = grant;
        return responder(200, grant.status === 'active' ? { ...resto, upstreamCiphertext } : resto);
      }
      if (g && req.method === 'POST' && g[2]) {
        const grant = grants.get(decodeURIComponent(g[1] ?? ''));
        if (grant) Object.assign(grant, { status: 'revoked', revokedReason: (corpo as { reason?: string })?.reason });
        return responder(200, null);
      }
      if (url.pathname === '/v2/internal/mcp/audit/tool-calls' && req.method === 'POST') {
        if (estado.auditoriaFalhando) return responder(503, { message: 'indisponível' });
        const linha = (corpo ?? {}) as Record<string, unknown>;
        if (grants.get(String(linha.grantId))?.userSub !== linha.userSub) {
          return responder(422, { message: 'grant de outro usuário' });
        }
        auditoria.push(linha);
        return responder(201, null);
      }
      return responder(404, { message: 'Not Found' });
    }

    const quem = azp(autorizacao);
    if (quem !== undefined && quem !== 'resgata-mcp') return responder(403, { message: 'Forbidden' });
    const rota = rotas.find((r) => r.op.method === req.method && r.regex.test(url.pathname));
    if (!rota) return responder(404, { message: 'Not Found', causeId: 'rota_fora_do_manifesto' });
    for (const p of rota.op.forbiddenParams ?? []) {
      if (url.searchParams.has(p)) return responder(403, { message: 'Forbidden', causeId: 'mcp_route_not_allowed' });
    }

    const valores = rota.regex.exec(url.pathname)?.slice(1) ?? [];
    const params = Object.fromEntries(rota.nomes.map((n, i) => [n, decodeURIComponent(valores[i] ?? '')]));
    const chave = req.headers['idempotency-key'];
    const idempotencyKey = typeof chave === 'string' ? chave : undefined;
    const cabecalhos = Object.fromEntries(
      ['x-request-id', 'traceparent', 'x-audit-reason']
        .map((h) => [h, req.headers[h]])
        .filter((p): p is [string, string] => typeof p[1] === 'string'),
    );
    chamadas.push({
      operacao: rota.op.operationId,
      metodo: req.method ?? 'GET',
      caminho: url.pathname,
      consulta: Object.fromEntries(url.searchParams),
      corpo,
      cabecalhos,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    const fixture = fixtures.get(rota.op.operationId);
    if (!fixture) return responder(501, { message: 'Not Implemented', causeId: 'fixture_ausente' });

    if (rota.op.idempotencyKey !== 'required') {
      const r = await fixture({ params, consulta: url.searchParams, corpo });
      return responder(r.status, r.corpo, r.cabecalhos);
    }
    if (!idempotencyKey) return responder(400, { message: 'Bad Request', causeId: 'idempotency_key_required' });
    const hash = createHash('sha256').update(texto).digest('base64url');
    const anterior = idempotencia.get(idempotencyKey);
    if (anterior) {
      if (anterior.hash !== hash) return responder(409, { message: 'Conflict', causeId: 'idempotency_key_reused' });
      if (!anterior.resposta) {
        return responder(409, { message: 'Conflict', causeId: 'idempotency_request_in_progress' });
      }
      return responder(anterior.resposta.status, anterior.resposta.corpo, { 'idempotent-replayed': 'true' });
    }
    const registro: { hash: string; resposta?: { status: number; corpo: unknown } } = { hash };
    idempotencia.set(idempotencyKey, registro);
    const r = await fixture({ params, consulta: url.searchParams, corpo });
    if (r.status < 300) registro.resposta = r;
    else idempotencia.delete(idempotencyKey);
    return responder(r.status, r.corpo);
  });

  await new Promise<void>((ok) => servidor.listen(porta, '127.0.0.1', ok));
  const { port } = servidor.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chamadas,
    grants,
    auditoria,
    get auditoriaFalhando() {
      return estado.auditoriaFalhando;
    },
    set auditoriaFalhando(v: boolean) {
      estado.auditoriaFalhando = v;
    },
    definir: (op, f) => {
      fixtures.set(op, f);
    },
    fechar: () =>
      new Promise((ok) => {
        servidor.closeAllConnections();
        servidor.close(() => ok());
      }),
  };
}
