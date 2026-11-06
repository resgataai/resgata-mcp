import { expect, it } from 'vitest';
import { endpointTecnico, sanitizarTecnico } from '../src/mcp/dados-tecnicos.js';

it('preserva mensagens/códigos, mas remove credenciais em corpo texto, erro, JSON e URL', () => {
  const entrada = {
    code: 'AUTH_FAILED',
    message: 'Token de acesso expirou',
    error: {
      message:
        'Falha: token=canario-token; secret=canario-secret; passwd=canario-pass; signature=canario-sign; credential=canario-cred; auth=canario-auth; pass=canario-curta; sig=canario-sig',
    },
    body: 'token=canario-token; secret=canario-secret',
    nested: { pwd: 'canario-pwd', apiKey: 'canario-api' },
    json: '{"password":"canario-json","code":"AUTH_FAILED"}',
    url: 'https://canario-user:canario-senha@example.invalid/a?%74oken=canario-url&reason=AUTH_FAILED',
  };
  const seguro = sanitizarTecnico(entrada);
  expect(seguro).toMatchObject({ code: 'AUTH_FAILED', message: 'Token de acesso expirou' });
  const texto = JSON.stringify(seguro);
  for (const s of [
    'canario-token',
    'canario-secret',
    'canario-pass',
    'canario-sign',
    'canario-cred',
    'canario-auth',
    'canario-curta',
    'canario-sig',
    'canario-pwd',
    'canario-api',
    'canario-json',
    'canario-user',
    'canario-senha',
    'canario-url',
  ])
    expect(texto).not.toContain(s);
  expect(texto).toContain('AUTH_FAILED');
  expect(endpointTecnico(entrada.url)).toBe('https://example.invalid/a');
});
