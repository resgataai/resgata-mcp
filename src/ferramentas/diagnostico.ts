import * as z from 'zod';
import { envelope, horaBrt, type Lacuna, saidaEnvelope } from '../mcp/envelope.js';
import { textoExterno } from '../mcp/mascara.js';
import {
  classificar,
  NO_SEM_CADASTRO,
  type No,
  noDoCodigo,
  type Relacao,
  resolverApelido,
  type Snapshot,
  TELEMETRIA,
  VOLUME_MINIMO,
} from '../mcp/provedores.js';
import { definir, LEITURA, lista, nn, num, obj, sn, str } from './comum.js';

const ESCOPO = ['resgata:read.bi'] as const;
const janelaMinutos = z.number().int().min(5).max(1440).default(60).describe('janela em minutos (5 a 1440)');

const esquemaProvedor = z.strictObject({
  codigo: sn,
  ativo: z.boolean(),
  status: sn,
  concluidas: nn,
  sucesso: nn,
  falhas_tecnicas: nn,
  recusas_negocio: nn,
  taxa_erro: nn,
  p50_ms: nn,
  p95_ms: nn,
  ultimo_evento: sn,
});
const provedor = (p: Record<string, unknown>) => ({
  codigo: str(p.providerCode),
  ativo: p.isActive === true,
  status: str(p.status),
  concluidas: num(p.completedCalls),
  sucesso: num(p.succeededCalls),
  falhas_tecnicas: num(p.failedCalls),
  recusas_negocio: num(p.businessRefusalCalls),
  taxa_erro: num(p.errorRate),
  p50_ms: num(obj(p.latencyMs).p50),
  p95_ms: num(obj(p.latencyMs).p95),
  ultimo_evento: horaBrt(p.lastEventAt),
});
/** Nó sem números na janela: banco a montante e dependência indireta nunca viram investigação do provedor direto. */
const SEM_TELEMETRIA: Record<Relacao, Lacuna> = {
  direto: {
    codigo: 'provedor_sem_dados_na_janela',
    mensagem: 'Nenhum provedor da janela corresponde a este nó; veja os códigos em diagnostico_saude.',
  },
  a_montante: {
    codigo: 'banco_a_montante_sem_telemetria',
    mensagem:
      'Banco a montante: só aparece agregado na saúde do provedor bancário; detalhe por operação no incremento 4.',
  },
  indireto: {
    codigo: 'dependencia_sem_telemetria',
    mensagem: 'Dependência indireta: a plataforma não mede chamadas a ela.',
  },
};

const dependencia = z.strictObject({ status: sn, latencia_ms: nn, detalhe: sn, disjuntor: sn });
const lerDependencia = (d: unknown) => {
  const v = obj(d);
  return {
    status: str(v.status),
    latencia_ms: num(v.latencyMs),
    detalhe: textoExterno(v.detail, 200),
    disjuntor: str(v.circuitBreaker),
  };
};

const saude = definir({
  nome: 'diagnostico_saude',
  titulo: 'Saúde da plataforma',
  descricao:
    'Situação da API, do atendimento e dos provedores bancários na janela (chamadas, falhas técnicas, recusas de negócio, latência). Recusa de negócio não é falha técnica.',
  escopos: ESCOPO,
  operacoes: ['dependencyHealth'],
  paramsAuditaveis: { janela_minutos: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Está tudo funcionando agora?', 'Os provedores estão respondendo?'],
  entrada: z.strictObject({ janela_minutos: janelaMinutos }),
  saida: saidaEnvelope(
    z.strictObject({
      status: sn,
      api: dependencia,
      atendimento: dependencia,
      provedores: z.array(esquemaProvedor),
      janela: z.strictObject({ de: sn, ate: sn, minutos: nn }),
    }),
  ),
  async executar(args, ctx) {
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'dependencyHealth',
      consulta: { providerWindowMinutes: args.janela_minutos },
    });
    const p = obj(dados.providers);
    const w = obj(p.window);
    return envelope(ctx, {
      operacoes: ['dependencyHealth'],
      dados: {
        status: str(dados.status),
        api: lerDependencia(dados.api),
        atendimento: lerDependencia(dados.chatwoot),
        provedores: lista<Record<string, unknown>>(p.providers).map(provedor),
        janela: { de: horaBrt(w.from), ate: horaBrt(w.to), minutos: num(w.minutes) },
      },
      definicoes: { falha_tecnica: 'erro nosso, de comunicação ou sem causa provada (inclui timeout e 5xx)' },
    });
  },
});

const provedorDiag = definir({
  nome: 'diagnostico_provedor',
  titulo: 'O que está acontecendo no provedor',
  descricao: `Situação de um provedor com classificação calculada no servidor (normal, degradado, indisponivel ou indeterminada), volume (n), confiança e evidências. Abaixo de ${VOLUME_MINIMO} chamadas na janela a classificação é "indeterminada". Resolve nomes e apelidos configurados para nós distintos (provedor bancário direto; bancos a montante observados por ele; dependências indiretas, sem telemetria) e pede confirmação antes de investigar um apelido. Não afirme causa fora de "classificacao". Sem busca por texto e sem CPF.`,
  escopos: ESCOPO,
  operacoes: ['health_1'],
  paramsAuditaveis: { provedor: 'claro', janela_minutos: 'claro', confirmado: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Por que o provedor bancário parou de simular hoje?', 'O banco a montante está fora?'],
  entrada: z.strictObject({
    provedor: z.string().min(2).max(60).describe('nome, apelido ou código do provedor'),
    janela_minutos: janelaMinutos,
    confirmado: z.boolean().default(false).describe('true depois que a pessoa confirmar o nó resolvido'),
  }),
  saida: saidaEnvelope(
    z.strictObject({
      pergunta: sn,
      resolucao: z
        .strictObject({
          no: z.string(),
          rotulo: z.string(),
          relacao: z.string(),
          telemetria: z.string(),
          codigo_plataforma: sn,
        })
        .nullable(),
      candidatos: z.array(z.string()),
      classificacao: z
        .strictObject({
          valor: z.enum(['normal', 'degradado', 'indisponivel', 'indeterminada']),
          n: z.number(),
          confianca: z.string(),
          evidencias: z.array(z.string()),
        })
        .nullable(),
      numeros: esquemaProvedor.nullable(),
    }),
  ),
  async executar(args, ctx) {
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'health_1',
      consulta: { windowMinutes: args.janela_minutos },
    });
    const snapshots = lista<Record<string, unknown>>(dados.providers);
    const codigos = snapshots.map((s) => String(s.providerCode ?? '')).filter(Boolean);
    const exato = snapshots.find(
      (s) => String(s.providerCode ?? '').toLowerCase() === args.provedor.trim().toLowerCase(),
    );
    const nos = exato
      ? [noDoCodigo(String(exato.providerCode), ctx.provedores) ?? NO_SEM_CADASTRO]
      : resolverApelido(args.provedor, ctx.provedores);
    const base = { pergunta: null, resolucao: null, candidatos: [] as string[], classificacao: null, numeros: null };
    const lacunas: Lacuna[] = [];

    if (nos.length !== 1) {
      return envelope(ctx, {
        operacoes: ['health_1'],
        dados: {
          ...base,
          candidatos: codigos,
          pergunta:
            nos.length === 0
              ? `Não reconheci "${textoExterno(args.provedor, 60)}". Qual destes provedores você quer dizer: ${codigos.join(', ') || 'nenhum com telemetria'}?`
              : `O texto cita mais de um: ${nos.map((n) => n.rotulo).join('; ')}. Qual deles?`,
        },
      });
    }
    const no = nos[0] as No;
    const snap =
      no.relacao === 'direto'
        ? (exato ?? snapshots.find((s) => no.codigos.includes(String(s.providerCode ?? '').toLowerCase())))
        : undefined;
    const resolucao = {
      no: no.id,
      rotulo: no.rotulo,
      relacao: no.relacao,
      telemetria: TELEMETRIA[no.relacao],
      codigo_plataforma: snap ? str(snap.providerCode) : null,
    };
    if (!exato && !args.confirmado) {
      return envelope(ctx, {
        operacoes: ['health_1'],
        dados: {
          ...base,
          resolucao,
          pergunta: `Entendi "${textoExterno(args.provedor, 60)}" como: ${no.rotulo}. Confirma? (chame de novo com confirmado=true)`,
        },
      });
    }
    let classificacao: ReturnType<typeof classificar>;
    if (snap) {
      classificacao = classificar(snap as Snapshot, args.janela_minutos);
    } else {
      classificacao = {
        valor: 'indeterminada',
        n: 0,
        confianca: 'nenhuma',
        evidencias: [`${no.rotulo}: sem números na janela`],
      };
      lacunas.push(SEM_TELEMETRIA[no.relacao]);
    }
    return envelope(ctx, {
      operacoes: ['health_1'],
      dados: { ...base, resolucao, classificacao, numeros: snap ? provedor(snap) : null },
      definicoes: {
        volume_minimo: VOLUME_MINIMO,
        regra: 'falha técnica ≥ 50% ou nenhum sucesso = indisponivel; ≥ 10% = degradado; recusa de negócio não conta',
      },
      lacunas,
    });
  },
});

export const FERRAMENTAS_DIAGNOSTICO = [saude, provedorDiag];
