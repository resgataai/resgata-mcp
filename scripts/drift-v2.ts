// Drift entre o manifesto (contrato/operacoes-v2.json) e a OpenAPI da V2.
//
//   bun run drift:v2                              confere contra o recorte versionado (gate, sem rede)
//   bun run drift:v2 --fonte <arquivo|url> ...    confere contra OpenAPI completa (arquivo ou URL pública)
//   bun run drift:v2 --atualizar <arquivo> ...    regrava o recorte a partir da OpenAPI completa
//
// Fonte fora do ar vira aviso, não falha (PLANO §2.3).
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CAMINHO_RECORTE,
  carregarManifesto,
  compararDrift,
  indexarOpenApi,
  type OperacaoPublicada,
  recortar,
} from '../src/v2/contrato.js';

const [modo, ...fontes] = process.argv.slice(2);
const manifesto = carregarManifesto();

async function ler(fonte: string): Promise<unknown> {
  if (/^https?:\/\//.test(fonte)) {
    const r = await fetch(fonte, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(fonte, 'utf8'));
}

let publicadas: OperacaoPublicada[];
if (modo === '--fonte' || modo === '--atualizar') {
  if (fontes.length === 0) {
    console.error('informe ao menos um arquivo ou URL da OpenAPI da V2');
    process.exit(2);
  }
  let docs: unknown[];
  try {
    docs = await Promise.all(fontes.map(ler));
  } catch (e) {
    console.warn(`aviso: OpenAPI da V2 indisponível (${(e as Error).message}); drift não conferido`);
    process.exit(modo === '--atualizar' ? 1 : 0);
  }
  publicadas = recortar(manifesto, indexarOpenApi(docs as Parameters<typeof indexarOpenApi>[0]));
  if (modo === '--atualizar') {
    writeFileSync(CAMINHO_RECORTE, `${JSON.stringify(publicadas, null, 2)}\n`);
    console.log(`recorte regravado com ${publicadas.length} operações`);
  }
} else if (modo === undefined) {
  publicadas = JSON.parse(readFileSync(CAMINHO_RECORTE, 'utf8')) as OperacaoPublicada[];
} else {
  console.error(`opção desconhecida: ${modo}`);
  process.exit(2);
}

const { erros, avisos } = compararDrift(manifesto, publicadas);
for (const a of avisos) console.warn(`aviso: ${a}`);
for (const e of erros) console.error(`drift: ${e}`);
if (erros.length > 0) process.exit(1);
console.log(`drift v2 ok: ${manifesto.operations.length} operações, ${avisos.length} aviso(s)`);
