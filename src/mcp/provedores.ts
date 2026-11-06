import { createHash } from 'node:crypto';

/**
 * Apelidos de provedor → nós distintos (DESENHO §7.1, `diagnostico_provedor`). O provedor bancário direto é guardado
 * só por hash (SHA-256 da palavra em minúsculas, sem acento): o repositório é público e não cita o parceiro (D22).
 */
export type No = {
  id: 'provedor_bancario' | 'caixa' | 'bmp' | 'dataprev';
  rotulo: string;
  relacao: 'direto' | 'a_montante' | 'indireto';
  telemetria: 'propria' | 'via_provedor_bancario' | 'nenhuma';
};

const NOS: Record<No['id'], No> = {
  provedor_bancario: {
    id: 'provedor_bancario',
    rotulo: 'provedor bancário (integração direta)',
    relacao: 'direto',
    telemetria: 'propria',
  },
  caixa: {
    id: 'caixa',
    rotulo: 'Caixa (a montante, observada via provedor bancário)',
    relacao: 'a_montante',
    telemetria: 'via_provedor_bancario',
  },
  bmp: {
    id: 'bmp',
    rotulo: 'BMP (a montante, observado via provedor bancário)',
    relacao: 'a_montante',
    telemetria: 'via_provedor_bancario',
  },
  dataprev: {
    id: 'dataprev',
    rotulo: 'Dataprev (dependência indireta, sem telemetria própria)',
    relacao: 'indireto',
    telemetria: 'nenhuma',
  },
};

export const NO_PROVEDOR_DIRETO: No = NOS.provedor_bancario;

/** Código do provedor direto na V2 (`providerCode`), por hash. */
const CODIGO_DIRETO = 'a01590c0e4c6d38bb60f5cb07fe000d2194c48e7f6472f7958330f81bd2ec81e';
const APELIDOS = new Map<string, No['id']>([
  [CODIGO_DIRETO, 'provedor_bancario'],
  ['dde444a9246a61775c0236a66036f6f2da51426d0a7b051ab29f600b39dbccdf', 'provedor_bancario'],
  ['11f95e175d1fb49b4bae34edd8d9b1129525e9ae4614170946cadc2840a8d4ac', 'provedor_bancario'],
  ...['caixa', 'cef'].map((p) => [hash(p), 'caixa'] as const),
  ...['bmp'].map((p) => [hash(p), 'bmp'] as const),
  ...['dataprev'].map((p) => [hash(p), 'dataprev'] as const),
]);

function hash(palavra: string): string {
  return createHash('sha256').update(palavra).digest('hex');
}

function palavras(texto: string): string[] {
  return (
    texto
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

/** Nós citados no texto, sem repetição (mais de um = pedir para escolher). */
export function resolverApelido(texto: string): No[] {
  const ids = new Set<No['id']>();
  for (const p of palavras(texto)) {
    const id = APELIDOS.get(hash(p));
    if (id) ids.add(id);
  }
  return [...ids].map((id) => NOS[id]);
}

/** O `providerCode` da V2 é o do provedor bancário direto? */
export const ehProvedorDireto = (codigo: string) => palavras(codigo).some((p) => hash(p) === CODIGO_DIRETO);

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
