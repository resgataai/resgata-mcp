import { readFileSync } from 'node:fs';
import * as z from 'zod';

/** Uma operação da V2 consumida pelo MCP. As chaves seguem a allowlist da V2, que é cópia deste arquivo. */
export const esquemaOperacao = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9_]+$/),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().regex(/^\/v2\/[A-Za-z0-9/{}_-]+$/),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  forbiddenParams: z.array(z.string()).optional(),
  idempotencyKey: z.literal('required').optional(),
  /** Operação nova, ainda não publicada pela V2: o drift só avisa. */
  pending: z.boolean().optional(),
});
export type OperacaoV2 = z.infer<typeof esquemaOperacao>;

export const esquemaManifesto = z.object({
  $comment: z.string().optional(),
  version: z.literal(1),
  operations: z.array(esquemaOperacao).min(1),
});
export type Manifesto = z.infer<typeof esquemaManifesto>;

/** Recorte da OpenAPI da V2: só as operações do manifesto, sem descrições (o texto público não cita parceiros). */
export type OperacaoPublicada = { operationId: string; method: string; path: string; params: string[] };

export const CAMINHO_MANIFESTO = new URL('../../contrato/operacoes-v2.json', import.meta.url);
export const CAMINHO_RECORTE = new URL('../../contrato/openapi-v2.recorte.json', import.meta.url);

export function carregarManifesto(caminho: URL | string = CAMINHO_MANIFESTO): Manifesto {
  const m = esquemaManifesto.parse(JSON.parse(readFileSync(caminho, 'utf8')));
  const ids = new Set<string>();
  for (const op of m.operations) {
    if (ids.has(op.operationId)) throw new Error(`operationId repetido no manifesto: ${op.operationId}`);
    ids.add(op.operationId);
  }
  return m;
}

type OpenApi = {
  paths?: Record<string, Record<string, { operationId?: string; parameters?: Array<{ name?: string }> }>>;
};
const METODOS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Indexa por operationId as operações de um ou mais documentos OpenAPI (a V2 publica o contrato em partes). */
export function indexarOpenApi(docs: OpenApi[]): Map<string, OperacaoPublicada> {
  const indice = new Map<string, OperacaoPublicada>();
  for (const doc of docs) {
    for (const [path, itens] of Object.entries(doc.paths ?? {})) {
      for (const [metodo, op] of Object.entries(itens)) {
        if (!METODOS.has(metodo) || !op?.operationId) continue;
        const params = (op.parameters ?? []).map((p) => p.name).filter((n): n is string => typeof n === 'string');
        indice.set(op.operationId, { operationId: op.operationId, method: metodo.toUpperCase(), path, params });
      }
    }
  }
  return indice;
}

/** Recorte ordenado e determinístico com só o que o manifesto usa. */
export function recortar(manifesto: Manifesto, indice: Map<string, OperacaoPublicada>): OperacaoPublicada[] {
  return manifesto.operations
    .map((op) => indice.get(op.operationId))
    .filter((o): o is OperacaoPublicada => o !== undefined)
    .map((o) => ({ ...o, params: [...o.params].sort() }))
    .sort((a, b) => a.operationId.localeCompare(b.operationId));
}

export type ResultadoDrift = { erros: string[]; avisos: string[] };

export function compararDrift(manifesto: Manifesto, publicadas: Iterable<OperacaoPublicada>): ResultadoDrift {
  const porId = new Map([...publicadas].map((o) => [o.operationId, o]));
  const erros: string[] = [];
  const avisos: string[] = [];
  for (const op of manifesto.operations) {
    const pub = porId.get(op.operationId);
    if (!pub) {
      (op.pending ? avisos : erros).push(
        `${op.operationId}: não existe na OpenAPI da V2${op.pending ? ' (pendente)' : ''}`,
      );
      continue;
    }
    if (op.pending) avisos.push(`${op.operationId}: já publicada; tirar "pending" do manifesto`);
    if (pub.method !== op.method || pub.path !== op.path) {
      erros.push(`${op.operationId}: manifesto ${op.method} ${op.path}, V2 ${pub.method} ${pub.path}`);
    }
    for (const p of op.forbiddenParams ?? []) {
      if (!pub.params.includes(p)) avisos.push(`${op.operationId}: parâmetro proibido "${p}" não existe mais na V2`);
    }
  }
  return { erros, avisos };
}
