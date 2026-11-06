import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it } from 'vitest';
import { FERRAMENTAS } from '../src/ferramentas/index.js';
import { criarLimites } from '../src/limites.js';
import { criarLog } from '../src/log.js';
import type { ContextoFerramenta } from '../src/mcp/ferramenta.js';
import * as cliente from '../src/v2/cliente.js';

const fechar: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of fechar.splice(0)) await f();
});

async function modulo() {
  expect(existsSync(new URL('../src/local/maquina.ts', import.meta.url))).toBe(true);
  return import('../src/local/maquina.js');
}

it('renova token de máquina sem login, com uma emissão por vez e escopos do realm', async () => {
  const { criarTokenMaquina } = await modulo();
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'teste' };
  let agora = Date.now();
  let emissoes = 0;
  let papeis = ['MCP_ACCESS', 'MCP_READ_BI'];
  const servidor = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/certs')) return res.end(JSON.stringify({ keys: [jwk] }));
    emissoes++;
    const jwt = await new SignJWT({ azp: 'maquina-teste', realm_access: { roles: papeis } })
      .setProtectedHeader({ alg: 'ES256', kid: 'teste' })
      .setIssuer(issuer)
      .setAudience('resgata-api')
      .setSubject('maquina-sub')
      .setIssuedAt(Math.floor(agora / 1000))
      .setExpirationTime(Math.floor(agora / 1000) + 300)
      .sign(privateKey);
    res.end(JSON.stringify({ access_token: jwt, expires_in: 300 }));
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  fechar.push(() => new Promise<void>((ok) => servidor.close(() => ok())));
  const issuer = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/realms/teste`;
  const token = criarTokenMaquina(
    { issuer, clientId: 'maquina-teste', clientSecret: 'sintetico', subject: 'maquina-sub' },
    () => agora,
  );
  const [a, b] = await Promise.all([token(), token()]);
  expect(a.token).toBe(b.token);
  expect(emissoes).toBe(1);
  expect([...a.escopos]).toEqual(['resgata:read.bi']);
  agora += 271_000;
  papeis = ['MCP_ACCESS'];
  expect([...(await token()).escopos]).toEqual([]);
  expect(emissoes).toBe(2);
  agora += 271_000;
  papeis = [];
  await expect(token()).rejects.toMatchObject({ codigo: 'reautenticar' });
  const errada = criarTokenMaquina(
    { issuer, clientId: 'outro-cliente', clientSecret: 'sintetico', subject: 'maquina-sub' },
    () => agora,
  );
  await expect(errada()).rejects.toMatchObject({ codigo: 'reautenticar' });
});

it('reutiliza a allowlist e nega operação ou escopo não permitido antes de chamar a API', async () => {
  expect(cliente).toHaveProperty('criarClienteOperacoes');
  const c = cliente.criarClienteOperacoes(
    { baseUrl: 'https://example.invalid', limites: criarLimites(), log: criarLog('silent') },
    async () => ({ token: 'sintetico', venceEm: Date.now() + 300_000, escopos: new Set<string>() }),
  );
  await expect(c.chamar({ operacao: 'fora_do_manifesto', grantId: 'm', requestId: 'r' })).rejects.toMatchObject({
    codigo: 'erro_interno',
  });
  await expect(
    c.chamar({ operacao: 'me', grantId: 'm', requestId: 'r', escopos: ['resgata:read.bi'] }),
  ).rejects.toMatchObject({ codigo: 'insufficient_scope' });
});

it('auditoria local é privada, persistente e falha fechada para arquivo inseguro', async () => {
  const { criarAuditoriaLocal } = await modulo();
  const dir = mkdtempSync(join(tmpdir(), 'mcp-local-'));
  fechar.push(() => rmSync(dir, { recursive: true }));
  const arquivo = join(dir, 'auditoria.jsonl');
  const a = criarAuditoriaLocal(arquivo);
  const linha = {
    tool: 'teste',
    outcome: 'accepted' as const,
    userSub: 'sub',
    grantId: 'maquina',
    clientId: 'codex',
    requestId: 'r',
    params: {},
    paramsDigest: 'digest',
    latencyMs: 0,
  };
  await a.registrarAgora(linha);
  await a.esvaziar();
  expect(JSON.parse(readFileSync(arquivo, 'utf8'))).toMatchObject(linha);
  chmodSync(arquivo, 0o644);
  expect(() => criarAuditoriaLocal(arquivo)).toThrow(/privad/);
});

it('stdio revalida permissão em cada chamada e aplica limite antes de executar a ferramenta', async () => {
  const m = await modulo();
  expect(m).toHaveProperty('protegerFerramentasLocais');
  let acesso = new Set<string>();
  const limites = criarLimites();
  const v2 = {
    chamar: async () => {
      throw new Error('não deve chamar API');
    },
    escoposEfetivos: async () => acesso,
  };
  const ferramentas = m.protegerFerramentasLocais(FERRAMENTAS, v2, limites);
  const f = ferramentas.find((f) => f.escopos.length > 0);
  if (!f) throw new Error('ferramenta de leitura ausente');
  const ctx: ContextoFerramenta = {
    sub: 'sub',
    grantId: 'maquina',
    clientId: 'codex',
    escopos: new Set(f.escopos),
    requestId: 'r',
    log: criarLog('silent'),
    limites,
    efeitosLigados: false,
    transcricoesLigadas: false,
    chaves: { plano: Buffer.alloc(32), cursor: Buffer.alloc(32) },
    catalogo: { ferramentas, desligadas: new Set() },
    provedores: [],
    registro: {},
    chamar: async () => {
      throw new Error('não deve chamar API');
    },
    antesDoEfeito: async () => {},
    agora: () => new Date(),
  };
  await expect(f.executar({}, ctx)).rejects.toMatchObject({ codigo: 'insufficient_scope' });
  acesso = new Set(f.escopos);
  for (let i = 0; i < 60; i++) limites.porGrant.consumir(ctx.grantId);
  await expect(f.executar({}, ctx)).rejects.toMatchObject({ codigo: 'ocupado' });
});
