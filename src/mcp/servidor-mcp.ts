import { createHash, createHmac, randomUUID } from 'node:crypto';
import { type AuthInfo, createMcpHandler, type McpHttpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Limites } from '../limites.js';
import { paramsAuditaveis, type Registrador } from '../log.js';
import { type ExtraDoToken, extraDoToken } from '../oauth/tipos.js';
import { type ClienteV2, ErroV2 } from '../v2/tipos.js';
import type { Auditoria, LinhaAuditoria } from './auditoria.js';
import { type ErroEnvelope, RESPOSTA_MAXIMA_BYTES } from './envelope.js';
import type { ContextoFerramenta, Ferramenta, RegistroChamada } from './ferramenta.js';
import { type No, PROVEDORES_PADRAO } from './provedores.js';

export type DependenciasMcp = {
  versao: string;
  ferramentas: readonly Ferramenta[];
  desligadas: ReadonlySet<string>;
  efeitosLigados: boolean;
  transcricoesLigadas: boolean;
  v2: ClienteV2;
  auditoria: Auditoria;
  log: Registrador;
  limites: Limites;
  chaves: { plano: Buffer; cursor: Buffer; auditoriaHmac: Buffer };
  /** Padrão: `PROVEDORES_PADRAO` (só nós genéricos). */
  provedores?: readonly No[];
  agora?: () => Date;
};

/** Ferramenta visível para o grant: ligada, efeito permitido e todos os escopos presentes. */
export function visivel(
  f: Ferramenta,
  escopos: ReadonlySet<string>,
  d: Pick<DependenciasMcp, 'desligadas' | 'efeitosLigados'>,
) {
  return !d.desligadas.has(f.nome) && (!f.efeito || d.efeitosLigados) && f.escopos.every((e) => escopos.has(e));
}

const ACOES: Record<string, string> = {
  reautenticar: 'Conecte o MCP de novo (login no navegador).',
  insufficient_scope: 'Peça ao administrador a permissão necessária.',
  nao_encontrado: 'Confira o identificador.',
  indisponivel_por_gate: 'A função está desligada na plataforma; não há o que fazer agora.',
  tentar_novamente: 'Tente de novo em instantes.',
  ocupado: 'Tente de novo em alguns segundos.',
  em_andamento: 'Já está em execução: consulte o status em vez de repetir.',
  invalido: 'Ajuste os parâmetros e tente de novo.',
  erro_interno: 'Tente de novo; se persistir, informe o request_id.',
};
const NEGADOS = new Set(['reautenticar', 'insufficient_scope', 'invalido']);

export function paraErro(e: unknown, requestId: string): ErroEnvelope {
  const v2 = e instanceof ErroV2 ? e : new ErroV2('erro_interno', 'erro inesperado');
  return {
    codigo: v2.codigo,
    mensagem: v2.message,
    acao_sugerida: ACOES[v2.codigo] ?? ACOES.erro_interno ?? '',
    tentar_novamente: ['tentar_novamente', 'ocupado', 'em_andamento'].includes(v2.codigo),
    ...(v2.detalhes.tentarNovamenteEmS ? { tentar_em_s: v2.detalhes.tentarNovamenteEmS } : {}),
    ...(v2.detalhes.gate ? { gate: v2.detalhes.gate } : {}),
    ...(v2.detalhes.escopos ? { escopos_necessarios: [...v2.detalhes.escopos] } : {}),
    request_id: requestId,
  };
}

/** Linha de auditoria com os parâmetros da allowlist da ferramenta (PII só como HMAC). */
export function linhaAuditoria(
  f: Pick<Ferramenta, 'nome' | 'paramsAuditaveis'>,
  token: ExtraDoToken,
  args: Record<string, unknown>,
  chaveHmac: Buffer,
  extra: Pick<LinhaAuditoria, 'outcome' | 'requestId' | 'latencyMs'> &
    Omit<RegistroChamada, 'outcome'> & { errorCode?: string },
): LinhaAuditoria {
  const { outcome, ...resto } = extra;
  return {
    tool: f.nome,
    userSub: token.sub,
    grantId: token.grantId,
    clientId: token.clientId,
    params: paramsAuditaveis(args, f.paramsAuditaveis, chaveHmac),
    paramsDigest: createHmac('sha256', chaveHmac)
      .update(JSON.stringify(args ?? {}))
      .digest('base64url'),
    ...resto,
    outcome,
  };
}

export const hashChave = (chave: string) => createHash('sha256').update(chave).digest('base64url');

/**
 * Handler MCP sem sessão: uma instância por requisição, só com as ferramentas que o escopo efetivo permite
 * (o portão em `portao.ts` já recalculou `authInfo.scopes`). Cada chamada gera uma linha de auditoria.
 */
export function criarHandlerMcp(d: DependenciasMcp): McpHttpHandler {
  return createMcpHandler(({ authInfo }) => criarServidorMcp(d, authInfo));
}

/** Catálogo e execução compartilhados pelos transportes HTTP e stdio. */
export function criarServidorMcp(d: DependenciasMcp, authInfo?: AuthInfo): McpServer {
  const agora = d.agora ?? (() => new Date());
  const servidor = new McpServer({ name: 'resgata-mcp', version: d.versao });
  const token = extraDoToken(authInfo?.extra);
  if (!authInfo || !token) return servidor;
  const escopos = new Set(authInfo.scopes);
  for (const f of d.ferramentas) {
    if (!visivel(f, escopos, d)) continue;
    servidor.registerTool(
      f.nome,
      {
        title: f.titulo,
        description: f.descricao,
        inputSchema: f.entrada,
        outputSchema: f.saida,
        annotations: f.anotacoes,
      },
      async (args: Record<string, unknown>) => {
        const requestId = randomUUID();
        const inicio = performance.now();
        const registro: RegistroChamada = {};
        // Fila de auditoria cheia: a chamada não executa e fica só no log, sem crescer a fila.
        const recusada = d.auditoria.cheia();
        let outcome: LinhaAuditoria['outcome'] = 'ok';
        let codigo: string | undefined;
        const linha = (o: LinhaAuditoria['outcome'], errorCode?: string) =>
          linhaAuditoria(f, token, args, d.chaves.auditoriaHmac, {
            targetType: registro.targetType,
            targetId: registro.targetId,
            planId: registro.planId,
            idempotencyKeyHash: registro.idempotencyKeyHash,
            outcome: o,
            requestId,
            latencyMs: Math.round(performance.now() - inicio),
            ...(errorCode ? { errorCode } : {}),
          });
        const ctx: ContextoFerramenta = {
          ...token,
          escopos,
          requestId,
          log: d.log,
          limites: d.limites,
          efeitosLigados: d.efeitosLigados,
          transcricoesLigadas: d.transcricoesLigadas,
          chaves: d.chaves,
          catalogo: { ferramentas: d.ferramentas, desligadas: d.desligadas },
          provedores: d.provedores ?? PROVEDORES_PADRAO,
          registro,
          agora,
          chamar: (p) => d.v2.chamar({ ...p, grantId: token.grantId, requestId, escopos: f.escopos }),
          antesDoEfeito: () => d.auditoria.registrarAgora(linha('accepted')),
        };
        try {
          if (recusada) {
            throw new ErroV2('ocupado', 'auditoria sobrecarregada; nada foi executado', { tentarNovamenteEmS: 5 });
          }
          const saida = f.saida.parse(await f.executar(args, ctx));
          const texto = JSON.stringify(saida);
          if (Buffer.byteLength(texto) > RESPOSTA_MAXIMA_BYTES) {
            throw new ErroV2('invalido', 'resposta grande demais; filtre mais ou pagine com limite menor');
          }
          outcome = registro.outcome ?? 'ok';
          return { content: [{ type: 'text', text: texto }], structuredContent: saida };
        } catch (e) {
          const erro = paraErro(e, requestId);
          if (!(e instanceof ErroV2)) d.log.error('ferramenta.falha', { request_id: requestId, ferramenta: f.nome });
          codigo = erro.codigo;
          outcome = NEGADOS.has(erro.codigo) ? 'denied' : 'error';
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ erro }) }],
            structuredContent: { erro },
          };
        } finally {
          // Sempre a linha final (ok, replayed ou error), com o mesmo requestId da `accepted` gravada antes do efeito.
          if (!recusada) d.auditoria.registrar(linha(outcome, codigo));
          d.log.info('mcp.tool_call', {
            request_id: requestId,
            grant_id: token.grantId,
            ferramenta: f.nome,
            resultado: outcome,
            codigo,
            latencia_ms: Math.round(performance.now() - inicio),
            params: paramsAuditaveis(args, f.paramsAuditaveis, d.chaves.auditoriaHmac),
          });
        }
      },
    );
  }
  return servidor;
}
