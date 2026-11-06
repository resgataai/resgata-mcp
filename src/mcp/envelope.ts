import * as z from 'zod';
import type { ContextoFerramenta } from './ferramenta.js';
import { mascararProfundo, textoExterno } from './mascara.js';

export const FUSO = 'America/Sao_Paulo';
/** Tamanho máximo da resposta de uma ferramenta (DESENHO §7.2). */
export const RESPOSTA_MAXIMA_BYTES = 200 * 1024;

const lacuna = z.strictObject({ codigo: z.string(), mensagem: z.string() });
export type Lacuna = z.infer<typeof lacuna>;
const naoConfiavel = z.strictObject({ origem: z.string(), ref: z.string(), texto: z.string() });
export type NaoConfiavel = z.infer<typeof naoConfiavel>;
const link = z.strictObject({ rotulo: z.string(), url: z.string() });

/**
 * Schema fechado do envelope (DESENHO §7.2): só `dados` e `pagina.itens` variam por ferramenta, e também são
 * fechados. Campo fora do schema derruba a resposta (erro interno), nunca vaza.
 */
export function saidaEnvelope<D extends z.ZodType, I extends z.ZodType>(dados: D, item?: I) {
  return z.strictObject({
    natureza: z.enum(['fato', 'insight_ia']),
    dados,
    pagina: item
      ? z.strictObject({
          itens: z.array(item).max(50),
          proximo_cursor: z.string().nullable(),
          total: z.number().nullable(),
        })
      : z.null(),
    fonte: z.strictObject({
      operacoes: z.array(z.string()),
      atualizado_em: z.string(),
      fuso: z.literal(FUSO),
      periodo: z.strictObject({ de: z.string().nullable(), ate: z.string().nullable() }).nullable(),
      definicoes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
    lacunas: z.array(lacuna),
    conteudo_nao_confiavel: z.array(naoConfiavel),
    links: z.array(link),
    pii_mascarada: z.boolean(),
    request_id: z.string(),
  });
}

export type PartesEnvelope = {
  operacoes: readonly string[];
  dados: unknown;
  pagina?: { itens: unknown[]; proximo_cursor: string | null; total?: number | null };
  lacunas?: Lacuna[];
  naoConfiavel?: NaoConfiavel[];
  links?: Array<{ rotulo: string; url: string }>;
  periodo?: { de?: string | null; ate?: string | null };
  definicoes?: Record<string, string | number | boolean | null>;
  natureza?: 'fato' | 'insight_ia';
};

/** Monta o envelope e aplica a máscara em todo texto (dados, itens, motivos, conteúdo de terceiros). */
export function envelope(ctx: Pick<ContextoFerramenta, 'requestId' | 'agora'>, p: PartesEnvelope) {
  return mascararProfundo({
    natureza: p.natureza ?? 'fato',
    dados: p.dados,
    pagina: p.pagina
      ? { itens: p.pagina.itens, proximo_cursor: p.pagina.proximo_cursor, total: p.pagina.total ?? null }
      : null,
    fonte: {
      operacoes: [...p.operacoes],
      atualizado_em: ctx.agora().toISOString(),
      fuso: FUSO,
      periodo: p.periodo ? { de: p.periodo.de ?? null, ate: p.periodo.ate ?? null } : null,
      definicoes: p.definicoes ?? {},
    },
    lacunas: p.lacunas ?? [],
    conteudo_nao_confiavel: (p.naoConfiavel ?? []).map((c) => ({ ...c, texto: textoExterno(c.texto, 2000) ?? '' })),
    links: p.links ?? [],
    pii_mascarada: true,
    request_id: ctx.requestId,
  });
}

/** Erro acionável no envelope (`structuredContent.erro`). */
export type ErroEnvelope = {
  codigo: string;
  mensagem: string;
  acao_sugerida: string;
  tentar_novamente: boolean;
  tentar_em_s?: number;
  gate?: string;
  escopos_necessarios?: string[];
  request_id: string;
};

/** Horário em America/Sao_Paulo (UTC−3 fixo desde 2019, sem horário de verão). Aceita ISO ou epoch em s/ms. */
export function horaBrt(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const ms = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;
}

/** Dia corrente em America/Sao_Paulo (AAAA-MM-DD). */
export const diaBrt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(d);

/** Período de entrada (`de`/`ate` em dias de negócio) → janela da V2 com offset de São Paulo. */
export function janela(de: string | undefined, ate: string | undefined, padraoDias: number, agora: Date) {
  const fim = ate ?? diaBrt(agora);
  const ini = de ?? diaBrt(new Date(Date.parse(`${fim}T12:00:00-03:00`) - (padraoDias - 1) * 86_400_000));
  return { de: ini, ate: fim, from: `${ini}T00:00:00-03:00`, to: `${fim}T23:59:59.999-03:00` };
}
