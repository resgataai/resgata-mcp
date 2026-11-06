import * as z from 'zod';
import { envelope, horaBrt, janela, saidaEnvelope } from '../mcp/envelope.js';
import { mascararCpf, textoExterno } from '../mcp/mascara.js';
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
const codigo = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

const esquemaResumo = z.strictObject({
  proposalUuid: sn,
  userUuid: sn,
  cliente: sn,
  documento: sn,
  status: sn,
  status_rotulo: sn,
  produto: sn,
  provedor: sn,
  valor_liquido: nn,
  valor_total: nn,
  parcelas: nn,
  criada_em: sn,
  desembolso: sn,
});

const buscar = definir({
  nome: 'propostas_buscar',
  titulo: 'Buscar propostas',
  descricao: `Propostas com filtros (status, produto, provedor, período de criação, cliente), total e, se pedido, facetas. O termo pessoal vai no corpo, nunca na URL. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['proposalsSearch', 'facets'],
  paramsAuditaveis: {
    status: 'claro',
    produto: 'claro',
    provedor: 'claro',
    de: 'claro',
    ate: 'claro',
    userUuid: 'claro',
    termo: 'hmac',
  },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quantas propostas CLT foram criadas esta semana?', 'Liste as propostas pendentes de assinatura'],
  entrada: z.strictObject({
    status: codigo.optional(),
    produto: codigo.optional(),
    provedor: codigo.optional(),
    ...periodo,
    userUuid: uuid.optional(),
    termo: z.string().max(120).optional().describe('nome, CPF ou telefone (vai no corpo)'),
    facetas: z.boolean().default(false),
    cursor,
    limite,
  }),
  saida: saidaEnvelope(
    z.strictObject({
      facetas: z.record(z.string(), z.array(z.strictObject({ valor: sn, quantidade: nn }))).nullable(),
    }),
    esquemaResumo,
  ),
  async executar(args, ctx) {
    // Com cliente e sem datas, todas as propostas dele; senão a janela (padrão 30 dias).
    const j = args.userUuid && !args.de && !args.ate ? undefined : janela(args.de, args.ate, 30, ctx.agora());
    const filtros = filtrosDe(args);
    const pagina = Number(posicao(ctx, 'propostas_buscar', filtros, args.cursor) ?? 0);
    const { dados } = await ctx.chamar<{ data?: unknown[]; meta?: { hasNext?: boolean; total?: number } }>({
      operacao: 'proposalsSearch',
      corpo: {
        status: args.status,
        productCode: args.produto,
        providerCode: args.provedor,
        createdAtFrom: j?.from,
        createdAtTo: j?.to,
        userUuid: args.userUuid,
        search: args.termo,
        page: pagina,
        size: args.limite,
      },
    });
    let facetas: Record<string, Array<{ valor: string | null; quantidade: number | null }>> | null = null;
    if (args.facetas) {
      const f = await ctx.chamar<{ facets?: Record<string, unknown> }>({
        operacao: 'facets',
        consulta: { from: j?.from, to: j?.to, limitPerField: 10 },
      });
      facetas = Object.fromEntries(
        Object.entries(obj(f.dados.facets)).map(([campo, valores]) => [
          campo,
          lista<Record<string, unknown>>(valores)
            .slice(0, 10)
            .map((v) => ({ valor: textoExterno(v.value, 120), quantidade: num(v.count) })),
        ]),
      );
    }
    return envelope(ctx, {
      operacoes: args.facetas ? ['proposalsSearch', 'facets'] : ['proposalsSearch'],
      dados: { facetas },
      pagina: {
        itens: lista<Record<string, unknown>>(dados.data).map((p) => ({
          proposalUuid: str(p.proposalUuid),
          userUuid: str(p.userUuid),
          cliente: textoExterno(p.customerName, 120),
          documento: mascararCpf(str(p.cpf)),
          status: str(p.status),
          status_rotulo: str(p.statusHumanLabel),
          produto: str(p.productCode),
          provedor: str(p.providerCode),
          valor_liquido: num(p.netValue),
          valor_total: num(p.totalLoan),
          parcelas: num(p.installments),
          criada_em: horaBrt(p.createdAt),
          desembolso: str(p.disbursementDate),
        })),
        proximo_cursor: proximo(ctx, 'propostas_buscar', filtros, dados.meta?.hasNext ? pagina + 1 : null),
        total: num(dados.meta?.total),
      },
      ...(j ? { periodo: j } : {}),
      definicoes: { periodo: 'data de criação da proposta' },
    });
  },
});

const detalhe = definir({
  nome: 'proposta_detalhe',
  titulo: 'Detalhe da proposta',
  descricao: `Situação, status canônico, provedor, valores e datas de uma proposta. Conta bancária e documentos ficam fora. ${AVISO_TERCEIROS}`,
  escopos: ESCOPO,
  operacoes: ['get_1'],
  paramsAuditaveis: { proposalUuid: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Qual a situação desta proposta?'],
  entrada: z.strictObject({ proposalUuid: uuid }),
  saida: saidaEnvelope(
    esquemaResumo.omit({ cliente: true, documento: true, criada_em: true }).extend({
      cliente: sn,
      documento: sn,
      criada_em: sn,
      atualizada_em: sn,
      situacao: sn,
      status_provedor: sn,
      status_cliente: sn,
      fundo: sn,
      valor_parcela: nn,
      taxa_mensal: nn,
      cet_mensal: nn,
      primeiro_vencimento: sn,
      cancelamento: z.strictObject({ motivo: sn, quando: sn }).nullable(),
      canal_origem: sn,
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'proposal';
    ctx.registro.targetId = args.proposalUuid;
    const { dados: p } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'get_1',
      caminho: { uuid: args.proposalUuid },
    });
    const cliente = obj(p.customer);
    return envelope(ctx, {
      operacoes: ['get_1'],
      dados: {
        proposalUuid: str(p.proposalUuid),
        userUuid: str(p.userUuid) ?? str(cliente.uuid),
        cliente: textoExterno(cliente.name, 120),
        documento: mascararCpf(str(cliente.cpf)),
        status: str(p.status),
        status_rotulo: str(p.statusHumanLabel),
        status_cliente: textoExterno(obj(p.customerStatus).label, 120),
        status_provedor: str(p.providerStatus),
        situacao: str(p.situation),
        produto: str(p.productCode),
        provedor: str(p.providerCode),
        fundo: str(p.fund),
        valor_liquido: num(p.netValue),
        valor_total: num(p.totalLoan),
        parcelas: num(p.installments),
        valor_parcela: num(p.installmentValue),
        taxa_mensal: num(p.interestRate),
        cet_mensal: num(p.cetMonthly),
        criada_em: horaBrt(p.createdAt),
        atualizada_em: horaBrt(p.updatedAt),
        desembolso: str(p.disbursementDate),
        primeiro_vencimento: str(p.firstDueDate),
        cancelamento: p.cancelledAt
          ? { motivo: textoExterno(p.cancelReason, 200), quando: horaBrt(p.cancelledAt) }
          : null,
        canal_origem: str(p.originChannel),
      },
    });
  },
});

export const FERRAMENTAS_PROPOSTAS = [buscar, detalhe];
