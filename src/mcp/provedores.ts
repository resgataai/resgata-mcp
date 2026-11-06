import * as z from 'zod';

/**
 * Nós de provedor do `diagnostico_provedor` (DESENHO §7.1). O repositório é público: nomes de parceiros, apelidos e
 * códigos na V2 chegam só por `MCP_PROVEDORES_JSON`, validado na subida; o código traz apenas nós genéricos.
 */
export type Relacao = 'direto' | 'a_montante' | 'indireto';
export type No = {
  id: string;
  rotulo: string;
  relacao: Relacao;
  /** Palavras ou expressões que resolvem para o nó (sem diferença de maiúscula ou acento). */
  apelidos: readonly string[];
  /** `providerCode` da V2 com a telemetria do nó (só `direto`), em minúsculas. */
  codigos: readonly string[];
};

export const TELEMETRIA: Record<Relacao, 'propria' | 'via_provedor_bancario' | 'nenhuma'> = {
  direto: 'propria',
  a_montante: 'via_provedor_bancario',
  indireto: 'nenhuma',
};

/** Texto em palavras sem acento, com espaço nas pontas: casa apelido só como palavra inteira. */
const frase = (texto: string) =>
  ` ${(
    texto
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).join(' ')} `;

/** Formato de `MCP_PROVEDORES_JSON`: lista que substitui o padrão. */
export const esquemaProvedores = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      rotulo: z.string().min(2).max(120),
      relacao: z.enum(['direto', 'a_montante', 'indireto']),
      apelidos: z
        .array(
          z
            .string()
            .max(60)
            .refine((a) => frase(a).trim() !== '', 'apelido sem letras nem números'),
        )
        .max(20)
        .default([]),
      codigos: z
        .array(
          z
            .string()
            .min(1)
            .max(60)
            .transform((c) => c.toLowerCase()),
        )
        .max(10)
        .default([]),
    }),
  )
  .min(1)
  .max(30)
  .refine((nos) => new Set(nos.map((n) => n.id)).size === nos.length, 'id repetido');

/** Padrão público, genérico. */
export const PROVEDORES_PADRAO: readonly No[] = [
  {
    id: 'provedor_bancario',
    rotulo: 'provedor bancário (integração direta)',
    relacao: 'direto',
    apelidos: ['bancario'],
    codigos: [],
  },
];

/** Código da V2 sem nó configurado: tratado como provedor direto genérico. */
export const NO_SEM_CADASTRO: No = {
  id: 'provedor',
  rotulo: 'provedor (integração direta)',
  relacao: 'direto',
  apelidos: [],
  codigos: [],
};

/** Nós citados no texto, sem repetição (mais de um = pedir para escolher). */
export function resolverApelido(texto: string, nos: readonly No[]): No[] {
  const t = frase(texto);
  return nos.filter((n) => n.apelidos.some((a) => t.includes(frase(a))));
}

/** Nó dono de um `providerCode` da V2. */
export const noDoCodigo = (codigo: string, nos: readonly No[]) =>
  nos.find((n) => n.codigos.includes(codigo.toLowerCase()));

export type Snapshot = {
  providerCode: string;
  status?: string;
  succeededCalls?: number;
  failedCalls?: number;
  businessRefusalCalls?: number;
  completedCalls?: number;
  latencyMs?: { p50?: number | null; p95?: number | null };
  lastEventAt?: string | null;
};

export type Classificacao = {
  valor: 'normal' | 'degradado' | 'indisponivel' | 'indeterminada';
  n: number;
  confianca: 'nenhuma' | 'baixa' | 'media' | 'alta';
  evidencias: string[];
};

// shortcut: limiar e regra no MCP são de apresentação; passam para o agregador da V2 no F1 (inc. 4)
export const VOLUME_MINIMO = 50;

/**
 * Classificação calculada no servidor a partir da saúde do provedor. Recusa de negócio não é falha técnica.
 * Abaixo do volume mínimo a resposta é `indeterminada`: poucos dados não sustentam afirmação de causa.
 */
export function classificar(s: Snapshot, janelaMinutos: number): Classificacao {
  const falhas = s.failedCalls ?? 0;
  const recusas = s.businessRefusalCalls ?? 0;
  const n = s.completedCalls ?? (s.succeededCalls ?? 0) + falhas + recusas;
  const taxa = n > 0 ? falhas / n : 0;
  const evidencias = [
    `${n} chamadas concluídas em ${janelaMinutos} min`,
    `${falhas} falhas técnicas (${(taxa * 100).toFixed(1)}%)`,
    `${recusas} recusas de negócio (não contam como falha)`,
  ];
  if (s.latencyMs?.p95 != null) evidencias.push(`latência p95 ${s.latencyMs.p95} ms`);
  if (s.status) evidencias.push(`situação informada pela plataforma: ${s.status}`);
  if (n < VOLUME_MINIMO) {
    evidencias.push(`volume abaixo do mínimo de ${VOLUME_MINIMO} chamadas: sem conclusão`);
    return { valor: 'indeterminada', n, confianca: n === 0 ? 'nenhuma' : 'baixa', evidencias };
  }
  const valor = taxa >= 0.5 || (s.succeededCalls ?? 1) === 0 ? 'indisponivel' : taxa >= 0.1 ? 'degradado' : 'normal';
  return { valor, n, confianca: n >= 500 ? 'alta' : 'media', evidencias };
}
