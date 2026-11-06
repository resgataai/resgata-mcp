// Confere o catálogo de ferramentas contra o manifesto da V2 (gate, PLANO §2.3 passo 5):
// toda ferramenta aponta para operações do manifesto e o manifesto aponta de volta; ferramenta com efeito só sobre
// operação com Idempotency-Key obrigatória e anotada como destrutiva; leitura anotada como só leitura; escopo
// declarado; exemplos presentes.
import { FERRAMENTAS } from '../src/ferramentas/index.js';
import { ESCOPOS } from '../src/mcp/escopos.js';
import type { Ferramenta } from '../src/mcp/ferramenta.js';
import { carregarManifesto, type Manifesto } from '../src/v2/contrato.js';

export function checarCatalogo(ferramentas: readonly Ferramenta[], manifesto: Manifesto): string[] {
  const erros: string[] = [];
  const ops = new Map(manifesto.operations.map((o) => [o.operationId, o]));
  const nomes = new Set<string>();
  for (const f of ferramentas) {
    if (nomes.has(f.nome)) erros.push(`${f.nome}: nome repetido`);
    nomes.add(f.nome);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(f.nome)) erros.push(`${f.nome}: nome fora do padrão snake_case`);
    for (const e of f.escopos) if (!(ESCOPOS as readonly string[]).includes(e)) erros.push(`${f.nome}: escopo ${e}`);
    if (f.exemplos.length === 0) erros.push(`${f.nome}: sem exemplos de pedido`);
    for (const id of f.operacoes) {
      const op = ops.get(id);
      if (!op) erros.push(`${f.nome}: operação ${id} fora do manifesto`);
      else if (!op.tools.includes(f.nome)) erros.push(`${f.nome}: manifesto de ${id} não lista a ferramenta`);
    }
    const mutacoes = f.operacoes.map((id) => ops.get(id)).filter((o) => o && o.method !== 'GET');
    if (f.efeito) {
      if (!mutacoes.some((o) => o?.idempotencyKey === 'required'))
        erros.push(`${f.nome}: efeito sem operação idempotente`);
      for (const o of mutacoes) {
        if (o?.idempotencyKey !== 'required')
          erros.push(`${f.nome}: ${o?.operationId} sem Idempotency-Key obrigatória`);
      }
      if (f.anotacoes.destructiveHint !== true || f.anotacoes.readOnlyHint !== false) {
        erros.push(`${f.nome}: efeito precisa de destructiveHint=true e readOnlyHint=false`);
      }
    } else {
      if (f.anotacoes.readOnlyHint !== true) erros.push(`${f.nome}: leitura precisa de readOnlyHint=true`);
      if (mutacoes.some((o) => o?.idempotencyKey === 'required'))
        erros.push(`${f.nome}: leitura chama operação com efeito`);
    }
  }
  for (const op of manifesto.operations) {
    for (const t of op.tools) {
      const f = ferramentas.find((x) => x.nome === t);
      if (!f) erros.push(`manifesto ${op.operationId}: ferramenta ${t} não existe`);
      else if (!f.operacoes.includes(op.operationId))
        erros.push(`manifesto ${op.operationId}: ${t} não declara a operação`);
    }
  }
  return erros;
}

if (import.meta.main) {
  const erros = checarCatalogo(FERRAMENTAS, carregarManifesto());
  for (const e of erros) console.error(`catálogo: ${e}`);
  if (erros.length > 0) process.exit(1);
  console.log(`catálogo ok: ${FERRAMENTAS.length} ferramentas`);
}
