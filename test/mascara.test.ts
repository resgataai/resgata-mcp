import { describe, expect, it } from 'vitest';
import { mascararProfundo, mascararTextoLivre, textoExterno } from '../src/mcp/mascara.js';
import { chaveIdempotencia } from '../src/mcp/plano.js';
import { classificar, resolverApelido } from '../src/mcp/provedores.js';

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
  const dia = new Date('2026-11-06T15:00:00Z');
  it('mesmo conteúdo no mesmo dia (BRT) → mesma chave; outro dia, modelo ou nonce → outra', () => {
    const k = chaveIdempotencia(base, dia);
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(chaveIdempotencia(base, new Date('2026-11-07T02:59:00Z'))).toBe(k); // 23h59 em São Paulo
    expect(chaveIdempotencia(base, new Date('2026-11-07T03:00:00Z'))).not.toBe(k);
    expect(chaveIdempotencia({ ...base, templateId: '102' }, dia)).not.toBe(k);
    expect(chaveIdempotencia({ ...base, nonce: 'n' }, dia)).not.toBe(k);
  });
});

describe('provedores', () => {
  it('apelidos públicos resolvem para nós distintos', () => {
    expect(resolverApelido('a Dataprev caiu?').map((n) => n.id)).toEqual(['dataprev']);
    expect(resolverApelido('CEF').map((n) => n.id)).toEqual(['caixa']);
    expect(resolverApelido('bmp e caixa').map((n) => n.id)).toEqual(['bmp', 'caixa']);
    expect(resolverApelido('provedor qualquer')).toEqual([]);
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
