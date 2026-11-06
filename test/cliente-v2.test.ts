import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENTE_1 } from '../src/demo/fixtures.js';
import { cifrar, decifrar } from '../src/oauth/cifra.js';
import { conferirPeriodo, erroDaV2 } from '../src/v2/cliente.js';
import { ErroV2 } from '../src/v2/tipos.js';
import { type Ambiente, subirAmbiente } from './ambiente.js';

let amb: Ambiente | undefined;
afterEach(async () => {
  await amb?.fechar();
  amb = undefined;
});

const falha = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ErroV2;
  }
  throw new Error('esperava erro');
};

describe('mapeamento de erros da V2', () => {
  const h = (extra: Record<string, string> = {}) => new Headers(extra);
  it.each([
    [400, {}, 'invalido'],
    [422, {}, 'invalido'],
    [401, {}, 'tentar_novamente'],
    [403, { causeId: 'mcp_route_not_allowed' }, 'indisponivel_por_gate'],
    [403, {}, 'insufficient_scope'],
    [404, {}, 'nao_encontrado'],
    [409, { causeId: 'idempotency_request_in_progress' }, 'em_andamento'],
    [409, { causeId: 'idempotency_key_reused' }, 'invalido'],
    [409, { causeId: 'channel_gate_closed' }, 'indisponivel_por_gate'],
    [423, {}, 'indisponivel_por_gate'],
    [429, {}, 'tentar_novamente'],
    [500, {}, 'erro_interno'],
    [503, {}, 'tentar_novamente'],
  ])('%i %j → %s', (status, corpo, codigo) => {
    expect(erroDaV2(status, corpo, h(), 'r').codigo).toBe(codigo);
  });

  it('gate fechado leva o nome do gate; Retry-After vira prazo', () => {
    expect(erroDaV2(409, { causeId: 'channel_gate_closed' }, h(), 'r').detalhes.gate).toBe('channel_gate_closed');
    expect(erroDaV2(503, {}, h({ 'retry-after': '42' }), 'r').detalhes.tentarNovamenteEmS).toBe(42);
  });
});

describe('teto de período (92 dias)', () => {
  it('aceita 92 dias e recusa 93, em datas, meses e no corpo', () => {
    expect(() =>
      conferirPeriodo({ from: '2026-08-01T00:00:00-03:00', to: '2026-10-31T23:59:59.999-03:00' }),
    ).not.toThrow();
    expect(() => conferirPeriodo({ from: '2026-08-01T00:00:00-03:00', to: '2026-11-02T00:00:00-03:00' })).toThrow(
      ErroV2,
    );
    expect(() => conferirPeriodo({ fromMonth: '2026-08', toMonth: '2026-10' })).not.toThrow();
    expect(() => conferirPeriodo({ fromMonth: '2026-06', toMonth: '2026-10' })).toThrow(/92 dias/);
    expect(() => conferirPeriodo(undefined, { createdAtFrom: '2026-01-01', createdAtTo: '2026-12-31' })).toThrow();
  });
});

describe('cifra do refresh offline', () => {
  it('ida e volta; outra AAD ou outra chave falham', () => {
    const chave = randomBytes(32);
    const c = cifrar(chave, 'segredo-sintetico', 'grant-1');
    expect(decifrar(chave, c, 'grant-1')).toBe('segredo-sintetico');
    expect(() => decifrar(chave, c, 'grant-2')).toThrow();
    expect(() => decifrar(randomBytes(32), c, 'grant-1')).toThrow();
  });
});

describe('cliente da V2', () => {
  const pedido = (grantId: string, extra: Record<string, unknown>) =>
    ({ grantId, requestId: 'req-teste-1', ...extra }) as Parameters<Ambiente['cliente']['chamar']>[0];

  it('propaga X-Request-Id, traceparent e tira o envelope ApiResponse', async () => {
    amb = await subirAmbiente();
    const a = amb;
    const g = await a.conectar('demo-usuario-1');
    const r = await a.cliente.chamar<{ subject: string }>(pedido(g, { operacao: 'me' }));
    expect(r).toMatchObject({ status: 200, dados: { subject: 'demo-usuario-1' }, replay: false });
    const c = a.v2.chamadas.at(-1);
    expect(c?.cabecalhos['x-request-id']).toBe('req-teste-1');
    expect(c?.cabecalhos.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('recusa path traversal, parâmetro proibido, operação fora do manifesto e efeito sem chave, sem sair do processo', async () => {
    amb = await subirAmbiente();
    const a = amb;
    const g = await a.conectar('demo-usuario-1');
    for (const v of ['..', '.', 'a/b', '%2e%2e', '']) {
      const e = await falha(a.cliente.chamar(pedido(g, { operacao: 'timeline', caminho: { userUuid: v } })));
      expect(e.codigo, v).toBe('invalido');
    }
    expect(
      (await falha(a.cliente.chamar(pedido(g, { operacao: 'listChatwootConversations', consulta: { q: 'x' } }))))
        .codigo,
    ).toBe('invalido');
    expect((await falha(a.cliente.chamar(pedido(g, { operacao: 'searchProviderEventsByBody' })))).codigo).toBe(
      'erro_interno',
    );
    expect(
      (await falha(a.cliente.chamar(pedido(g, { operacao: 'adminIndividualSend', corpo: { userUuid: CLIENTE_1 } }))))
        .codigo,
    ).toBe('erro_interno');
    expect(a.v2.chamadas).toEqual([]);
  });

  it('503 com Retry-After vira tentar_novamente com o prazo e não é repetido; 502 em GET tenta uma vez mais', async () => {
    amb = await subirAmbiente();
    const a = amb;
    const g = await a.conectar('demo-usuario-1');
    a.v2.definir('me', () => ({ status: 503, corpo: { message: 'ocupado' }, cabecalhos: { 'retry-after': '17' } }));
    const e = await falha(a.cliente.chamar(pedido(g, { operacao: 'me' })));
    expect(e).toMatchObject({ codigo: 'tentar_novamente', detalhes: { tentarNovamenteEmS: 17 } });
    expect(a.v2.chamadas.filter((c) => c.operacao === 'me')).toHaveLength(1);
    let n = 0;
    a.v2.definir('chatwootAttentionCounts', () =>
      ++n === 1 ? { status: 502, corpo: {} } : { status: 200, corpo: { escalations: 1 } },
    );
    expect((await a.cliente.chamar(pedido(g, { operacao: 'chatwootAttentionCounts' }))).dados).toEqual({
      escalations: 1,
    });
    expect(n).toBe(2);
    a.v2.definir('lookup', () => ({ status: 502, corpo: {} }));
    await falha(a.cliente.chamar(pedido(g, { operacao: 'lookup', corpo: { uuid: CLIENTE_1 } })));
    expect(a.v2.chamadas.filter((c) => c.operacao === 'lookup')).toHaveLength(1);
  });

  it('semáforo analítico cheio → ocupado sem chamar a V2', async () => {
    amb = await subirAmbiente();
    const a = amb;
    const g = await a.conectar('demo-usuario-1');
    const vagas = [1, 2, 3, 4].map(() => a.limites.analiticas.tentar());
    const e = await falha(a.cliente.chamar(pedido(g, { operacao: 'conversionOverview' })));
    expect(e.codigo).toBe('ocupado');
    for (const v of vagas) v?.();
    expect((await a.cliente.chamar(pedido(g, { operacao: 'conversionOverview' }))).status).toBe(200);
  });

  it('escopo efetivo = escopos do grant ∩ papéis; token renovado só perto de vencer, uma vez por grant', async () => {
    amb = await subirAmbiente();
    const a = amb;
    const g = await a.conectar('demo-usuario-1', ['resgata:read.bi', 'resgata:contact', 'resgata:pii']);
    expect([...(await a.cliente.escoposEfetivos(g))].sort()).toEqual(['resgata:contact', 'resgata:read.bi']);
    a.idp.definirPapeis('demo-usuario-1', ['MCP_ACCESS', 'MCP_READ_BI']);
    const [x, y] = await Promise.all([a.cliente.escoposEfetivos(g), a.cliente.escoposEfetivos(g)]);
    expect(x).toBe(y);
    expect([...x].sort()).toEqual(['resgata:contact', 'resgata:read.bi']);
    a.relogio.ms += 271_000;
    const [z, w] = await Promise.all([a.cliente.escoposEfetivos(g), a.cliente.escoposEfetivos(g)]);
    expect(z).toBe(w);
    expect([...z]).toEqual(['resgata:read.bi']);
    const e = await falha(a.cliente.chamar(pedido(g, { operacao: 'me', escopos: ['resgata:contact'] })));
    expect(e).toMatchObject({ codigo: 'insufficient_scope', detalhes: { escopos: ['resgata:contact'] } });
  });

  it('grant revogado ou inexistente → reautenticar, sem chamar o IdP', async () => {
    amb = await subirAmbiente();
    const a = amb;
    const g = await a.conectar('demo-usuario-1');
    a.v2.oauth.revogarComoPainel(g);
    expect((await falha(a.cliente.escoposEfetivos(g))).codigo).toBe('reautenticar');
    expect((await falha(a.cliente.escoposEfetivos('grant-inexistente'))).codigo).toBe('reautenticar');
  });
});
