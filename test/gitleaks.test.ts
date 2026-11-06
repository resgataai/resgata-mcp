import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONFIG = join(import.meta.dirname, '..', '.gitleaks.toml');

/** Os padrões são montados em tempo de execução para o próprio teste não disparar o gitleaks do repositório. */
const j = (...partes: string[]) => partes.join('');

function vaza(conteudo: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-'));
  writeFileSync(join(dir, 'amostra.txt'), `${conteudo}\n`);
  const r = spawnSync('gitleaks', ['dir', '--no-banner', '--redact', '--exit-code', '1', '-c', CONFIG, dir], {
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  return r.status === 1;
}

describe('regras próprias do .gitleaks.toml', () => {
  it.each([
    ['CPF formatado', j('cpf ', '123', '.456', '.789', '-09')],
    ['CPF sem pontuação', j('cpf ', '1234567', '8909')],
    ['host interno de cluster', j('servico.exemplo', '.svc', '.cluster', '.local')],
    ['host interno do GCP', j('vm-1.c.projeto', '.inter', 'nal')],
    ['IP privado 10/8', j('10', '.20', '.30', '.40')],
    ['IP privado 172.16/12', j('172', '.20', '.1', '.1')],
    ['IP privado 192.168/16', j('192', '.168', '.0', '.1')],
    ['conta de serviço', j('robo@projeto', '.iam', '.gserviceaccount', '.com')],
    ['recipient age', j('age', '1', 'q'.repeat(58))],
    ['registro de imagens', j('regiao-docker', '.pkg', '.dev/', 'repo')],
  ])('%s → falha', (_nome, amostra) => {
    expect(vaza(amostra)).toBe(true);
  });

  it('CPF sintético com prefixo 000.000. passa', () => {
    expect(vaza(j('cpf ', '000', '.000', '.001-91', ' e ', '000000', '00191'))).toBe(false);
  });
});
