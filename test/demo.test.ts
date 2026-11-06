import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { iniciarIdpFalso } from '../src/demo/idp-falso.js';
import { iniciarV2Falsa } from '../src/demo/v2-falsa.js';

const fechar: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechar.splice(0)) await f();
});

describe('V2 falsa', () => {
  it('responde operações do manifesto, recusa as de fora e exige Bearer', async () => {
    const v2 = await iniciarV2Falsa();
    fechar.push(v2.fechar);
    const h = { authorization: 'Bearer x' };
    expect((await fetch(`${v2.url}/v2/auth/me`)).status).toBe(401);
    expect((await fetch(`${v2.url}/v2/auth/me`, { headers: h })).status).toBe(200);
    expect((await fetch(`${v2.url}/v2/admin/panel-users`, { headers: h })).status).toBe(404);
    expect((await fetch(`${v2.url}/v2/admin/audiences/a1`, { headers: h })).status).toBe(200);
    expect(v2.chamadas.map((c) => c.operacao)).toEqual(['me', 'adminAudiencesDetail']);
  });

  it('imita a idempotência da V2: replay, corpo divergente e concorrência → 1 envio', async () => {
    const v2 = await iniciarV2Falsa();
    fechar.push(v2.fechar);
    let envios = 0;
    v2.definir('adminIndividualSend', async () => {
      envios += 1;
      await new Promise((ok) => setTimeout(ok, 50));
      return { status: 202, corpo: { testId: `t${envios}` } };
    });
    const enviar = (chave: string | undefined, corpo: unknown) =>
      fetch(`${v2.url}/v2/admin/individual-sends`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer x',
          'content-type': 'application/json',
          ...(chave ? { 'idempotency-key': chave } : {}),
        },
        body: JSON.stringify(corpo),
      });
    const corpo = { userUuid: 'u1', channel: 'EMAIL', templateId: 'm1' };
    expect((await enviar(undefined, corpo)).status).toBe(400);
    const [a, b] = await Promise.all([enviar('k1', corpo), enviar('k1', corpo)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const replay = await enviar('k1', corpo);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toMatchObject({ success: true, data: { testId: 't1' } });
    const outro = await enviar('k1', { ...corpo, templateId: 'm2' });
    expect(outro.status).toBe(409);
    expect(await outro.json()).toMatchObject({ causeId: 'idempotency_key_reused' });
    expect(envios).toBe(1);
  });
});

type Tokens = { access_token: string; refresh_token: string; scope: string };

describe('IdP falso', () => {
  const pkce = () => {
    const verificador = randomBytes(32).toString('base64url');
    return { verificador, desafio: createHash('sha256').update(verificador).digest('base64url') };
  };

  it('code + PKCE → tokens com papéis; refresh reflete papel retirado; client_credentials', async () => {
    const redirect = 'http://127.0.0.1:1/oauth/keycloak/callback';
    const idp = await iniciarIdpFalso({ redirectMcp: redirect });
    fechar.push(idp.fechar);
    const meta = (await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json()) as Record<
      string,
      string
    >;
    const { verificador, desafio } = pkce();
    const auth = new URL(meta.authorization_endpoint ?? '');
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: idp.clientes.mcp.clientId,
      redirect_uri: redirect,
      code_challenge: desafio,
      code_challenge_method: 'S256',
      scope: 'openid offline_access',
      state: 's1',
      nonce: 'n1',
    }))
      auth.searchParams.set(k, v);
    const loc = new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location') ?? '');
    expect(loc.searchParams.get('state')).toBe('s1');
    const code = loc.searchParams.get('code') ?? '';
    const basic = `Basic ${Buffer.from(`${idp.clientes.mcp.clientId}:${idp.clientes.mcp.segredo}`).toString('base64')}`;
    const token = (form: Record<string, string>) =>
      fetch(meta.token_endpoint ?? '', {
        method: 'POST',
        headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
    const errado = await token({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: 'x' });
    expect(errado.status).toBe(400);

    // o código foi consumido pela tentativa errada: novo fluxo
    const p2 = pkce();
    auth.searchParams.set('code_challenge', p2.desafio);
    const code2 =
      new URL((await fetch(auth, { redirect: 'manual' })).headers.get('location') ?? '').searchParams.get('code') ?? '';
    const t = (await (
      await token({
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: redirect,
        code_verifier: p2.verificador,
      })
    ).json()) as Tokens;
    const papeis = (jwt: string) =>
      JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString()).realm_access.roles as string[];
    expect(papeis(t.access_token)).toContain('MCP_CONTACT');

    idp.definirPapeis('demo-usuario-1', ['ADMIN', 'MCP_ACCESS']);
    const r = (await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json()) as Tokens;
    expect(papeis(r.access_token)).not.toContain('MCP_CONTACT');
    // refresh offline reaproveitável (revokeRefreshToken=false), até o usuário ser desativado
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).status).toBe(200);
    const u = idp.usuarios.get('demo-usuario-1');
    if (u) u.ativo = false;
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).status).toBe(400);

    const svc = await fetch(meta.token_endpoint ?? '', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: idp.clientes.svc.clientId,
        client_secret: idp.clientes.svc.segredo,
        scope: 'mcp:audit',
      }),
    });
    expect(((await svc.json()) as Tokens).scope).toBe('mcp:audit');
    expect(verificador).not.toBe(p2.verificador);
  });
});
