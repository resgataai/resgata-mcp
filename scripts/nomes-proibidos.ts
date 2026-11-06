// Nomes que não podem aparecer no repositório público (parceiros comerciais: os textos dizem "o provedor").
// A lista guarda só SHA-256 de cada palavra em minúsculas, sem acento, para o próprio arquivo não citar o nome.
// Acrescentar: printf '%s' nome | shasum -a 256
//
//   bun run nomes             árvore de trabalho (arquivos versionados e novos não ignorados)
//   bun run nomes --staged    só o conteúdo preparado para commit (pre-commit)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const PROIBIDOS = new Set([
  'a01590c0e4c6d38bb60f5cb07fe000d2194c48e7f6472f7958330f81bd2ec81e',
  'dde444a9246a61775c0236a66036f6f2da51426d0a7b051ab29f600b39dbccdf',
  '11f95e175d1fb49b4bae34edd8d9b1129525e9ae4614170946cadc2840a8d4ac',
  '57eb56a2dfb733e1baaeae7da43882474be7753efd3ca9876c70b4f2f0c6b091',
]);

/** Separa camelCase, snake_case, domínios e caminhos em palavras simples. */
export function palavras(texto: string): Set<string> {
  const normal = texto
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return new Set(normal.match(/[a-z0-9]+/g) ?? []);
}

export function contemProibido(texto: string, proibidos: ReadonlySet<string> = PROIBIDOS): boolean {
  for (const p of palavras(texto)) {
    if (proibidos.has(createHash('sha256').update(p).digest('hex'))) return true;
  }
  return false;
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

if (import.meta.main) {
  const staged = process.argv.includes('--staged');
  const arquivos = staged
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)
    : git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  const achados: string[] = [];
  for (const arquivo of arquivos) {
    const nomeOk = !contemProibido(arquivo);
    let conteudo = '';
    if (staged) conteudo = git('show', `:${arquivo}`);
    else if (existsSync(arquivo)) conteudo = readFileSync(arquivo, 'utf8');
    if (!nomeOk || contemProibido(conteudo)) achados.push(arquivo);
  }
  if (achados.length > 0) {
    console.error('nome proibido no repositório público (use "o provedor"):');
    for (const a of achados) console.error(`  ${a}`);
    process.exit(1);
  }
  console.log(`nomes proibidos: ok (${arquivos.length} arquivos)`);
}
