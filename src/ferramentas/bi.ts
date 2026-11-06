import * as z from 'zod';
import { envelope, horaBrt, janela, type Lacuna, saidaEnvelope } from '../mcp/envelope.js';
import { textoExterno } from '../mcp/mascara.js';
import { definir, LEITURA, lista, nn, num, obj, periodo, sn, str } from './comum.js';

const ESCOPO = ['resgata:read.bi'] as const;
const codigo = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

const kpis = z.strictObject({
  simulacoes: nn,
  propostas: nn,
  conversao_simulacao_proposta: nn,
  desembolsadas: nn,
  volume_bruto_desembolsado: nn,
  volume_liquido_desembolsado: nn,
  volume_bruto_criado: nn,
  volume_liquido_criado: nn,
  ticket_medio: nn,
  ticket_mediano: nn,
});
const lerKpis = (k: unknown) => {
  const v = obj(k);
  return {
    simulacoes: num(v.simulationsCount),
    propostas: num(v.proposalsCount),
    conversao_simulacao_proposta: num(v.conversionRateSimulations),
    desembolsadas: num(v.disbursedCount),
    volume_bruto_desembolsado: num(v.grossVolume),
    volume_liquido_desembolsado: num(v.netVolume),
    volume_bruto_criado: num(v.grossCreatedVolume),
    volume_liquido_criado: num(v.netCreatedVolume),
    ticket_medio: num(v.avgTicket),
    ticket_mediano: num(v.ticketMedian),
  };
};

const hoje = definir({
  nome: 'bi_hoje',
  titulo: 'Painel do dia',
  descricao:
    'Indicadores de hoje (America/Sao_Paulo): simulações, propostas, desembolsos, volumes, funil e gargalo de assinatura; com comparar=true traz a janela anterior de mesma duração. Só agregados.',
  escopos: ESCOPO,
  operacoes: ['todayCockpit'],
  paramsAuditaveis: { comparar: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Como está o dia hoje?', 'Quanto desembolsamos hoje comparado a ontem?'],
  entrada: z.strictObject({ comparar: z.boolean().default(false) }),
  saida: saidaEnvelope(
    z.strictObject({
      kpis,
      kpis_janela_anterior: kpis.nullable(),
      funil: z.record(z.string(), nn),
      gargalo_assinatura: z.strictObject({
        quantidade: nn,
        volume_bruto: nn,
        limite_horas: nn,
        aproximado: z.boolean(),
      }),
      por_fundo: z.array(z.strictObject({ fundo: sn, quantidade: nn, volume: nn, participacao: nn })),
    }),
  ),
  async executar(args, ctx) {
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'todayCockpit',
      consulta: { compare: args.comparar ? 'previous' : undefined, pipelineLimit: 1 },
    });
    const gargalo = obj(dados.signatureBottleneck);
    return envelope(ctx, {
      operacoes: ['todayCockpit'],
      dados: {
        kpis: lerKpis(dados.kpis),
        kpis_janela_anterior: dados.previousKpis ? lerKpis(dados.previousKpis) : null,
        funil: Object.fromEntries(Object.entries(obj(dados.funnel)).map(([k, v]) => [k, num(v)])),
        gargalo_assinatura: {
          quantidade: num(gargalo.count),
          volume_bruto: num(gargalo.grossVolume),
          limite_horas: num(gargalo.thresholdHours),
          aproximado: gargalo.approximate === true,
        },
        por_fundo: lista<Record<string, unknown>>(dados.billingByFund).map((f) => ({
          fundo: str(f.fund),
          quantidade: num(f.count),
          volume: num(f.volume),
          participacao: num(f.sharePct),
        })),
      },
      definicoes: {
        simulacoes: 'cada CPF conta uma vez por dia (America/Sao_Paulo)',
        conversao_simulacao_proposta: 'propostas ÷ simulações; não é a conversão até o desembolso',
      },
      lacunas: [{ codigo: 'esteira_fora', mensagem: 'A esteira com nomes de clientes não entra em ferramenta de BI.' }],
    });
  },
});

const mes = (d: string) => d.slice(0, 7);

const conversao = definir({
  nome: 'bi_conversao',
  titulo: 'Conversão e gargalos',
  descricao:
    'Funil do período (entradas, etapas, paradas e motivos), conversão por mês, produto e canal de origem, e contagens de aquisição com a cobertura das fontes. Só agregados. Período máximo de 92 dias.',
  escopos: ESCOPO,
  operacoes: ['conversionOverview', 'dashboard_1', 'adminConversionBottlenecks'],
  paramsAuditaveis: { de: 'claro', ate: 'claro', canal: 'claro', produto: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quais canais converteram mais nos últimos 30 dias?', 'Onde os clientes estão parando no funil?'],
  entrada: z.strictObject({ ...periodo, canal: codigo.optional(), produto: codigo.optional() }),
  saida: saidaEnvelope(
    z.strictObject({
      funil: z.strictObject({
        entradas: nn,
        em_andamento: nn,
        desembolsadas: nn,
        origem: z.record(z.string(), nn),
        etapas: z.array(
          z.strictObject({
            etapa: sn,
            chegaram: nn,
            pararam: nn,
            pendentes: nn,
            motivos: z.array(z.strictObject({ motivo: sn, quantidade: nn })),
          }),
        ),
      }),
      por_mes: z.array(
        z.strictObject({
          mes: sn,
          produto: sn,
          canal_origem: sn,
          propostas_criadas: nn,
          contratos_pagos: nn,
          valor_liquido_pago: nn,
          clientes_novos: nn,
          clientes_recorrentes: nn,
        }),
      ),
      mes_corrente_parcial: z.boolean(),
      aquisicao: z.array(z.strictObject({ codigo: sn, rotulo: sn, quantidade: nn, fonte: sn })),
    }),
  ),
  async executar(args, ctx) {
    const j = janela(args.de, args.ate, 30, ctx.agora());
    // Em série, não em paralelo: as três são analíticas e dividem o semáforo do pod.
    const gargalos = await ctx.chamar<Record<string, unknown>>({
      operacao: 'adminConversionBottlenecks',
      consulta: { from: j.from, to: j.to },
    });
    const visao = await ctx.chamar<Record<string, unknown>>({
      operacao: 'conversionOverview',
      consulta: { fromMonth: mes(j.de), toMonth: mes(j.ate) },
    });
    const aquisicao = await ctx.chamar<Record<string, unknown>>({
      operacao: 'dashboard_1',
      consulta: { from: j.from, to: j.to, productCode: args.produto, size: 1 },
    });
    const g = gargalos.dados;
    const avisos = lista<string>(obj(aquisicao.dados.coverage).warnings).concat(
      lista<string>(aquisicao.dados.warnings),
    );
    return envelope(ctx, {
      operacoes: ['adminConversionBottlenecks', 'conversionOverview', 'dashboard_1'],
      dados: {
        funil: {
          entradas: num(g.entered),
          em_andamento: num(g.inProgress),
          desembolsadas: num(g.disbursed),
          origem: Object.fromEntries(Object.entries(obj(g.origin)).map(([k, v]) => [k, num(v)])),
          etapas: lista<Record<string, unknown>>(g.stages).map((s) => ({
            etapa: textoExterno(s.label, 120),
            chegaram: num(s.arrived),
            pararam: num(s.stopped),
            pendentes: num(s.pending),
            motivos: lista<Record<string, unknown>>(s.reasons)
              .slice(0, 10)
              .map((m) => ({ motivo: textoExterno(m.label, 200), quantidade: num(m.count) })),
          })),
        },
        por_mes: lista<Record<string, unknown>>(visao.dados.rows)
          .filter(
            (r) => (!args.produto || r.product === args.produto) && (!args.canal || r.originChannel === args.canal),
          )
          .map((r) => ({
            mes: str(r.month),
            produto: str(r.product),
            canal_origem: str(r.originChannel),
            propostas_criadas: num(r.proposalsCreated),
            contratos_pagos: num(r.contractsPaid),
            valor_liquido_pago: num(r.paidNetValue),
            clientes_novos: num(r.newClients),
            clientes_recorrentes: num(r.returningClients),
          })),
        mes_corrente_parcial: visao.dados.currentMonthPartial === true,
        aquisicao: lista<Record<string, unknown>>(aquisicao.dados.counts).map((c) => ({
          codigo: str(c.code),
          rotulo: textoExterno(c.label, 120),
          quantidade: num(c.count),
          fonte: str(c.source),
        })),
      },
      periodo: j,
      definicoes: { por_mes: 'meses inteiros que tocam o período; o mês corrente é parcial' },
      lacunas: avisos
        .filter((a) => typeof a === 'string')
        .slice(0, 10)
        .map((a) => ({ codigo: 'cobertura_aquisicao', mensagem: textoExterno(a, 300) ?? '' })),
    });
  },
});

const canaisCustos = definir({
  nome: 'bi_canais_custos',
  titulo: 'Canais: custo e retorno',
  descricao:
    'Custo, propostas, desembolso, receita, resultado, CAC e ROI por canal no período, com regra de atribuição; custos unitários vigentes; gasto de anúncios quando a integração estiver ligada (senão aparece como lacuna). Período máximo de 92 dias.',
  escopos: ESCOPO,
  operacoes: ['channelEconomicsScreen', 'adminChannelUnitCosts', 'adminAdsSpend'],
  paramsAuditaveis: { de: 'claro', ate: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quanto custou cada canal no último mês e quanto retornou?'],
  entrada: z.strictObject(periodo),
  saida: saidaEnvelope(
    z.strictObject({
      canais: z.array(
        z.strictObject({
          canal: sn,
          fonte: sn,
          custo: nn,
          custo_estimado: z.boolean(),
          clientes_convertidos: nn,
          propostas: nn,
          desembolsado_liquido: nn,
          receita: nn,
          resultado: nn,
          cac: nn,
          roi: nn,
          atribuicao_comprovada: z.boolean(),
        }),
      ),
      custos_unitarios: z.array(
        z.strictObject({ canal: sn, categoria: sn, unidade: sn, valor_minor: nn, moeda: sn, vigente_desde: sn }),
      ),
      anuncios: z.array(z.strictObject({ canal: sn, custo_brl: nn, cliques: nn, impressoes: nn })),
    }),
  ),
  async executar(args, ctx) {
    const j = janela(args.de, args.ate, 30, ctx.agora());
    const tela = await ctx.chamar<Record<string, unknown>>({
      operacao: 'channelEconomicsScreen',
      consulta: { from: j.from, to: j.to },
    });
    const [custos, anuncios] = await Promise.all([
      ctx.chamar<unknown[]>({ operacao: 'adminChannelUnitCosts' }),
      ctx.chamar<Record<string, unknown>>({ operacao: 'adminAdsSpend', consulta: { from: j.from, to: j.to } }),
    ]);
    const def = obj(tela.dados.definitions);
    const lacunas: Lacuna[] = [];
    const canaisAnuncio = lista<Record<string, unknown>>(anuncios.dados.channels);
    if (canaisAnuncio.length === 0) {
      lacunas.push({
        codigo: 'gasto_anuncios_indisponivel',
        mensagem: 'Gasto de anúncios indisponível: integração desligada ou sem dados no período.',
      });
    }
    for (const bloco of ['email', 'sms'] as const) {
      const b = obj(tela.dados[bloco]);
      if (b.state && b.state !== 'available') {
        lacunas.push({
          codigo: `${bloco}_indisponivel`,
          mensagem: textoExterno(b.reason, 200) ?? `${bloco} indisponível`,
        });
      }
    }
    return envelope(ctx, {
      operacoes: ['channelEconomicsScreen', 'adminChannelUnitCosts', 'adminAdsSpend'],
      dados: {
        canais: lista<Record<string, unknown>>(obj(tela.dados.channelSummary).channels).map((c) => ({
          canal: str(c.channel),
          fonte: str(c.source),
          custo: num(c.cost),
          custo_estimado: c.costEstimated === true,
          clientes_convertidos: num(c.convertedCustomers),
          propostas: num(c.proposals),
          desembolsado_liquido: num(c.disbursedNet),
          receita: num(c.revenue),
          resultado: num(c.result),
          cac: num(c.cac),
          roi: num(c.roi),
          atribuicao_comprovada: c.attributionProven === true,
        })),
        custos_unitarios: lista<Record<string, unknown>>(custos.dados).map((t) => ({
          canal: str(t.channel),
          categoria: str(t.category),
          unidade: str(t.unit),
          valor_minor: num(t.valueMinor),
          moeda: str(t.currency),
          vigente_desde: str(t.validFrom),
        })),
        anuncios: canaisAnuncio.map((a) => ({
          canal: str(a.channel),
          custo_brl: num(a.costBrl),
          cliques: num(a.clicks),
          impressoes: num(a.impressions),
        })),
      },
      periodo: j,
      definicoes: {
        regra_atribuicao: str(def.attributionRule),
        definicao_pago: str(def.paidDefinition),
        taxa_comissao: num(def.commissionRate),
        base_comissao: str(def.commissionBasis),
        moeda: str(def.currency),
      },
      lacunas,
    });
  },
});

const desembolsos = definir({
  nome: 'bi_desembolsos',
  titulo: 'Desembolsos',
  descricao:
    'Quantidade e volumes desembolsados no período (data de desembolso), por oferta ou por fundo, e a série diária. Só agregados. Período máximo de 92 dias.',
  escopos: ESCOPO,
  operacoes: ['disbursedOffers', 'todayCockpit'],
  paramsAuditaveis: { de: 'claro', ate: 'claro', agrupamento: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quanto desembolsamos esta semana?', 'Desembolsos do mês por fundo'],
  entrada: z.strictObject({ ...periodo, agrupamento: z.enum(['oferta', 'fundo']).default('fundo') }),
  saida: saidaEnvelope(
    z.strictObject({
      total: z.strictObject({ quantidade: nn, volume_bruto: nn, volume_liquido: nn }),
      grupos: z.array(z.strictObject({ grupo: sn, quantidade: nn, volume_bruto: nn, volume_liquido: nn })),
      serie: z.array(z.strictObject({ inicio: sn, desembolsadas: nn })),
    }),
  ),
  async executar(args, ctx) {
    const j = janela(args.de, args.ate, 1, ctx.agora());
    const ofertas = await ctx.chamar<Record<string, unknown>>({
      operacao: 'disbursedOffers',
      consulta: { from: j.from, to: j.to, basis: 'disbursed' },
    });
    const cockpit = await ctx.chamar<Record<string, unknown>>({
      operacao: 'todayCockpit',
      consulta: { from: j.from, to: j.to, basis: 'disbursed', granularity: 'day', pipelineLimit: 1 },
    });
    const grupos = new Map<string, { quantidade: number; bruto: number; liquido: number }>();
    for (const o of lista<Record<string, unknown>>(ofertas.dados.offers)) {
      const chave = String((args.agrupamento === 'oferta' ? o.offer : o.fund) ?? 'desconhecido');
      const g = grupos.get(chave) ?? { quantidade: 0, bruto: 0, liquido: 0 };
      g.quantidade += num(o.count) ?? 0;
      g.bruto += num(o.grossSum) ?? 0;
      g.liquido += num(o.netSum) ?? 0;
      grupos.set(chave, g);
    }
    const k = lerKpis(cockpit.dados.kpis);
    return envelope(ctx, {
      operacoes: ['disbursedOffers', 'todayCockpit'],
      dados: {
        total: {
          quantidade: k.desembolsadas,
          volume_bruto: k.volume_bruto_desembolsado,
          volume_liquido: k.volume_liquido_desembolsado,
        },
        grupos: [...grupos].map(([grupo, g]) => ({
          grupo,
          quantidade: g.quantidade,
          volume_bruto: g.bruto,
          volume_liquido: g.liquido,
        })),
        serie: lista<Record<string, unknown>>(obj(cockpit.dados.series).points).map((p) => ({
          inicio: horaBrt(p.ts),
          desembolsadas: num(p.disbursed),
        })),
      },
      periodo: j,
      definicoes: { base: 'data de desembolso, status desembolsado' },
    });
  },
});

export const FERRAMENTAS_BI = [hoje, conversao, canaisCustos, desembolsos];
