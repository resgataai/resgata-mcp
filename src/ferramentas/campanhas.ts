import * as z from 'zod';
import { envelope, horaBrt, janela, type Lacuna, saidaEnvelope } from '../mcp/envelope.js';
import { textoExterno } from '../mcp/mascara.js';
import {
  AVISO_TERCEIROS,
  cursor,
  definir,
  filtrosDe,
  LEITURA,
  limite,
  lista,
  nn,
  num,
  obj,
  periodo,
  posicao,
  proximo,
  sn,
  str,
  uuid,
} from './comum.js';

const ESCOPO = ['resgata:read.bi'] as const;
const contagens = z.record(z.string(), nn);
const paraContagens = (v: unknown) => Object.fromEntries(Object.entries(obj(v)).map(([k, n]) => [k, num(n)]));

const esquemaAudiencia = z.strictObject({
  id: sn,
  nome: sn,
  tipo: sn,
  fonte: sn,
  status: sn,
  contatos: nn,
  gerada_em: sn,
  usos: nn,
  ultimo_uso: sn,
  sistema: z.boolean(),
  revisao: nn,
  arquivada_em: sn,
});
const audiencia = (a: Record<string, unknown>) => ({
  id: str(a.id),
  nome: textoExterno(a.name, 120),
  tipo: str(a.kind),
  fonte: str(a.source),
  status: str(a.status),
  contatos: num(a.contacts),
  gerada_em: horaBrt(a.generatedAt),
  usos: num(a.timesUsed),
  ultimo_uso: horaBrt(a.lastUsedAt),
  sistema: a.system === true,
  revisao: num(a.revision),
  arquivada_em: horaBrt(a.archivedAt),
});

const audienciasListar = definir({
  nome: 'audiencias_listar',
  titulo: 'Audiências',
  descricao: `Audiências salvas com tipo, situação, quantidade de contatos e uso em campanhas. Só contagens. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['adminAudiencesList'],
  paramsAuditaveis: { tipo: 'claro', incluir_arquivadas: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quais audiências temos prontas?'],
  entrada: z.strictObject({
    tipo: z.enum(['fixed', 'dynamic']).optional(),
    incluir_arquivadas: z.boolean().default(false),
    cursor,
    limite,
  }),
  saida: saidaEnvelope(z.strictObject({}), esquemaAudiencia),
  async executar(args, ctx) {
    const filtros = filtrosDe(args);
    const c = posicao(ctx, 'audiencias_listar', filtros, args.cursor);
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'adminAudiencesList',
      consulta: {
        kind: args.tipo,
        includeArchived: args.incluir_arquivadas,
        limit: args.limite,
        cursor: c === undefined ? undefined : String(c),
      },
    });
    return envelope(ctx, {
      operacoes: ['adminAudiencesList'],
      dados: {},
      pagina: {
        itens: lista<Record<string, unknown>>(dados.items).map(audiencia),
        proximo_cursor: proximo(ctx, 'audiencias_listar', filtros, str(obj(dados.page).nextCursor)),
        total: null,
      },
    });
  },
});

const audienciaDetalhe = definir({
  nome: 'audiencia_detalhe',
  titulo: 'Detalhe da audiência',
  descricao: `Uma audiência: situação, revisão, geração, destinos e exclusões por canal (contagens). A definição de filtros não sai. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['adminAudiencesDetail'],
  paramsAuditaveis: { id: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quantos contatos tem a audiência X e quantos foram excluídos?'],
  entrada: z.strictObject({ id: uuid }),
  saida: saidaEnvelope(
    esquemaAudiencia.extend({
      descricao: sn,
      falha: sn,
      destinos: contagens,
      exclusoes: contagens,
      definicao_digest: sn,
      revisao_publicada: nn,
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'audience';
    ctx.registro.targetId = args.id;
    const { dados: a } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'adminAudiencesDetail',
      caminho: { id: args.id },
    });
    return envelope(ctx, {
      operacoes: ['adminAudiencesDetail'],
      dados: {
        ...audiencia(a),
        descricao: textoExterno(a.description, 500),
        falha: textoExterno(a.failureReason, 200),
        destinos: paraContagens(a.destinations),
        exclusoes: paraContagens(a.exclusions),
        definicao_digest: str(a.definitionDigest),
        revisao_publicada: num(a.publishedRevision),
      },
    });
  },
});

const esquemaContadores = z.strictObject({
  alvo: nn,
  elegiveis: nn,
  enviados: nn,
  falhas: nn,
  ignorados: nn,
  incertos: nn,
});
const esquemaCampanha = z.strictObject({
  id: sn,
  nome: sn,
  canal: sn,
  status: sn,
  finalidade: sn,
  audiencia: sn,
  agendada_para: sn,
  iniciada_em: sn,
  finalizada_em: sn,
  motivo_fim: sn,
  contadores: esquemaContadores,
});
const campanha = (c: Record<string, unknown>) => {
  const n = obj(c.counters);
  return {
    id: str(c.id),
    nome: textoExterno(c.name, 120),
    canal: str(c.channel),
    status: str(c.status),
    finalidade: str(c.campaignPurpose),
    audiencia: textoExterno(c.audienceName, 120),
    agendada_para: horaBrt(c.scheduledAt),
    iniciada_em: horaBrt(c.startedAt),
    finalizada_em: horaBrt(c.finishedAt),
    motivo_fim: str(c.terminalReason),
    contadores: {
      alvo: num(n.target),
      elegiveis: num(n.eligible),
      enviados: num(n.sent),
      falhas: num(n.failed),
      ignorados: num(n.skipped),
      incertos: num(n.uncertain),
    },
  };
};

const campanhasListar = definir({
  nome: 'campanhas_listar',
  titulo: 'Campanhas',
  descricao: `Campanhas com canal, situação, agenda e contadores de envio. Só contagens. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['adminCampaignsList'],
  paramsAuditaveis: { status: 'claro', canal: 'claro', de: 'claro', ate: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quais campanhas rodaram esta semana?', 'Tem campanha de SMS agendada?'],
  entrada: z.strictObject({
    status: z
      .string()
      .regex(/^[a-z_]{1,30}$/)
      .optional(),
    canal: z
      .string()
      .regex(/^[a-z_]{1,20}$/)
      .optional(),
    ...periodo,
    cursor,
    limite,
  }),
  saida: saidaEnvelope(z.strictObject({}), esquemaCampanha),
  async executar(args, ctx) {
    const j = args.de || args.ate ? janela(args.de, args.ate, 30, ctx.agora()) : undefined;
    const filtros = filtrosDe(args);
    const c = posicao(ctx, 'campanhas_listar', filtros, args.cursor);
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'adminCampaignsList',
      consulta: {
        status: args.status,
        channel: args.canal,
        scheduledFrom: j?.from,
        scheduledTo: j?.to,
        limit: args.limite,
        cursor: c === undefined ? undefined : String(c),
      },
    });
    return envelope(ctx, {
      operacoes: ['adminCampaignsList'],
      dados: {},
      pagina: {
        itens: lista<Record<string, unknown>>(dados.items).map(campanha),
        proximo_cursor: proximo(ctx, 'campanhas_listar', filtros, str(obj(dados.page).nextCursor)),
        total: num(dados.total),
      },
      ...(j ? { periodo: j } : {}),
    });
  },
});

const resultados = definir({
  nome: 'campanha_resultados',
  titulo: 'Resultados da campanha',
  descricao: `Resultado de uma campanha: destinatários por situação, rejeições da audiência por código, custo e retorno. Tentativas por destinatário só com leitura de clientes. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: [
    'adminCampaignsGet',
    'adminCampaignsResults',
    'adminCampaignsRejections',
    'adminCampaignEconomics',
    'adminCampaignsAttempts',
  ],
  paramsAuditaveis: { id: 'claro', incluir_tentativas: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Como foi a campanha de ontem?', 'Quantos e-mails da campanha X falharam e por quê?'],
  entrada: z.strictObject({ id: uuid, incluir_tentativas: z.boolean().default(false), cursor }),
  saida: saidaEnvelope(
    z.strictObject({
      campanha: esquemaCampanha,
      por_situacao: contagens,
      rejeicoes: z.strictObject({ total: nn, por_codigo: contagens }),
      economia: z.strictObject({
        custo: nn,
        custo_estimado: z.boolean(),
        propostas: nn,
        clientes_convertidos: nn,
        desembolsado_liquido: nn,
        receita: nn,
        resultado: nn,
        roi: nn,
        atribuicao_comprovada: z.boolean(),
        regra_atribuicao: sn,
      }),
    }),
    z.strictObject({
      tentativa: nn,
      destinatario_id: sn,
      status: sn,
      status_provedor: sn,
      codigo_falha: sn,
      aceita_em: sn,
      concluida_em: sn,
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'campaign';
    ctx.registro.targetId = args.id;
    const caminho = { id: args.id };
    const [get, res, rej, eco] = await Promise.all([
      ctx.chamar<Record<string, unknown>>({ operacao: 'adminCampaignsGet', caminho }),
      ctx.chamar<Record<string, unknown>>({ operacao: 'adminCampaignsResults', caminho }),
      ctx.chamar<Record<string, unknown>>({ operacao: 'adminCampaignsRejections', caminho, consulta: { limit: 200 } }),
      ctx.chamar<Record<string, unknown>>({ operacao: 'adminCampaignEconomics', caminho }),
    ]);
    const porCodigo: Record<string, number> = {};
    for (const r of lista<Record<string, unknown>>(rej.dados.items)) {
      const k = String(r.code ?? 'desconhecido');
      porCodigo[k] = (porCodigo[k] ?? 0) + 1;
    }
    const lacunas: Lacuna[] = [];
    if (rej.dados.page && obj(rej.dados.page).hasMore === true) {
      lacunas.push({ codigo: 'rejeicoes_amostra', mensagem: 'por_codigo conta só as 200 primeiras rejeições' });
    }
    let pagina: { itens: unknown[]; proximo_cursor: string | null; total: null } | undefined;
    if (args.incluir_tentativas && !ctx.escopos.has('resgata:read.clientes')) {
      lacunas.push({
        codigo: 'tentativas_exigem_read_clientes',
        mensagem: 'tentativas por destinatário exigem resgata:read.clientes',
      });
    } else if (args.incluir_tentativas) {
      const filtros = filtrosDe(args);
      const c = posicao(ctx, 'campanha_resultados', filtros, args.cursor);
      const t = await ctx.chamar<Record<string, unknown>>({
        operacao: 'adminCampaignsAttempts',
        caminho,
        consulta: { limit: 50, cursor: c === undefined ? undefined : String(c) },
      });
      pagina = {
        itens: lista<Record<string, unknown>>(t.dados.items).map((a) => ({
          tentativa: num(a.attemptNumber),
          destinatario_id: str(a.recipientId),
          status: str(a.status),
          status_provedor: str(a.providerStatus),
          codigo_falha: str(a.failureCode) ?? str(a.providerErrorCode),
          aceita_em: horaBrt(a.providerAcceptedAt),
          concluida_em: horaBrt(a.completedAt),
        })),
        proximo_cursor: proximo(ctx, 'campanha_resultados', filtros, str(obj(t.dados.page).nextCursor)),
        total: null,
      };
    }
    const e = eco.dados;
    return envelope(ctx, {
      operacoes: [
        'adminCampaignsGet',
        'adminCampaignsResults',
        'adminCampaignsRejections',
        'adminCampaignEconomics',
        ...(pagina ? ['adminCampaignsAttempts'] : []),
      ],
      dados: {
        campanha: campanha(get.dados),
        por_situacao: paraContagens(res.dados.byStatus),
        rejeicoes: { total: num(rej.dados.total), por_codigo: porCodigo },
        economia: {
          custo: num(e.cost),
          custo_estimado: e.costEstimated === true,
          propostas: num(e.proposals),
          clientes_convertidos: num(e.convertedCustomers),
          desembolsado_liquido: num(e.disbursedNet),
          receita: num(e.revenue),
          resultado: num(e.result),
          roi: num(e.roi),
          atribuicao_comprovada: e.attributionProven === true,
          regra_atribuicao: str(e.attributionRule),
        },
      },
      ...(pagina ? { pagina } : {}),
      lacunas,
    });
  },
});

export const FERRAMENTAS_CAMPANHAS = [audienciasListar, audienciaDetalhe, campanhasListar, resultados];
