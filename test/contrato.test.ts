import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contemProibido, lerNomes, listaDoAmbiente, palavras } from '../scripts/nomes-proibidos.js';
import {
  CAMINHO_RECORTE,
  carregarManifesto,
  compararDrift,
  indexarOpenApi,
  type OperacaoPublicada,
  recortar,
} from '../src/v2/contrato.js';

const recorte = (): OperacaoPublicada[] => JSON.parse(readFileSync(CAMINHO_RECORTE, 'utf8'));

describe('manifesto da V2 e drift', () => {
  it('manifesto versionado é válido e sem drift contra o recorte', () => {
    const m = carregarManifesto();
    expect(m.operations.length).toBeGreaterThan(30);
    expect(compararDrift(m, recorte()).erros).toEqual([]);
  });

  it('caminho ou método alterado na V2 é drift; operação pendente ausente é só aviso', () => {
    const base = carregarManifesto();
    const m = {
      ...base,
      operations: base.operations.map((o) => (o.operationId === 'adminMcpToolCallsMine' ? { ...o, pending: true } : o)),
    };
    const alterado = recorte()
      .filter((o) => o.operationId !== 'adminMcpToolCallsMine')
      .map((o) => (o.operationId === 'me' ? { ...o, path: '/v2/auth/eu' } : o));
    const r = compararDrift(m, alterado);
    expect(r.erros).toEqual(['me: manifesto GET /v2/auth/me, V2 GET /v2/auth/eu']);
    expect(r.avisos.some((a) => a.startsWith('adminMcpToolCallsMine'))).toBe(true);
  });

  it('operação removida da V2 é drift', () => {
    const r = compararDrift(
      carregarManifesto(),
      recorte().filter((o) => o.operationId !== 'lookup'),
    );
    expect(r.erros).toEqual(['lookup: não existe na OpenAPI da V2']);
  });

  it('recorte a partir de OpenAPI completa guarda só método, caminho, operationId e nomes de parâmetro', () => {
    const indice = indexarOpenApi([
      {
        paths: {
          '/v2/auth/me': { get: { operationId: 'me', parameters: [{ name: 'z' }, { name: 'a' }] } },
          '/v2/fora': { get: { operationId: 'fora' } },
        },
      },
    ]);
    expect(recortar(carregarManifesto(), indice)).toEqual([
      { operationId: 'me', method: 'GET', path: '/v2/auth/me', params: ['a', 'z'] },
    ]);
  });
});

describe('nomes proibidos', () => {
  const lista = lerNomes('# comentário\nParceiroX\nbanco fulano\n\n---\n');

  it('quebra camelCase, snake_case e domínios em palavras', () => {
    expect(palavras('providerLogMessages api_cliente exemplo.com.br')).toEqual([
      'provider',
      'log',
      'messages',
      'api',
      'cliente',
      'exemplo',
      'com',
      'br',
    ]);
  });

  it('acha o nome como palavra inteira, também dentro de identificador; expressão só na sequência', () => {
    expect(lista).toEqual(['ParceiroX', 'banco fulano']);
    expect(contemProibido('o provedor respondeu com atraso', lista)).toBe(false);
    expect(contemProibido('const tokenParceiro = 1', lista)).toBe(false);
    expect(contemProibido('const tokenParceirox = 1', lista)).toBe(true);
    expect(contemProibido('const parceiroxToken = 1', lista)).toBe(true);
    expect(contemProibido('https://api.parceirox.com.br', lista)).toBe(true);
    expect(contemProibido('a ParceiroX respondeu', lista)).toBe(true);
    expect(contemProibido('o bancoFulano caiu', lista)).toBe(true);
    expect(contemProibido('banco do fulano', lista)).toBe(false);
  });

  it('lista privada: sem lista pula fora do release; obrigatória ou indicada e ausente é erro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nomes-'));
    const ausente = join(dir, 'nao-existe');
    expect(listaDoAmbiente({}, ausente)).toBeNull();
    expect(() => listaDoAmbiente({ NOMES_PROIBIDOS_OBRIGATORIO: '1' }, ausente)).toThrow(/obrigatória/);
    expect(() => listaDoAmbiente({ NOMES_PROIBIDOS_ARQUIVO: ausente })).toThrow(/obrigatória/);
    const arquivo = join(dir, 'lista');
    writeFileSync(arquivo, '# só comentário\n');
    expect(() => listaDoAmbiente({ NOMES_PROIBIDOS_ARQUIVO: arquivo })).toThrow(/vazia/);
    writeFileSync(arquivo, 'parceirox\n');
    expect(listaDoAmbiente({ NOMES_PROIBIDOS_ARQUIVO: arquivo, NOMES_PROIBIDOS_OBRIGATORIO: '1' })).toEqual([
      'parceirox',
    ]);
  });
});
