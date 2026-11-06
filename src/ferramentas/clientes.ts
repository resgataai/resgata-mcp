import * as z from 'zod';
import { envelope, horaBrt, janela, type Lacuna, saidaEnvelope } from '../mcp/envelope.js';
import { mascararCpf, mascararEmail, mascararTelefone, textoExterno } from '../mcp/mascara.js';
import { ErroV2 } from '../v2/tipos.js';
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

const ESCOPO = ['resgata:read.clientes'] as const;
const produto = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,19}$/)
  .describe('código do produto, ex.: CLT, FGTS');

/** Cadastro mínimo de `lookup` (o agregado da V2 traz mais; só isto sai). */
function cadastro(perfil: unknown) {
  const u = obj(obj(perfil).user);
  return {
    userUuid: str(u.userUuid),
    nome: textoExterno(u.name, 120),
    documento: mascararCpf(str(u.cpf)),
    email: mascararEmail(str(u.email)),
    telefone: mascararTelefone(str(u.phone1)),
  };
}
const esquemaCadastro = z.strictObject({ userUuid: sn, nome: sn, documento: sn, email: sn, telefone: sn });

const buscar = definir({
  nome: 'clientes_buscar',
  titulo: 'Buscar cliente',
  descricao: `Encontra o cliente por CPF, e-mail ou telefone (um deles) e devolve o userUuid para as outras ferramentas. Dados pessoais mascarados. Busca por nome só no incremento 2. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['lookup'],
  paramsAuditaveis: { cpf: 'hmac', email: 'hmac', telefone: 'hmac' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Ache o cliente do CPF 000.000.001-91', 'Quem é o cliente com o e-mail fulano@exemplo.com?'],
  entrada: z
    .strictObject({
      cpf: z.string().max(20).optional(),
      email: z.email().max(200).optional(),
      telefone: z.string().max(25).optional(),
    })
    .refine(
      (a) => [a.cpf, a.email, a.telefone].filter(Boolean).length === 1,
      'informe exatamente um: cpf, email ou telefone',
    ),
  saida: saidaEnvelope(z.strictObject({ criterio: z.enum(['cpf', 'email', 'telefone']) }), esquemaCadastro),
  async executar(args, ctx) {
    const criterio = args.cpf ? 'cpf' : args.email ? 'email' : 'telefone';
    const corpo = args.cpf
      ? { cpf: args.cpf.replace(/\D/g, '') }
      : args.email
        ? { email: args.email }
        : { phone: (args.telefone ?? '').replace(/\D/g, '') };
    let itens: Array<ReturnType<typeof cadastro>> = [];
    try {
      const { dados } = await ctx.chamar({ operacao: 'lookup', corpo });
      itens = [cadastro(dados)];
    } catch (e) {
      if (!(e instanceof ErroV2 && e.codigo === 'nao_encontrado')) throw e;
    }
    if (itens[0]?.userUuid) ctx.registro.targetType = 'user';
    if (itens[0]?.userUuid) ctx.registro.targetId = itens[0].userUuid;
    return envelope(ctx, {
      operacoes: ['lookup'],
      dados: { criterio },
      pagina: { itens, proximo_cursor: null, total: itens.length },
      lacunas: itens.length === 0 ? [{ codigo: 'nao_encontrado', mensagem: 'nenhum cliente com esse dado' }] : [],
    });
  },
});

type Bloco = { state?: string; reason?: string; data?: unknown };
const estado = (b: unknown) => ({ estado: str(obj(b).state) ?? 'unknown', motivo: textoExterno(obj(b).reason, 200) });
const esquemaEstado = { estado: z.string(), motivo: sn };

const dossie = definir({
  nome: 'cliente_dossie',
  titulo: 'Dossiê do cliente',
  descricao: `Resumo do cliente: cadastro mascarado, propostas, situação financeira em contagens, conversas ligadas, comunicações recentes e contatos compartilhados com outras pessoas. Cada bloco traz estado (available/unavailable) e motivo. Conta bancária, renda, endereço e valores financeiros pessoais ficam fora. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['lookup', 'getUserRecord'],
  paramsAuditaveis: { userUuid: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Me dê o dossiê deste cliente', 'Esse cliente tem proposta em andamento?'],
  entrada: z.strictObject({ userUuid: uuid }),
  saida: saidaEnvelope(
    z.strictObject({
      cadastro: esquemaCadastro.extend({ situacao_conta: sn, criado_em: sn }),
      propostas: z.array(
        z.strictObject({
          proposalUuid: sn,
          status: sn,
          status_rotulo: sn,
          produto: sn,
          provedor: sn,
          valor_liquido: nn,
          desembolso: sn,
          atualizada_em: sn,
        }),
      ),
      financas: z.strictObject({
        ...esquemaEstado,
        propostas: nn,
        desembolsadas: nn,
        parcelas_em_atraso: nn,
        dias_em_atraso: nn,
        proximo_vencimento: sn,
      }),
      conversas: z.strictObject({
        ...esquemaEstado,
        cobertura: sn,
        itens: z.array(z.strictObject({ conversationId: nn, ligada_em: sn, ligacoes: z.array(z.string()) })),
      }),
      comunicacoes: z.strictObject({
        ...esquemaEstado,
        itens: z.array(
          z.strictObject({ canal: sn, quando: sn, resultado: sn, fonte: sn, titulo: sn, produto: sn, falha: sn }),
        ),
      }),
      contatos_compartilhados: z.strictObject({
        ...esquemaEstado,
        total: nn,
        itens: z.array(z.strictObject({ tipo: sn, valor: sn, principal: z.boolean(), outras_pessoas: nn })),
      }),
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'user';
    ctx.registro.targetId = args.userUuid;
    const [perfil, registro] = await Promise.all([
      ctx.chamar<Record<string, unknown>>({ operacao: 'lookup', corpo: { uuid: args.userUuid } }),
      ctx.chamar<Record<string, Bloco>>({
        operacao: 'getUserRecord',
        caminho: { userUuid: args.userUuid },
        consulta: { conversationsLimit: 10, limit: 10 },
      }),
    ]);
    const u = obj(perfil.dados.user);
    const r = registro.dados;
    const fin = obj(r.finance?.data);
    const conv = obj(r.conversations?.data);
    const com = obj(r.communications?.data);
    const comp = obj(r.sharedContacts?.data);
    return envelope(ctx, {
      operacoes: ['lookup', 'getUserRecord'],
      dados: {
        cadastro: { ...cadastro(perfil.dados), situacao_conta: str(u.accountStatus), criado_em: horaBrt(u.createdAt) },
        propostas: lista<Record<string, unknown>>(perfil.dados.proposals)
          .slice(0, 20)
          .map((p) => ({
            proposalUuid: str(p.proposalUuid),
            status: str(p.status),
            status_rotulo: str(p.statusHumanLabel),
            produto: str(p.productCode),
            provedor: str(p.providerCode),
            valor_liquido: num(p.netValue),
            desembolso: str(p.disbursementDate),
            atualizada_em: horaBrt(p.updatedAt),
          })),
        financas: {
          ...estado(r.finance),
          propostas: num(fin.proposalsCount),
          desembolsadas: num(fin.disbursedCount),
          parcelas_em_atraso: num(fin.installmentsOverdue),
          dias_em_atraso: num(fin.daysPastDue),
          proximo_vencimento: str(fin.nextInstallmentDueDate),
        },
        conversas: {
          ...estado(r.conversations),
          cobertura: str(conv.coverage),
          itens: lista<Record<string, unknown>>(conv.items).map((c) => ({
            conversationId: num(c.conversationId),
            ligada_em: horaBrt(c.lastLinkedAt),
            ligacoes: lista<string>(c.linkedBy).filter((x) => typeof x === 'string'),
          })),
        },
        comunicacoes: {
          ...estado(r.communications),
          itens: lista<Record<string, unknown>>(com.items).map((c) => ({
            canal: str(c.channel),
            quando: horaBrt(c.occurredAt),
            resultado: str(c.outcome),
            fonte: str(c.source),
            titulo: textoExterno(c.title, 200),
            produto: str(c.product),
            falha: textoExterno(c.failureReason, 200),
          })),
        },
        contatos_compartilhados: {
          ...estado(r.sharedContacts),
          total: num(comp.sharedContactsCount),
          itens: lista<Record<string, unknown>>(comp.contacts).map((c) => ({
            tipo: str(c.kind),
            valor: c.kind === 'EMAIL' ? mascararEmail(str(c.value)) : mascararTelefone(str(c.value)),
            principal: c.primary === true,
            outras_pessoas: num(c.sharedWithCount),
          })),
        },
      },
      lacunas: [
        {
          codigo: 'financeiro_pessoal_fora',
          mensagem: 'Conta bancária, renda, endereço e valores financeiros pessoais não vão ao contexto da IA.',
        },
        {
          codigo: 'envio_individual_fora_do_historico',
          mensagem: 'Envios individuais de modelo não aparecem no histórico de comunicações da plataforma.',
        },
      ],
    });
  },
});

const linhaDoTempo = definir({
  nome: 'cliente_linha_do_tempo',
  titulo: 'Linha do tempo do cliente',
  descricao: `Eventos do cliente em ordem, com tipo, horário (America/Sao_Paulo) e resumo. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['timeline'],
  paramsAuditaveis: { userUuid: 'claro', desde: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['O que aconteceu com este cliente na última semana?'],
  entrada: z.strictObject({ userUuid: uuid, desde: periodo.de, cursor, limite }),
  saida: saidaEnvelope(
    z.strictObject({ userUuid: z.string() }),
    z.strictObject({
      quando: sn,
      tipo: sn,
      subtipo: sn,
      resumo: sn,
      proposalUuid: sn,
      recuperado: z.boolean().nullable(),
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'user';
    ctx.registro.targetId = args.userUuid;
    const filtros = filtrosDe(args);
    const pagina = Number(posicao(ctx, 'cliente_linha_do_tempo', filtros, args.cursor) ?? 0);
    const { dados } = await ctx.chamar<{ data?: unknown[]; meta?: { hasNext?: boolean; total?: number } }>({
      operacao: 'timeline',
      caminho: { userUuid: args.userUuid },
      consulta: { since: args.desde ? `${args.desde}T00:00:00-03:00` : undefined, page: pagina, size: args.limite },
    });
    const itens = lista<Record<string, unknown>>(dados.data).map((e) => ({
      quando: horaBrt(e.occurredAt),
      tipo: str(e.kind),
      subtipo: str(e.subtype),
      resumo: textoExterno(e.summary, 300),
      proposalUuid: str(e.proposalUuid),
      recuperado: typeof e.recovered === 'boolean' ? e.recovered : null,
    }));
    return envelope(ctx, {
      operacoes: ['timeline'],
      dados: { userUuid: args.userUuid },
      pagina: {
        itens,
        proximo_cursor: proximo(ctx, 'cliente_linha_do_tempo', filtros, dados.meta?.hasNext ? pagina + 1 : null),
        total: num(dados.meta?.total),
      },
    });
  },
});

const esquemaCelula = z.strictObject({
  produto: sn,
  etapa: sn,
  codigo_etapa: sn,
  resultado: sn,
  canal: sn,
  tentativa_id: sn,
  inicio_tentativa: sn,
  erro: z.strictObject({ codigo: sn, classe: sn, resumo: sn, provedor: sn }).nullable(),
});

const jornadaListar = definir({
  nome: 'jornada_listar',
  titulo: 'Lista da Jornada',
  descricao: `A lista da página Jornada do painel (cliente × produto: etapa, resultado, erro e canal), com os mesmos filtros. O termo de busca vai no corpo, nunca na URL. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['selfContractingCustomersSearch'],
  paramsAuditaveis: {
    de: 'claro',
    ate: 'claro',
    produto: 'claro',
    resultado: 'claro',
    erro: 'claro',
    status: 'claro',
    canal: 'claro',
    status_proposta: 'claro',
    origem: 'claro',
    busca: 'hmac',
  },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quem tentou CLT ontem e parou com erro?', 'Liste a jornada de hoje no canal webapp'],
  entrada: z.strictObject({
    ...periodo,
    produto: produto.optional(),
    resultado: z.string().max(40).optional(),
    erro: z.string().max(40).optional().describe('tipo de erro, como no filtro do painel'),
    status: z.string().max(60).optional(),
    canal: z.string().max(40).optional(),
    status_proposta: z.string().max(60).optional(),
    origem: z.string().max(60).optional(),
    busca: z.string().max(120).optional().describe('nome, CPF ou telefone (vai no corpo)'),
    cursor,
    limite,
  }),
  saida: saidaEnvelope(
    z.strictObject({ filtros_aplicados: z.record(z.string(), z.string()) }),
    z.strictObject({
      userUuid: sn,
      nome: sn,
      documento: sn,
      ultima_atividade: sn,
      produtos: z.array(esquemaCelula),
    }),
  ),
  async executar(args, ctx) {
    const j = janela(args.de, args.ate, 1, ctx.agora());
    const filtros = filtrosDe(args);
    const pagina = Number(posicao(ctx, 'jornada_listar', filtros, args.cursor) ?? 0);
    const corpo = {
      from: j.from,
      to: j.to,
      product: args.produto,
      outcome: args.resultado,
      errorType: args.erro,
      status: args.status,
      channel: args.canal,
      proposalStatus: args.status_proposta,
      origin: args.origem,
      search: args.busca,
      page: pagina,
      size: args.limite,
    };
    const { dados } = await ctx.chamar<{ data?: unknown[]; meta?: { hasNext?: boolean; total?: number } }>({
      operacao: 'selfContractingCustomersSearch',
      corpo,
    });
    const itens = lista<Record<string, unknown>>(dados.data).map((l) => ({
      userUuid: str(l.userUuid),
      nome: textoExterno(l.name, 120),
      documento: mascararCpf(str(l.cpf)),
      ultima_atividade: horaBrt(l.lastActivityAt),
      produtos: Object.entries(obj(l.products)).map(([codigo, c]) => {
        const cel = obj(c);
        const erro = obj(cel.errorDiagnosis);
        const atual = obj(cel.currentError);
        return {
          produto: str(cel.productCode) ?? codigo,
          etapa: textoExterno(obj(cel.lastStatus).label, 120),
          codigo_etapa: str(obj(cel.lastStatus).code),
          resultado: str(cel.outcome),
          canal: str(cel.channel),
          tentativa_id: str(cel.attemptId),
          inicio_tentativa: horaBrt(cel.attemptStartedAt),
          erro:
            Object.keys(erro).length || Object.keys(atual).length
              ? {
                  codigo: str(erro.code) ?? str(atual.code),
                  classe: str(erro.errorClass),
                  resumo: textoExterno(erro.summary, 300),
                  provedor: str(erro.provider),
                }
              : null,
        };
      }),
    }));
    const aplicados = Object.fromEntries(
      Object.entries({ ...filtros, de: j.de, ate: j.ate })
        .filter(([k, v]) => v !== undefined && k !== 'busca')
        .map(([k, v]) => [k, String(v)]),
    );
    return envelope(ctx, {
      operacoes: ['selfContractingCustomersSearch'],
      dados: { filtros_aplicados: aplicados },
      pagina: {
        itens,
        proximo_cursor: proximo(ctx, 'jornada_listar', filtros, dados.meta?.hasNext ? pagina + 1 : null),
        total: num(dados.meta?.total),
      },
      periodo: j,
      lacunas: [
        {
          codigo: 'mensagens_do_provedor_fora',
          mensagem: 'Mensagens do provedor ficam fora até a decisão sobre dados em clientes de IA.',
        },
      ],
    });
  },
});

const clienteJornada = definir({
  nome: 'cliente_jornada',
  titulo: 'Jornada do cliente',
  descricao: `De onde o cliente veio e o que aconteceu em um produto: origem, eventos da tentativa (com erro ou não) e conversas ligadas, com lacunas explícitas. Versão parcial: a jornada unificada entra no incremento 2. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['journeyLog', 'listUserConversations'],
  paramsAuditaveis: { userUuid: 'claro', produto: 'claro', tentativa_id: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['De onde veio este cliente e até onde chegou no CLT?', 'Por que a tentativa deste cliente parou?'],
  entrada: z.strictObject({
    userUuid: uuid,
    produto,
    tentativa_id: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,80}$/)
      .optional(),
    cursor,
  }),
  saida: saidaEnvelope(
    z.strictObject({
      origem: z.strictObject({ tipo: sn, rotulo: sn, quando: sn }).nullable(),
      conversas: z.strictObject({
        cobertura: sn,
        itens: z.array(z.strictObject({ conversationId: nn, ligada_em: sn, ligacoes: z.array(z.string()) })),
      }),
    }),
    z.strictObject({
      quando: sn,
      evento: sn,
      codigo: sn,
      erro: z.boolean(),
      fonte: sn,
      proposalUuid: sn,
      correlacao: sn,
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'user';
    ctx.registro.targetId = args.userUuid;
    const filtros = filtrosDe(args);
    const pagina = Number(posicao(ctx, 'cliente_jornada', filtros, args.cursor) ?? 0);
    const [log, conversas] = await Promise.all([
      ctx.chamar<Record<string, unknown>>({
        operacao: 'journeyLog',
        consulta: {
          userUuid: args.userUuid,
          productCode: args.produto,
          attemptId: args.tentativa_id,
          page: pagina,
          size: 50,
        },
      }),
      ctx.chamar<Record<string, unknown>>({
        operacao: 'listUserConversations',
        caminho: { userUuid: args.userUuid },
        consulta: { limit: 10 },
      }),
    ]);
    const origem = obj(log.dados.origin);
    const conv = conversas.dados;
    const lacunas: Lacuna[] = [
      {
        codigo: 'mensagens_do_provedor_fora',
        mensagem: 'Mensagens do provedor e detalhes técnicos ficam fora até a decisão sobre dados em clientes de IA.',
      },
      { codigo: 'jornada_parcial', mensagem: 'Jornada unificada (campanhas, cobrança, atendimento) no incremento 2.' },
    ];
    if (conv.coverage === 'PARTIAL' || conv.coverage === 'UNKNOWN') {
      lacunas.push({
        codigo: 'conversas_cobertura_parcial',
        mensagem: `cobertura de conversas: ${String(conv.coverage)}`,
      });
    }
    return envelope(ctx, {
      operacoes: ['journeyLog', 'listUserConversations'],
      dados: {
        origem: Object.keys(origem).length
          ? { tipo: str(origem.kind), rotulo: textoExterno(origem.label, 120), quando: horaBrt(origem.occurredAt) }
          : null,
        conversas: {
          cobertura: str(conv.coverage),
          itens: lista<Record<string, unknown>>(conv.items).map((c) => ({
            conversationId: num(c.conversationId),
            ligada_em: horaBrt(c.lastLinkedAt),
            ligacoes: lista<string>(c.linkedBy).filter((x) => typeof x === 'string'),
          })),
        },
      },
      pagina: {
        itens: lista<Record<string, unknown>>(log.dados.items).map((i) => ({
          quando: horaBrt(i.occurredAt),
          evento: textoExterno(i.label, 200),
          codigo: str(i.code),
          erro: i.error === true,
          fonte: str(i.source),
          proposalUuid: str(i.proposalUuid),
          correlacao: str(i.correlationReason),
        })),
        proximo_cursor: proximo(ctx, 'cliente_jornada', filtros, log.dados.hasMore === true ? pagina + 1 : null),
        total: null,
      },
      lacunas,
    });
  },
});

export const FERRAMENTAS_CLIENTES = [buscar, dossie, linhaDoTempo, jornadaListar, clienteJornada];
