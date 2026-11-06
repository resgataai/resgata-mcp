import { describe, expect, it } from 'vitest';
import { diaBrt } from '../src/mcp/envelope.js';
import { mascararProfundo, mascararTextoLivre, textoExterno } from '../src/mcp/mascara.js';
import { chaveIdempotencia } from '../src/mcp/plano.js';
import { classificar, PROVEDORES_PADRAO, resolverApelido } from '../src/mcp/provedores.js';
import { PROVEDORES_TESTE } from './ambiente.js';

describe('máscara em texto livre', () => {
  it.each([
    ['CPF 000.000.001-91 ok', 'CPF ***.***.*01-91 ok'],
    ['cpf 00000000191.', 'cpf ***.***.*01-91.'],
    ['ligue (11) 90000-0001', 'ligue (**) *****-0001'],
    ['ligue +55 11 90000-0001 hoje', 'ligue (**) *****-0001 hoje'],
    ['mail Cliente.Um@exemplo.invalid', 'mail C***@e***.invalid'],
    ['CEP 01000-000', '*****-***'],
    ['mora no 01000-000.', 'mora no *****-***.'],
  ])('%s', (entrada, saida) => {
    expect(mascararTextoLivre(entrada)).toBe(saida);
  });

  it('não morde UUID, datas, horários, valores nem ids', () => {
    for (const t of [
      '00000000-0000-4000-8000-000000000001',
      '2026-11-06T13:00:00-03:00',
      'R$ 1.500,00 em 12 parcelas',
      'conversa:77/msg:123456',
      'grant-a1b2c3',
    ]) {
      expect(mascararTextoLivre(t)).toBe(t);
    }
  });

  it('é idempotente e preserva cursor, plano e request_id', () => {
    const t = 'x 000.000.001-91 y';
    expect(mascararTextoLivre(mascararTextoLivre(t))).toBe(mascararTextoLivre(t));
    expect(mascararProfundo({ request_id: '00000000191', plan_id: 'a.b', a: ['00000000191'] })).toEqual({
      request_id: '00000000191',
      plan_id: 'a.b',
      a: ['***.***.*01-91'],
    });
  });

  it('texto de terceiros perde controle e formatação invisível e respeita o tamanho', () => {
    expect(textoExterno('a\u0000b​c‮d\ne', 100)).toBe('abcd\ne');
    expect(textoExterno('x'.repeat(10), 5)).toBe('xxxx…');
    expect(textoExterno(undefined)).toBeNull();
  });
});

describe('chave de idempotência pelo conteúdo', () => {
  const base = { sub: 's', ferramenta: 'contato_executar', userUuid: 'u', canal: 'EMAIL', templateId: '101' };
  const dia = (iso: string) => diaBrt(new Date(iso));
  it('mesmo conteúdo no mesmo dia (BRT) → mesma chave; outro dia, modelo ou nonce → outra', () => {
    const k = chaveIdempotencia({ ...base, dia: dia('2026-11-06T15:00:00Z') });
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(chaveIdempotencia({ ...base, dia: dia('2026-11-07T02:59:00Z') })).toBe(k); // 23h59 em São Paulo
    expect(chaveIdempotencia({ ...base, dia: dia('2026-11-07T03:00:00Z') })).not.toBe(k);
    expect(chaveIdempotencia({ ...base, dia: '2026-11-06', templateId: '102' })).not.toBe(k);
    expect(chaveIdempotencia({ ...base, dia: '2026-11-06', nonce: 'n' })).not.toBe(k);
  });
});

describe('provedores', () => {
  it('apelidos configurados resolvem para nós distintos, como palavra inteira e sem acento', () => {
    const ids = (texto: string) => resolverApelido(texto, PROVEDORES_TESTE).map((n) => n.id);
    expect(ids('o Órgão X caiu?')).toEqual(['orgao_x']);
    expect(ids('BCA')).toEqual(['banco_a']);
    expect(ids('banco b e banco a')).toEqual(['banco_a', 'banco_b']);
    expect(ids('o banco abc')).toEqual([]);
    expect(ids('provedor qualquer')).toEqual([]);
  });

  it('o padrão público só tem nós genéricos', () => {
    expect(PROVEDORES_PADRAO.map((n) => [n.id, n.relacao, n.codigos.length])).toEqual([
      ['provedor_bancario', 'direto', 0],
    ]);
    expect(resolverApelido('o provedor bancário parou?', PROVEDORES_PADRAO).map((n) => n.id)).toEqual([
      'provedor_bancario',
    ]);
    expect(resolverApelido('parceirox', PROVEDORES_PADRAO)).toEqual([]);
  });

  it('classificação: volume baixo é indeterminada; recusa de negócio não conta como falha', () => {
    expect(classificar({ providerCode: 'X', succeededCalls: 9, failedCalls: 1 }, 60)).toMatchObject({
      valor: 'indeterminada',
      n: 10,
      confianca: 'baixa',
    });
    expect(
      classificar({ providerCode: 'X', succeededCalls: 40, failedCalls: 0, businessRefusalCalls: 60 }, 60).valor,
    ).toBe('normal');
    expect(classificar({ providerCode: 'X', succeededCalls: 0, failedCalls: 60 }, 60).valor).toBe('indisponivel');
    expect(classificar({ providerCode: 'X', succeededCalls: 900, failedCalls: 100 }, 60)).toMatchObject({
      valor: 'degradado',
      confianca: 'alta',
    });
  });
});
