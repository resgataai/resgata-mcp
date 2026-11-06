import * as z from 'zod';
import { envelope, horaBrt, janela, saidaEnvelope } from '../mcp/envelope.js';
import type { ContextoFerramenta } from '../mcp/ferramenta.js';
import { visivel } from '../mcp/servidor-mcp.js';
import {
  cursor,
  definir,
  filtrosDe,
  LEITURA,
  limite,
  lista,
  obj,
  periodo,
  posicao,
  proximo,
  sn,
  str,
} from './comum.js';

/** Nome exibido do cliente de IA pelo documento CIMD (mesma lista fechada do servidor de autorização). */
function nomeDoCliente(clientId: string): string {
  if (clientId === 'https://claude.ai/oauth/mcp-oauth-client-metadata') return 'Claude';
  if (clientId === 'https://claude.ai/oauth/claude-code-client-metadata') return 'Claude Code';
  if (/^https:\/\/chatgpt\.com\/oauth\/codex\/([A-Za-z0-9_-]+\/)?client\.json$/.test(clientId)) return 'Codex';
  return 'cliente de IA não identificado';
}

const LACUNA_CARTEIRA = {
  codigo: 'sem_carteira',
  mensagem: 'A plataforma não tem carteira ou equipe: com leitura de clientes, você lê qualquer cliente.',
};

const quemSou = definir({
  nome: 'resgata_quem_sou',
  titulo: 'Quem sou eu na Resgata',
  descricao: 'Seu nome, papéis na plataforma, permissões desta conexão e o cliente de IA conectado.',
  escopos: [],
  operacoes: ['me'],
  paramsAuditaveis: {},
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quem sou eu na Resgata?', 'Quais permissões esta conexão tem?'],
  entrada: z.strictObject({}),
  saida: saidaEnvelope(
    z.strictObject({
      nome: sn,
      email: sn,
      papeis_plataforma: z.array(z.string()),
      escopos_conexao: z.array(z.string()),
      cliente_ia: z.string(),
    }),
  ),
  async executar(_args, ctx) {
    const { dados } = await ctx.chamar<Record<string, unknown>>({ operacao: 'me' });
    return envelope(ctx, {
      operacoes: ['me'],
      dados: {
        nome: str(obj(dados.user).name),
        email: str(dados.email),
        papeis_plataforma: lista<string>(dados.roles).filter((r) => typeof r === 'string'),
        escopos_conexao: [...ctx.escopos].sort(),
        cliente_ia: nomeDoCliente(ctx.clientId),
      },
      lacunas: [LACUNA_CARTEIRA],
    });
  },
});

/** Ferramentas dos próximos incrementos (CATALOGO.md), para a IA não inventar capacidade. */
const PLANEJADAS: ReadonlyArray<[string, number]> = [
  ['contato_cancelar', 2],
  ['atendimento_acao_planejar', 2],
  ['cobranca_dossie', 2],
  ['resgata_novidades', 3],
  ['cliente_o_que_foi_feito', 3],
  ['audiencias_previa', 3],
  ['audiencias_criar', 3],
  ['selecao_operacional_previa', 3],
  ['campanha_planejar', 3],
  ['campanha_controlar', 3],
  ['execucoes_listar', 3],
  ['acompanhamento_criar', 3],
  ['rotina_criar', 3],
  ['automacoes_listar', 3],
  ['cliente_proxima_acao', 4],
  ['crm_planejar', 4],
  ['bi_comparar_periodos', 4],
  ['bi_insights_ia', 4],
  ['relatorio_salvar', 4],
  ['diagnostico_monitorar', 4],
  ['reprocessar_planejar', 4],
  ['dados_exportar', 4],
  ['operacao_consultar', 4],
];

const LACUNAS_CONHECIDAS = [
  LACUNA_CARTEIRA,
  {
    codigo: 'contato_so_email',
    mensagem: 'Contato direto só por e-mail com modelo; WhatsApp, SMS e texto livre no inc. 2.',
  },
  { codigo: 'busca_por_nome', mensagem: 'Busca de cliente por nome só no inc. 2; hoje por CPF, e-mail ou telefone.' },
  {
    codigo: 'dados_pessoais_mascarados',
    mensagem:
      'CPF, telefone, e-mail e CEP mascarados. Corpo técnico registrado exige diagnostics.cpf e pii; pode conter outros campos de negócio do retorno.',
  },
];

const normal = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

function motivoIndisponivel(f: ContextoFerramenta['catalogo']['ferramentas'][number], ctx: ContextoFerramenta) {
  if (ctx.catalogo.desligadas.has(f.nome)) return { motivo: 'desligada', detalhe: 'desligada pela operação' };
  if (f.efeito && !ctx.efeitosLigados) {
    return { motivo: 'gate', detalhe: 'efeitos externos desligados (MCP_EFFECTS_ENABLED)' };
  }
  const faltam = f.escopos.filter((e) => !ctx.escopos.has(e));
  return { motivo: 'escopo', detalhe: `exige ${faltam.join(', ')}` };
}

const capacidades = definir({
  nome: 'resgata_capacidades',
  titulo: 'O que posso fazer na Resgata',
  descricao:
    'Busca no catálogo: ferramentas disponíveis para você, as indisponíveis e por quê (permissão, função desligada, incremento futuro) e lacunas conhecidas da plataforma. Use antes de afirmar que algo é ou não possível.',
  escopos: [],
  operacoes: [],
  paramsAuditaveis: { texto: 'claro', dominio: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['O que você consegue fazer na Resgata?', 'Consigo mandar WhatsApp para um cliente?'],
  entrada: z.strictObject({
    texto: z.string().max(200).optional().describe('palavra a procurar no nome ou na descrição'),
    dominio: z
      .enum([
        'resgata',
        'auditoria',
        'clientes',
        'cliente',
        'jornada',
        'propostas',
        'proposta',
        'bi',
        'audiencias',
        'audiencia',
        'campanhas',
        'campanha',
        'modelos',
        'contato',
        'atendimento',
        'diagnostico',
      ])
      .optional()
      .describe('prefixo do nome da ferramenta'),
  }),
  saida: saidaEnvelope(
    z.strictObject({
      disponiveis: z.array(
        z.strictObject({ nome: z.string(), titulo: z.string(), descricao: z.string(), exemplos: z.array(z.string()) }),
      ),
      indisponiveis: z.array(
        z.strictObject({
          nome: z.string(),
          motivo: z.enum(['escopo', 'gate', 'desligada', 'incremento']),
          detalhe: z.string(),
        }),
      ),
    }),
  ),
  async executar(args, ctx) {
    const casa = (nome: string, extra = '') =>
      (!args.dominio || nome.startsWith(`${args.dominio}_`)) &&
      (!args.texto || normal(`${nome} ${extra}`).includes(normal(args.texto)));
    const disponiveis = [];
    const indisponiveis = [];
    for (const f of ctx.catalogo.ferramentas) {
      if (!casa(f.nome, `${f.titulo} ${f.descricao}`)) continue;
      if (visivel(f, ctx.escopos, { desligadas: ctx.catalogo.desligadas, efeitosLigados: ctx.efeitosLigados })) {
        disponiveis.push({ nome: f.nome, titulo: f.titulo, descricao: f.descricao, exemplos: [...f.exemplos] });
      } else {
        indisponiveis.push({ nome: f.nome, ...motivoIndisponivel(f, ctx) } as const);
      }
    }
    for (const [nome, inc] of PLANEJADAS) {
      if (casa(nome))
        indisponiveis.push({ nome, motivo: 'incremento', detalhe: `planejada para o incremento ${inc}` } as const);
    }
    return envelope(ctx, { operacoes: [], dados: { disponiveis, indisponiveis }, lacunas: LACUNAS_CONHECIDAS });
  },
});

const minhasAcoes = definir({
  nome: 'auditoria_minhas_acoes',
  titulo: 'Minhas ações pelo MCP',
  descricao: 'O que você fez pelo MCP no período (só as suas chamadas, garantido pela plataforma).',
  escopos: [],
  operacoes: ['adminMcpToolCallsMine'],
  paramsAuditaveis: { de: 'claro', ate: 'claro', ferramenta: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['O que eu fiz pelo MCP hoje?', 'Quais envios eu pedi esta semana?'],
  entrada: z.strictObject({
    ...periodo,
    ferramenta: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,63}$/)
      .optional(),
    cursor,
    limite,
  }),
  saida: saidaEnvelope(
    z.strictObject({ observacao: sn }),
    z.strictObject({ quando: sn, ferramenta: z.string(), resultado: sn, alvo: sn, request_id: sn }),
  ),
  async executar(args, ctx) {
    const j = janela(args.de, args.ate, 7, ctx.agora());
    const filtros = filtrosDe(args);
    const c = posicao(ctx, 'auditoria_minhas_acoes', filtros, args.cursor);
    // A2: ApiResponse<CursorPage<AdminAuditEventDTO>> → { items, page: { nextCursor, hasMore, limit } }.
    const { dados } = await ctx.chamar<{ items?: unknown[]; page?: { nextCursor?: string | null } }>({
      operacao: 'adminMcpToolCallsMine',
      consulta: { from: j.from, to: j.to, size: args.limite, cursor: c === undefined ? undefined : String(c) },
    });
    const itens = lista<Record<string, unknown>>(dados.items)
      .map((e) => ({
        quando: horaBrt(e.occurredAt),
        ferramenta: String(e.action ?? '').replace(/^mcp\./, ''),
        resultado: str(e.outcome),
        alvo: str(e.resourceType),
        request_id: str(e.requestId),
      }))
      .filter((i) => !args.ferramenta || i.ferramenta === args.ferramenta);
    return envelope(ctx, {
      operacoes: ['adminMcpToolCallsMine'],
      dados: { observacao: args.ferramenta ? 'filtro por ferramenta aplicado nesta página' : null },
      pagina: {
        itens,
        proximo_cursor: proximo(ctx, 'auditoria_minhas_acoes', filtros, dados.page?.nextCursor),
        total: null,
      },
      periodo: j,
    });
  },
});

export const FERRAMENTAS_CONTA = [quemSou, capacidades, minhasAcoes];
