import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
};

export type V2Falsa = {
  url: string;
  chamadas: ChamadaRegistrada[];
  /** Armazém OAuth interno (`/v2/internal/mcp/oauth/**`), fora do manifesto. */
  oauth: ArmazemOauthFalso;
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

/**
 * V2 falsa, em memória, com dados 100% sintéticos: responde às operações do manifesto.
 * Imita o IdempotencyService da V2 nas operações com chave obrigatória: mesma chave e mesmo corpo → replay;
 * corpo diferente → 422; pedido igual ainda em andamento → 409.
 */
export async function iniciarV2Falsa(porta = 0, agora: () => number = Date.now): Promise<V2Falsa> {
  const rotas = carregarManifesto().operations.map(compilar);
  const fixtures = new Map(Object.entries(FIXTURES));
  const chamadas: ChamadaRegistrada[] = [];
  const oauth = criarArmazemOauthFalso(agora);
  const idempotencia = new Map<string, { hash: string; resposta?: { status: number; corpo: unknown } }>();

  const servidor = http.createServer(async (req, res) => {
    const responder = (status: number, corpo: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(corpo));
    };
    const url = new URL(req.url ?? '/', 'http://v2-falsa');
    if (url.pathname === '/v2/health/ready') return responder(200, { status: 'UP' });
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return responder(401, { title: 'Unauthorized' });
    if (url.pathname.startsWith('/v2/internal/mcp/oauth/')) return oauth.tratar(req, res, url.pathname.slice(23));

    const rota = rotas.find((r) => r.op.method === req.method && r.regex.test(url.pathname));
    if (!rota) return responder(404, { title: 'Not Found', code: 'rota_fora_do_manifesto' });

    let texto = '';
    for await (const parte of req) texto += parte;
    const corpo = texto ? (JSON.parse(texto) as unknown) : undefined;
    const valores = rota.regex.exec(url.pathname)?.slice(1) ?? [];
    const params = Object.fromEntries(rota.nomes.map((n, i) => [n, decodeURIComponent(valores[i] ?? '')]));
    const chave = req.headers['idempotency-key'];
    const idempotencyKey = typeof chave === 'string' ? chave : undefined;
    chamadas.push({
      operacao: rota.op.operationId,
      metodo: req.method ?? 'GET',
      caminho: url.pathname,
      consulta: Object.fromEntries(url.searchParams),
      corpo,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    const fixture = fixtures.get(rota.op.operationId);
    if (!fixture) return responder(501, { title: 'Not Implemented', code: 'fixture_ausente' });

    if (rota.op.idempotencyKey !== 'required') {
      const r = await fixture({ params, consulta: url.searchParams, corpo });
      return responder(r.status, r.corpo);
    }
    if (!idempotencyKey) return responder(400, { title: 'Bad Request', code: 'idempotency_key_required' });
    const hash = createHash('sha256').update(texto).digest('base64url');
    const anterior = idempotencia.get(idempotencyKey);
    if (anterior) {
      if (anterior.hash !== hash) return responder(422, { title: 'Unprocessable', code: 'idempotency_key_reused' });
      if (!anterior.resposta) return responder(409, { title: 'Conflict', code: 'idempotency_in_progress' });
      return responder(anterior.resposta.status, anterior.resposta.corpo, { 'idempotent-replayed': 'true' });
    }
    const registro: { hash: string; resposta?: { status: number; corpo: unknown } } = { hash };
    idempotencia.set(idempotencyKey, registro);
    const r = await fixture({ params, consulta: url.searchParams, corpo });
    registro.resposta = r;
    return responder(r.status, r.corpo);
  });

  await new Promise<void>((ok) => servidor.listen(porta, '127.0.0.1', ok));
  const { port } = servidor.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    chamadas,
    oauth,
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
