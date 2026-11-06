// Conformidade MCP (P6): sobe o serviço em modo demo, conecta pelo fluxo OAuth completo (IdP falso) e expõe um
// repasse local que acrescenta o Bearer, porque o `conformance` não faz OAuth no modo servidor.
//
//   bun scripts/conformidade.ts            imprime a URL do repasse e fica no ar até Ctrl+C
//   npx @modelcontextprotocol/conformance@0.1.16 server --url <URL> --scenario <cenário>
//
// Fora do gate: o pacote traz dependências com faixa de versão (^) e não entra no lockfile.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CIMD, CLAUDE_CODE, Navegador, pkce, REDIRECT } from '../test/apoio-oauth.js';
import { carregarConfig } from '../src/config.js';
import { iniciar } from '../src/iniciar.js';
import { criarLog } from '../src/log.js';

const inst = await iniciar(carregarConfig({ MCP_MODO: 'demo', PORT: '0', LOG_LEVEL: 'warn' }), criarLog('warn'), {
  buscaCimd: async (u) => {
    const doc = CIMD[String(u)];
    return doc ? Response.json(doc) : new Response('', { status: 404 });
  },
});
const idp = inst.demo?.idp;
if (!idp) throw new Error('modo demo sem IdP falso');

const p = pkce();
const redirect = REDIRECT[CLAUDE_CODE] ?? '';
const q = new URLSearchParams({
  client_id: CLAUDE_CODE,
  redirect_uri: redirect,
  response_type: 'code',
  code_challenge: p.desafio,
  code_challenge_method: 'S256',
  scope: 'resgata:read.bi',
  state: 'conformidade',
  resource: `${inst.url}/mcp`,
});
const nav = new Navegador([inst.url, new URL(idp.issuer).origin]);
const html = (await nav.ir(`${inst.url}/oauth/authorize?${q}`)).html ?? '';
const fim = await nav.ir(`${inst.url}${/action="([^"]+)"/.exec(html)?.[1] ?? ''}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '', decisao: 'aprovar' }),
});
const t = (await (
  await fetch(`${inst.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: fim.saida?.searchParams.get('code') ?? '',
      code_verifier: p.verificador,
      client_id: CLAUDE_CODE,
      redirect_uri: redirect,
      resource: `${inst.url}/mcp`,
    }),
  })
).json()) as { access_token?: string };
if (!t.access_token) throw new Error('fluxo OAuth não devolveu token');

const destino = new URL(inst.url);
const repasse = http.createServer((req, res) => {
  const headers = { ...req.headers, authorization: `Bearer ${t.access_token}` };
  const r = http.request({ host: destino.hostname, port: destino.port, path: req.url, method: req.method, headers }, (x) => {
    res.writeHead(x.statusCode ?? 502, x.headers);
    x.pipe(res);
  });
  r.on('error', () => res.destroy());
  req.pipe(r);
});
await new Promise<void>((ok) => repasse.listen(0, '127.0.0.1', ok));
console.log(`http://127.0.0.1:${(repasse.address() as AddressInfo).port}/mcp`);
process.once('SIGINT', () => {
  repasse.close();
  void inst.fechar().then(() => process.exit(0));
});
