// Nomes que não podem aparecer no repositório público (parceiros comerciais: os textos dizem "o provedor").
// A lista é privada e nunca entra no repositório, nem como hash: um nome ou expressão por linha (# comenta), lida de
// NOMES_PROIBIDOS_ARQUIVO ou, sem ela, de .nomes-proibidos na raiz (ignorado pelo git). Sem lista a checagem é pulada
// com aviso; com NOMES_PROIBIDOS_OBRIGATORIO=1 (build de release) ou arquivo indicado e ausente, falta de lista é erro.
//
//   bun run nomes             árvore de trabalho (arquivos versionados e novos não ignorados)
//   bun run nomes --staged    só o conteúdo preparado para commit (pre-commit)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** Separa camelCase, snake_case, domínios e caminhos em palavras simples, sem acento. */
export function palavras(texto: string): string[] {
  const normal = texto
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return normal.match(/[a-z0-9]+/g) ?? [];
}

const frase = (texto: string) => ` ${palavras(texto).join(' ')} `;

/**
 * Algum nome da lista aparece no texto como palavra inteira (ou sequência de palavras, se tiver mais de uma)? O texto
 * é lido com e sem a quebra de camelCase: pega `tokenParceirox` e também `ParceiroX`.
 */
export function contemProibido(texto: string, nomes: readonly string[]): boolean {
  const formas = [frase(texto), frase(texto.toLowerCase())];
  return nomes.some((n) => formas.some((t) => t.includes(frase(n.toLowerCase()))));
}

/** Linhas do arquivo da lista: sem comentários e sem linhas que não tenham letra ou número. */
export const lerNomes = (texto: string) =>
  texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#') && palavras(l).length > 0);

/** Lista do ambiente; `null` = pular (só fora do release). Lança quando a lista é obrigatória e falta. */
export function listaDoAmbiente(env: NodeJS.ProcessEnv, padrao = '.nomes-proibidos'): string[] | null {
  const arquivo = env.NOMES_PROIBIDOS_ARQUIVO || padrao;
  const nomes = existsSync(arquivo) ? lerNomes(readFileSync(arquivo, 'utf8')) : [];
  if (nomes.length > 0) return nomes;
  if (env.NOMES_PROIBIDOS_OBRIGATORIO === '1' || env.NOMES_PROIBIDOS_ARQUIVO) {
    throw new Error('lista de nomes proibidos ausente ou vazia (NOMES_PROIBIDOS_ARQUIVO); obrigatória aqui');
  }
  return null;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

if (import.meta.main) {
  let nomes: string[] | null;
  try {
    nomes = listaDoAmbiente(process.env);
  } catch (e) {
    console.error(`nomes proibidos: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!nomes) {
    console.warn(
      'nomes proibidos: PULADO, sem lista local (.nomes-proibidos ou NOMES_PROIBIDOS_ARQUIVO). O build de release exige a lista.',
    );
    process.exit(0);
  }
  const staged = process.argv.includes('--staged');
  const arquivos = staged
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)
    : git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const achados: string[] = [];
  for (const arquivo of arquivos) {
    let conteudo = '';
    if (staged) conteudo = git('show', `:${arquivo}`);
    else if (existsSync(arquivo)) conteudo = readFileSync(arquivo, 'utf8');
    if (contemProibido(arquivo, nomes) || contemProibido(conteudo, nomes)) achados.push(arquivo);
  }
  if (achados.length > 0) {
    console.error('nome proibido no repositório público (use "o provedor"):');
    for (const a of achados) console.error(`  ${a}`);
    process.exit(1);
  }
  console.log(`nomes proibidos: ok (${arquivos.length} arquivos, ${nomes.length} nomes)`);
}
