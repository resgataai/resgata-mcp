import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { carregarConfig, ErroDeConfiguracao } from '../src/config.js';

const chave = () => randomBytes(32).toString('base64url');
const producao = (): NodeJS.ProcessEnv => ({
  MCP_MODO: 'producao',
  MCP_PUBLIC_URL: 'https://mcp.exemplo.invalid',
  MCP_RESOURCE: 'https://mcp.exemplo.invalid/mcp',
  V2_API_BASE_URL: 'http://v2.exemplo.invalid:8080',
  KEYCLOAK_ISSUER: 'https://idp.exemplo.invalid/realms/demo',
  KEYCLOAK_CLIENT_ID: 'cliente',
  KEYCLOAK_CLIENT_SECRET: 'x'.repeat(32),
  KEYCLOAK_SVC_CLIENT_ID: 'servico',
  KEYCLOAK_SVC_CLIENT_SECRET: 'y'.repeat(32),
  MCP_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', d: 'd', x: 'x', y: 'y', kid: 'k1' }] }),
  MCP_COOKIE_KEYS: 'z'.repeat(40),
  MCP_UPSTREAM_KEY: chave(),
  MCP_PLAN_KEY: chave(),
  MCP_CURSOR_KEY: chave(),
  MCP_AUDIT_HMAC_KEY: chave(),
});

describe('configuração', () => {
  it('produção válida carrega, com efeitos desligados por padrão', () => {
    const c = carregarConfig(producao());
    expect(c.modo).toBe('producao');
    expect(c.efeitosLigados).toBe(false);
    expect(c.chaves.plano).toHaveLength(32);
  });

  it('produção é o modo padrão e lista as variáveis que faltam, sem valores', () => {
    const env = producao();
    delete env.MCP_MODO;
    delete env.V2_API_BASE_URL;
    env.MCP_PLAN_KEY = 'curta-demais';
    const erro = (() => {
      try {
        carregarConfig(env);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(erro).toBeInstanceOf(ErroDeConfiguracao);
    expect(erro?.message).toContain('V2_API_BASE_URL');
    expect(erro?.message).toContain('MCP_PLAN_KEY');
    expect(erro?.message).not.toContain('curta-demais');
  });

  it('MCP_RESOURCE precisa ser a URL pública + /mcp', () => {
    expect(() => carregarConfig({ ...producao(), MCP_RESOURCE: 'https://outro.invalid/mcp' })).toThrow(/MCP_RESOURCE/);
  });

  it('produção exige https no endereço público', () => {
    expect(() => carregarConfig({ ...producao(), MCP_PUBLIC_URL: 'http://mcp.exemplo.invalid' })).toThrow(
      ErroDeConfiguracao,
    );
  });

  it('demo sobe sem nenhuma variável de produção e gera chaves efêmeras', () => {
    const c = carregarConfig({ MCP_MODO: 'demo', PORT: '9999' });
    expect(c.urlPublica).toBe('http://localhost:9999');
    expect(c.recurso).toBe('http://localhost:9999/mcp');
    expect(c.chaves.jwks.keys).toHaveLength(1);
    expect(c.v2BaseUrl).toBeUndefined();
  });

  it.each([
    'V2_API_BASE_URL',
    'KEYCLOAK_ISSUER',
    'KEYCLOAK_CLIENT_ID',
    'KEYCLOAK_CLIENT_SECRET',
    'KEYCLOAK_SVC_CLIENT_ID',
    'KEYCLOAK_SVC_CLIENT_SECRET',
  ])('demo recusa subir com %s definida', (variavel) => {
    expect(() => carregarConfig({ MCP_MODO: 'demo', [variavel]: 'qualquer' })).toThrow(/modo demo recusa/);
  });

  it('demo recusa o host público de produção', () => {
    expect(() => carregarConfig({ MCP_MODO: 'demo', MCP_PUBLIC_URL: 'https://mcp.resgata.ai' })).toThrow(
      /MCP_PUBLIC_URL/,
    );
  });

  it('modo desconhecido é recusado', () => {
    expect(() => carregarConfig({ MCP_MODO: 'teste' })).toThrow(ErroDeConfiguracao);
  });
});
