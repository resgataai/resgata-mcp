import { randomBytes } from 'node:crypto';
import { type Limites, OPERACOES_ANALITICAS } from '../limites.js';
import type { Registrador } from '../log.js';
import { type Escopo, PAPEL_ACESSO, PAPEL_DO_ESCOPO } from '../mcp/escopos.js';
import { decifrar } from '../oauth/cifra.js';
import { carregarManifesto, type Manifesto, type OperacaoV2 } from './contrato.js';
import { type CredencialServico, lerCorpo, pedirToken, semEnvelope } from './servico.js';
import { type ClienteV2, ErroV2, type PedidoV2, type RespostaV2 } from './tipos.js';

/** Teto de período das consultas (DESENHO §10). */
export const PERIODO_MAXIMO_DIAS = 92;
const DIA_MS = 86_400_000;
/** Valor de parâmetro de caminho: um segmento só, nunca `.` ou `..`. */
const PARAM_CAMINHO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

export type OpcoesClienteV2 = {
  baseUrl: string;
  /** Client `resgata-mcp` no Keycloak: troca o refresh offline do grant pelo token da V2. */
  idp: { tokenUrl: string; clientId: string; clientSecret: string };
  servico: CredencialServico;
  /** `MCP_UPSTREAM_KEY`: decifra o refresh offline guardado na V2 (AAD = `grant_id`). */
  chaveUpstream: Buffer;
  limites: Limites;
  log: Registrador;
  manifesto?: Manifesto;
  agora?: () => number;
  timeoutMs?: number;
};

type TokenGrant = { token: string; venceEm: number; escopos: ReadonlySet<string> };
type EstadoGrant = { status?: string; scopes?: string[]; upstreamCiphertext?: string };

/** Papéis do realm no access token do Keycloak (recebido direto do IdP por TLS: só lê o payload). */
function papeisDoToken(jwt: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      realm_access?: { roles?: unknown };
    };
    const roles = payload.realm_access?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

function instante(v: unknown, fimDoDia: boolean): number | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (/^\d{4}-\d{2}$/.test(v)) {
    const [a, m] = v.split('-').map(Number) as [number, number];
    return fimDoDia ? Date.UTC(a, m, 1) - 1 : Date.UTC(a, m - 1, 1);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Recusa período maior que o teto em `from/to`, `fromMonth/toMonth` e `*From/*To`, na consulta ou no corpo. */
export function conferirPeriodo(...fontes: unknown[]): void {
  for (const fonte of fontes) {
    if (!fonte || typeof fonte !== 'object') continue;
    const campos = fonte as Record<string, unknown>;
    for (const [de, ate] of [
      ['from', 'to'],
      ['fromMonth', 'toMonth'],
      ['createdAtFrom', 'createdAtTo'],
      ['scheduledFrom', 'scheduledTo'],
    ] as const) {
      const ini = instante(campos[de], false);
      if (ini === undefined) continue;
      const fim = instante(campos[ate], true) ?? Date.now();
      if (fim - ini > PERIODO_MAXIMO_DIAS * DIA_MS) {
        throw new ErroV2('invalido', `período maior que ${PERIODO_MAXIMO_DIAS} dias; divida a consulta`);
      }
    }
  }
}

/** ProblemDetails/ApiResponse da V2 → erro acionável (DESENHO §7.2). */
export function erroDaV2(status: number, corpo: unknown, cabecalhos: Headers, requestId: string): ErroV2 {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const causa = String(c.causeId ?? c.code ?? c.cause ?? '');
  const retry = Number(cabecalhos.get('retry-after'));
  const espera = Number.isFinite(retry) && retry > 0 ? { tentarNovamenteEmS: retry } : {};
  const base = { status, requestId };
  if (status === 400 || status === 422) return new ErroV2('invalido', 'a plataforma recusou os parâmetros', base);
  if (status === 401) return new ErroV2('tentar_novamente', 'credencial do MCP na plataforma expirou', base);
  if (status === 403 && causa === 'mcp_route_not_allowed') {
    return new ErroV2('indisponivel_por_gate', 'operação não liberada para o MCP na plataforma', {
      ...base,
      gate: 'APP_MCP_ACCESS_ENABLED',
    });
  }
  if (status === 403)
    return new ErroV2('insufficient_scope', 'seu perfil na plataforma não permite esta operação', base);
  if (status === 404) return new ErroV2('nao_encontrado', 'não encontrado', base);
  if (status === 409 && causa === 'idempotency_request_in_progress') {
    return new ErroV2('em_andamento', 'já em execução; consulte o status', base);
  }
  if (status === 409 && causa === 'idempotency_key_reused') {
    return new ErroV2('invalido', 'pedido divergente com a mesma chave', base);
  }
  if (status === 409 || status === 423) {
    return new ErroV2('indisponivel_por_gate', 'função desligada na plataforma', {
      ...base,
      ...(causa ? { gate: causa.slice(0, 80) } : {}),
    });
  }
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return new ErroV2('tentar_novamente', 'plataforma ocupada ou indisponível', { ...base, ...espera });
  }
  return new ErroV2('erro_interno', 'erro na plataforma', base);
}

/**
 * Cliente da V2 (P4). Token por grant: decifra o refresh offline guardado na V2, troca no Keycloak e guarda o token
 * até 30 s antes de vencer. A cada token novo recalcula o escopo efetivo (escopos do grant ∩ papéis do realm):
 * sem `MCP_ACCESS` revoga o grant; escopo perdido vira `insufficient_scope` na chamada.
 */
export function criarClienteV2(o: OpcoesClienteV2): ClienteV2 {
  const agora = o.agora ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const operacoes = new Map((o.manifesto ?? carregarManifesto()).operations.map((op) => [op.operationId, op]));
  const tokens = new Map<string, TokenGrant>();
  const emCurso = new Map<string, Promise<TokenGrant>>();

  const revogar = async (grantId: string, motivo: string) => {
    tokens.delete(grantId);
    try {
      await o.servico.chamar('POST', `/v2/internal/mcp/oauth/grants/${encodeURIComponent(grantId)}/revoke`, {
        reason: motivo,
      });
      o.log.warn('grant.revogado', { grant_id: grantId, motivo });
    } catch (e) {
      o.log.error('grant.revogacao_falhou', { grant_id: grantId, motivo, codigo: (e as ErroV2).codigo });
    }
  };

  const renovar = async (grantId: string): Promise<TokenGrant> => {
    const caminho = `/v2/internal/mcp/oauth/grants/${encodeURIComponent(grantId)}`;
    const grant = await o.servico.chamar<EstadoGrant>('GET', caminho).catch((e: unknown) => {
      if (e instanceof ErroV2 && e.codigo === 'nao_encontrado') throw new ErroV2('reautenticar', 'conexão inexistente');
      throw e;
    });
    if (grant?.status !== 'active' || !grant.upstreamCiphertext) {
      throw new ErroV2('reautenticar', 'conexão revogada ou vencida; conecte de novo');
    }
    let refresh: string;
    try {
      refresh = decifrar(o.chaveUpstream, Buffer.from(grant.upstreamCiphertext, 'base64'), grantId);
    } catch {
      o.log.error('grant.cifra_invalida', { grant_id: grantId });
      throw new ErroV2('erro_interno', 'credencial da conexão ilegível');
    }
    const t = await pedirToken(
      o.idp.tokenUrl,
      { id: o.idp.clientId, segredo: o.idp.clientSecret },
      { grant_type: 'refresh_token', refresh_token: refresh },
    ).catch(async (e: unknown) => {
      if (e instanceof ErroV2 && e.codigo === 'reautenticar') await revogar(grantId, 'upstream_failed');
      throw e;
    });
    const papeis = new Set(papeisDoToken(t.access_token));
    if (!papeis.has(PAPEL_ACESSO)) {
      await revogar(grantId, 'role_removed');
      throw new ErroV2('reautenticar', 'acesso ao MCP retirado; peça a liberação e conecte de novo');
    }
    const escopos = new Set((grant.scopes ?? []).filter((s) => papeis.has(PAPEL_DO_ESCOPO[s as Escopo] ?? '')));
    const novo = { token: t.access_token, venceEm: agora() + t.expires_in * 1000, escopos };
    tokens.set(grantId, novo);
    return novo;
  };

  const tokenDoGrant = (grantId: string): Promise<TokenGrant> => {
    const atual = tokens.get(grantId);
    if (atual && atual.venceEm - 30_000 > agora()) return Promise.resolve(atual);
    let p = emCurso.get(grantId);
    if (!p) {
      p = renovar(grantId).finally(() => emCurso.delete(grantId));
      emCurso.set(grantId, p);
    }
    return p;
  };

  const montarCaminho = (op: OperacaoV2, valores: PedidoV2['caminho']) =>
    op.path.replace(/\{([^}]+)\}/g, (_m, nome: string) => {
      const v = String(valores?.[nome] ?? '');
      if (!PARAM_CAMINHO.test(v)) throw new ErroV2('invalido', `parâmetro de caminho inválido: ${nome}`);
      return encodeURIComponent(v);
    });

  return {
    escoposEfetivos: async (grantId) => (await tokenDoGrant(grantId)).escopos,

    async chamar<T>(p: PedidoV2): Promise<RespostaV2<T>> {
      const op = operacoes.get(p.operacao);
      if (!op) throw new ErroV2('erro_interno', 'operação fora do manifesto');
      for (const proibido of op.forbiddenParams ?? []) {
        const noCorpo = p.corpo && typeof p.corpo === 'object' && proibido in p.corpo;
        if (p.consulta?.[proibido] !== undefined || noCorpo) {
          throw new ErroV2('invalido', `parâmetro não permitido: ${proibido}`);
        }
      }
      if (op.idempotencyKey === 'required' && !p.idempotencyKey) {
        throw new ErroV2('erro_interno', 'operação com efeito exige Idempotency-Key');
      }
      conferirPeriodo(p.consulta, p.corpo);
      const url = new URL(`${o.baseUrl}${montarCaminho(op, p.caminho)}`);
      for (const [k, v] of Object.entries(p.consulta ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

      const t = await tokenDoGrant(p.grantId);
      const faltam = (p.escopos ?? []).filter((e) => !t.escopos.has(e));
      if (faltam.length > 0) {
        throw new ErroV2('insufficient_scope', 'permissão retirada desta conexão', { escopos: p.escopos ?? [] });
      }

      const liberar = OPERACOES_ANALITICAS.has(op.operationId) ? o.limites.analiticas.tentar() : () => {};
      if (!liberar) throw new ErroV2('ocupado', 'muitas consultas analíticas agora', { tentarNovamenteEmS: 5 });
      try {
        const cabecalhos: Record<string, string> = {
          authorization: `Bearer ${t.token}`,
          accept: 'application/json',
          'x-request-id': p.requestId,
          traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
        };
        if (p.corpo !== undefined) cabecalhos['content-type'] = 'application/json';
        if (op.method !== 'GET' && p.motivoAuditoria) cabecalhos['x-audit-reason'] = p.motivoAuditoria;
        if (p.idempotencyKey) cabecalhos['idempotency-key'] = p.idempotencyKey;
        const corpo = p.corpo === undefined ? undefined : JSON.stringify(p.corpo);

        // Só GET com 502 ganha uma nova tentativa; 503/Retry-After nunca é repetido aqui.
        for (let tentativa = 1; ; tentativa++) {
          let r: Response;
          try {
            r = await fetch(url, {
              method: op.method,
              headers: cabecalhos,
              signal: AbortSignal.timeout(timeoutMs),
              ...(corpo === undefined ? {} : { body: corpo }),
            });
          } catch {
            throw new ErroV2('tentar_novamente', 'plataforma não respondeu a tempo', { requestId: p.requestId });
          }
          if (r.status === 502 && op.method === 'GET' && tentativa === 1) continue;
          const dados = await lerCorpo(r);
          if (r.ok) {
            return {
              status: r.status,
              dados: semEnvelope(dados) as T,
              requestId: p.requestId,
              replay: r.headers.get('idempotent-replayed') === 'true',
            };
          }
          if (r.status === 401) tokens.delete(p.grantId);
          o.log.warn('v2.erro', { request_id: p.requestId, operacao: op.operationId, status: r.status });
          throw erroDaV2(r.status, dados, r.headers, p.requestId);
        }
      } finally {
        liberar();
      }
    },
  };
}
