import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import { carregarManifesto, type OperacaoV2 } from '../v2/contrato.js';
import { type ArmazemOauthFalso, criarArmazemOauthFalso } from './armazem-oauth-falso.js';
import { FIXTURES, type Fixture } from './fixtures.js';

export type ChamadaRegistrada = {
  operacao: string;
  metodo: string;
  caminho: string;
  consulta: Record<string, string>;
  corpo: unknown;
  idempotencyKey?: string;
  cabecalhos: Record<string, string>;
  /** `sub` do token do usuário que fez a chamada (testes de isolamento). */
  sub?: string;
};

export type V2Falsa = {
  url: string;
  chamadas: ChamadaRegistrada[];
  /** Armazém OAuth interno (`/v2/internal/mcp/oauth/**`), fora do manifesto; os testes semeiam `oauth.grants`. */
  oauth: ArmazemOauthFalso;
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

/** Claims do Bearer, se for JWT (a V2 falsa não confere assinatura; o IdP falso é quem emite). */
function claims(autorizacao: string): { azp?: string; scope?: string; sub?: string } {
  try {
    return decodeJwt(autorizacao.replace(/^Bearer /, '')) as { azp?: string; scope?: string; sub?: string };
  } catch {
    return {};
  }
}

/** As restrições de `McpToolCallAuditRequest` (A2, `mcp-audit-v1`): o que a V2 recusaria com 400. */
export function linhaAuditoriaValida(l: Record<string, unknown>): boolean {
  const campo = (k: string, re: RegExp, obrigatorio = false) =>
    l[k] === undefined || l[k] === null ? !obrigatorio : typeof l[k] === 'string' && re.test(l[k]);
  return (
    campo('tool', /^[a-z][a-z0-9_]{1,63}$/, true) &&
    campo('outcome', /^(ok|denied|error|accepted|replayed)$/, true) &&
    campo('userSub', /^\S.{0,254}$/, true) &&
    campo('grantId', /^\S.{0,127}$/, true) &&
    campo('clientId', /^\S.{0,254}$/, true) &&
    campo('requestId', /^[A-Za-z0-9._-]{1,120}$/, true) &&
    campo('targetType', /^.{0,80}$/) &&
    campo('targetId', /^.{0,160}$/) &&
    campo('planId', /^.{0,128}$/) &&
    campo('idempotencyKeyHash', /^.{0,128}$/) &&
    campo('paramsDigest', /^.{0,128}$/) &&
    campo('errorCode', /^.{0,80}$/) &&
    Number.isInteger(l.latencyMs) &&
    (l.latencyMs as number) >= 0 &&
    Object.keys((l.params ?? {}) as object).length <= 32
  );
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
export async function iniciarV2Falsa(porta = 0, agora: () => number = Date.now): Promise<V2Falsa> {
  const rotas = carregarManifesto().operations.map(compilar);
  const fixtures = new Map(Object.entries(FIXTURES));
  const chamadas: ChamadaRegistrada[] = [];
  const oauth = criarArmazemOauthFalso(agora);
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
    const token = claims(autorizacao);
    // Como a cadeia de serviço da V2: `/v2/internal/mcp/**` só para o client de serviço do MCP, nunca com `%` no caminho.
    if (url.pathname.startsWith('/v2/internal/')) {
      if (token.azp !== 'resgata-mcp-svc' || (req.url ?? '').includes('%'))
        return responder(403, { message: 'Forbidden' });
      if (url.pathname.startsWith('/v2/internal/mcp/oauth/')) return oauth.tratar(req, res, url.pathname.slice(23));
    }
    let texto = '';
    for await (const parte of req) texto += parte;
    const corpo = texto ? (JSON.parse(texto) as unknown) : undefined;

    if (url.pathname.startsWith('/v2/internal/')) {
      if (url.pathname === '/v2/internal/mcp/audit/tool-calls' && req.method === 'POST') {
        if (
          !String(token.scope ?? '')
            .split(' ')
            .includes('mcp:audit')
        )
          return responder(403, { message: 'Forbidden' });
        if (estado.auditoriaFalhando) return responder(503, { message: 'indisponível' });
        const linha = (corpo ?? {}) as Record<string, unknown>;
        if (!linhaAuditoriaValida(linha)) return responder(400, { message: 'Bad Request', causeId: 'validation' });
        // Como McpToolCallAuditService: o grant (revogado também vale) tem de ser desse userSub.
        if (oauth.grants.get(String(linha.grantId))?.userSub !== linha.userSub) {
          return responder(422, { message: 'grant de outro usuário' });
        }
        auditoria.push(linha);
        return responder(201, null);
      }
      return responder(404, { message: 'Not Found' });
    }

    const quem = token.azp;
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
      ...(token.sub ? { sub: token.sub } : {}),
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
    oauth,
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
