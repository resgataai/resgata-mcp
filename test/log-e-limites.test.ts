import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LimiteJanela, Semaforo } from '../src/limites.js';
import { criarLog, paramsAuditaveis } from '../src/log.js';

function capturar() {
  const linhas: string[] = [];
  const destino = new Writable({
    write(parte, _enc, cb) {
      linhas.push(String(parte));
      cb();
    },
  });
  return { log: criarLog('debug', destino), saida: () => linhas.join('') };
}

const CPF = ['000', '.000', '.001', '-91'].join('');
const CPF_REAL = ['123', '.456', '.789', '-09'].join('');

describe('log por lista positiva', () => {
  it('CPF num argumento livre não aparece no log', () => {
    const { log, saida } = capturar();
    const args = { identificador: CPF_REAL, periodo: '7d' };
    log.info('mcp.tool_call', {
      ferramenta: 'clientes_buscar',
      params: paramsAuditaveis(args, { periodo: 'claro' }, randomBytes(32)),
      ...args,
    });
    expect(saida()).toContain('clientes_buscar');
    expect(saida()).toContain('7d');
    expect(saida()).not.toContain(CPF_REAL);
    expect(saida()).not.toContain('123');
  });

  it('parâmetro auditável por HMAC não sai em claro, e é estável para correlação', () => {
    const k = randomBytes(32);
    const a = paramsAuditaveis({ identificador: CPF }, { identificador: 'hmac' }, k);
    const b = paramsAuditaveis({ identificador: CPF }, { identificador: 'hmac' }, k);
    expect(a.identificador).toMatch(/^hmac:/);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain('001');
  });

  it('CPF em texto de campo permitido é mascarado; chaves sensíveis são redigidas', () => {
    const { log, saida } = capturar();
    log.warn('teste', { motivo: `cliente ${CPF_REAL} pediu`, authorization: 'Bearer abc', cpf: CPF_REAL });
    expect(saida()).toContain('[cpf]');
    expect(saida()).not.toContain(CPF_REAL);
    expect(saida()).not.toContain('Bearer abc');
  });
});

describe('limites', () => {
  it('janela fixa bloqueia o excedente e reabre na janela seguinte', () => {
    let t = 0;
    const l = new LimiteJanela(30, 60_000, () => t);
    for (let i = 0; i < 30; i++) expect(l.consumir('ip').ok).toBe(true);
    expect(l.consumir('ip').ok).toBe(false);
    expect(l.consumir('outro-ip').ok).toBe(true);
    t = 60_000;
    expect(l.consumir('ip').ok).toBe(true);
  });

  it('semáforo de 4 vagas recusa a 5ª e libera uma vez só', () => {
    const s = new Semaforo(4);
    const vagas = [s.tentar(), s.tentar(), s.tentar(), s.tentar()];
    expect(s.tentar()).toBeNull();
    vagas[0]?.();
    vagas[0]?.();
    expect(s.emUso).toBe(3);
    expect(s.tentar()).not.toBeNull();
  });
});
