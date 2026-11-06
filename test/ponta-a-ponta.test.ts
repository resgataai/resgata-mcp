// P6 local: o serviço montado por `iniciar()` em modo demo (a mesma ligação da produção, com V2 e IdP falsos):
// fluxo OAuth completo até as ferramentas reais, isolamento entre dois usuários e renovação concorrente por dois
// processos. Os documentos CIMD vêm sem rede (cópias em apoio-oauth.ts).
import { spawn } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../src/config.js';
import { CLIENTE_1 } from '../src/demo/fixtures.js';
import { iniciar } from '../src/iniciar.js';
import { criarLog } from '../src/log.js';
import { CIMD, CLAUDE_CODE, CODEX, Navegador, pkce, REDIRECT } from './apoio-oauth.js';

const fechar: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechar.splice(0)) await f();
});

async function subir() {
  const config = carregarConfig({ MCP_MODO: 'demo', PORT: '0', LOG_LEVEL: 'silent' });
  const inst = await iniciar(config, criarLog('silent'), {
    buscaCimd: async (u) => {
      const doc = CIMD[String(u)];
      return doc ? Response.json(doc) : new Response('', { status: 404 });
    },
  });
  fechar.push(inst.fechar);
  if (!inst.demo) throw new Error('modo demo sem V2 e IdP falsos');
  return { url: inst.url, ...inst.demo };
}
type Servico = Awaited<ReturnType<typeof subir>>;

async function token(s: Servico, form: Record<string, string>) {
  const r = await fetch(`${s.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  return { status: r.status, corpo: (await r.json()) as Record<string, string> };
}

/** Login no IdP como `sub`, consentimento aprovado e troca do código, como um cliente real faria. */
async function conectar(s: Servico, sub: string, clientId = CLAUDE_CODE) {
  s.idp.entrarComo(sub);
  const p = pkce();
  const redirect = REDIRECT[clientId] ?? '';
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: p.desafio,
    code_challenge_method: 'S256',
    scope: 'resgata:read.bi',
    state: 'e2e',
    resource: `${s.url}/mcp`,
  });
  const nav = new Navegador([s.url, new URL(s.idp.issuer).origin]);
  const tela = await nav.ir(`${s.url}/oauth/authorize?${q}`);
  expect(tela.status).toBe(200);
  const html = tela.html ?? '';
  const fim = await nav.ir(`${s.url}${/action="([^"]+)"/.exec(html)?.[1] ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '', decisao: 'aprovar' }),
  });
  const t = await token(s, {
    grant_type: 'authorization_code',
    code: fim.saida?.searchParams.get('code') ?? '',
    code_verifier: p.verificador,
    client_id: clientId,
    redirect_uri: redirect,
    resource: `${s.url}/mcp`,
  });
  expect(t.status, JSON.stringify(t.corpo)).toBe(200);
  const acesso = t.corpo.access_token ?? '';
  return { acesso, refresh: t.corpo.refresh_token ?? '', grantId: String(decodeJwt(acesso).grant_id), clientId };
}

async function cliente(s: Servico, acesso: string) {
  const c = new Client({ name: 'e2e', version: '0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${acesso}` } },
    }),
  );
  fechar.unshift(() => c.close());
  return c;
}

/** A auditoria é assíncrona (fila em memória): espera as linhas chegarem à V2 falsa. */
async function linhasDeAuditoria(s: Servico, quantas: number) {
  for (let i = 0; i < 100 && s.v2.auditoria.length < quantas; i++) await new Promise((ok) => setTimeout(ok, 20));
  return s.v2.auditoria;
}

type Resultado = { isError?: boolean; structuredContent?: Record<string, unknown> };

describe('ponta a ponta em modo demo', () => {
  it('login, consentimento, ferramentas reais contra a V2 com o token do próprio usuário, auditoria e renovação', async () => {
    const s = await subir();
    const a = await conectar(s, 'demo-usuario-1');

    const grant = s.v2.oauth.grants.get(a.grantId);
    expect(grant).toMatchObject({ userSub: 'demo-usuario-1', clientId: CLAUDE_CODE, clientName: 'Claude Code' });
    expect(grant?.scopes).toEqual(['resgata:read.bi', 'resgata:read.clientes', 'resgata:contact']);

    const c = await cliente(s, a.acesso);
    const nomes = (await c.listTools()).tools.map((t) => t.name);
    expect(nomes).toHaveLength(26);
    expect(nomes).toContain('contato_planejar');
    expect(nomes).not.toContain('contato_executar'); // MCP_EFFECTS_ENABLED desligado por padrão

    // O cliente da V2 decifra o refresh offline que o servidor de autorização gravou e troca no IdP.
    for (const nome of ['resgata_quem_sou', 'bi_hoje', 'auditoria_minhas_acoes']) {
      const r = (await c.callTool({ name: nome, arguments: {} })) as Resultado;
      expect(r.isError, `${nome}: ${JSON.stringify(r.structuredContent)}`).toBeFalsy();
    }
    const minhas = (await c.callTool({ name: 'auditoria_minhas_acoes', arguments: {} })) as Resultado;
    expect(minhas.structuredContent).toMatchObject({ pagina: { itens: [{ ferramenta: 'bi_hoje' }] } });
    expect(s.v2.chamadas.length).toBeGreaterThan(0);
    expect(new Set(s.v2.chamadas.map((x) => x.sub))).toEqual(new Set(['demo-usuario-1']));

    const linhas = await linhasDeAuditoria(s, 4);
    expect(linhas.map((l) => l.tool)).toEqual([
      'resgata_quem_sou',
      'bi_hoje',
      'auditoria_minhas_acoes',
      'auditoria_minhas_acoes',
    ]);
    for (const l of linhas) {
      expect(l).toMatchObject({ outcome: 'ok', userSub: 'demo-usuario-1', grantId: a.grantId, clientId: CLAUDE_CODE });
    }

    const r = await token(s, { grant_type: 'refresh_token', refresh_token: a.refresh, client_id: CLAUDE_CODE });
    expect(r.status).toBe(200);
    expect(r.corpo.refresh_token).not.toBe(a.refresh);
    const c2 = await cliente(s, r.corpo.access_token ?? '');
    expect(((await c2.callTool({ name: 'bi_hoje', arguments: {} })) as Resultado).isError).toBeFalsy();
  });

  it('isolamento A × B: dois usuários em paralelo nunca usam o token um do outro', async () => {
    const s = await subir();
    s.idp.definirPapeis('demo-usuario-2', ['ADMIN', 'MCP_ACCESS', 'MCP_READ_BI', 'MCP_READ_CLIENTES']);
    const a = await conectar(s, 'demo-usuario-1');
    const b = await conectar(s, 'demo-usuario-2', CODEX);
    expect(s.v2.oauth.grants.get(b.grantId)?.scopes).toEqual(['resgata:read.bi', 'resgata:read.clientes']);

    const [ca, cb] = await Promise.all([cliente(s, a.acesso), cliente(s, b.acesso)]);
    expect((await cb.listTools()).tools.map((t) => t.name)).not.toContain('contato_planejar');

    const rodada = (c: Client) =>
      ['resgata_quem_sou', 'bi_hoje', 'cliente_dossie'].map((nome) =>
        c.callTool({ name: nome, arguments: nome === 'cliente_dossie' ? { userUuid: CLIENTE_1 } : {} }),
      );
    const resultados = (await Promise.all(
      Array.from({ length: 5 }, () => [...rodada(ca), ...rodada(cb)]).flat(),
    )) as Resultado[];
    expect(resultados.filter((r) => r.isError)).toEqual([]);

    // Cada linha de auditoria aponta a chamada da V2 com o mesmo request_id: o token usado é sempre o do dono do grant.
    const linhas = await linhasDeAuditoria(s, 30);
    expect(linhas).toHaveLength(30);
    const dono = new Map([
      [a.grantId, 'demo-usuario-1'],
      [b.grantId, 'demo-usuario-2'],
    ]);
    for (const l of linhas) {
      expect(dono.get(String(l.grantId))).toBe(l.userSub);
      const daV2 = s.v2.chamadas.filter((x) => x.cabecalhos['x-request-id'] === l.requestId);
      expect(daV2.length, String(l.tool)).toBeGreaterThan(0);
      for (const x of daV2) expect(x.sub).toBe(l.userSub);
    }
    expect(linhas.filter((l) => l.userSub === 'demo-usuario-1')).toHaveLength(15);

    // B não ganha o escopo de contato de A, nem forçando a chamada.
    const forcado = await fetch(`${s.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.acesso}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'contato_planejar', arguments: { userUuid: CLIENTE_1, modeloId: 'x' } },
      }),
    });
    expect(forcado.status).toBe(403);
  });

  it('renovação concorrente por dois processos: um ganha, o outro recebe invalid_grant e o grant segue vivo', async () => {
    const s = await subir();
    const a = await conectar(s, 'demo-usuario-1');
    const inicio = Date.now() + 1_500;
    const script = `(async () => {
      while (Date.now() < ${inicio}) {}
      const r = await fetch(process.env.E2E_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.E2E_REFRESH, client_id: process.env.E2E_CLIENT }),
      });
      console.log(JSON.stringify({ status: r.status, corpo: await r.json() }));
    })();`;
    const processo = () =>
      new Promise<{ status: number; corpo: Record<string, string> }>((ok, falha) => {
        const p = spawn(process.execPath, ['-e', script], {
          env: {
            PATH: process.env.PATH,
            E2E_URL: `${s.url}/oauth/token`,
            E2E_REFRESH: a.refresh,
            E2E_CLIENT: CLAUDE_CODE,
          },
        });
        let saida = '';
        p.stdout.on('data', (d) => {
          saida += d;
        });
        p.on('error', falha);
        p.on('close', () => ok(JSON.parse(saida)));
      });
    const respostas = await Promise.all([processo(), processo()]);
    expect(respostas.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(respostas.find((r) => r.status === 400)?.corpo.error).toBe('invalid_grant');
    expect(s.v2.oauth.grants.get(a.grantId)?.revogadoEm).toBeUndefined();

    const vencedor = respostas.find((r) => r.status === 200)?.corpo ?? {};
    const c = await cliente(s, vencedor.access_token ?? '');
    expect(((await c.callTool({ name: 'bi_hoje', arguments: {} })) as Resultado).isError).toBeFalsy();
    const depois = await token(s, {
      grant_type: 'refresh_token',
      refresh_token: vencedor.refresh_token ?? '',
      client_id: CLAUDE_CODE,
    });
    expect(depois.status).toBe(200);
  }, 20_000);
});
