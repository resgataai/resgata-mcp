import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, Router } from 'express';
import type Provider from 'oidc-provider';
import type { Interaction } from 'oidc-provider';
import type { Registrador } from '../log.js';
import { ESCOPOS, escoposDosPapeis, PAPEL_ACESSO } from '../mcp/escopos.js';
import { hashId } from './adaptador-v2.js';
import type { ArmazemV2 } from './armazem-v2.js';
import { cifrar, decifrar } from './cifra.js';
import { ehLoopback, nomeDoCliente } from './cimd.js';
import { CABECALHOS_TELA, paginaAviso, paginaConsentimento } from './consentimento.js';
import type { Idp } from './keycloak.js';

/** D3: grant de 90 dias no máximo (o refresh, de 30 dias, cobre o limite ocioso). */
export const VIDA_GRANT_S = 90 * 86_400;
const UID = /^[A-Za-z0-9_-]{10,64}$/;
const ESCOPO_MCP: ReadonlySet<string> = new Set(ESCOPOS);
const aleatorio = () => randomBytes(32).toString('base64url');
const igual = (a: unknown, b: unknown) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Estado da interação entre o IdP e o consentimento (vai em `interaction.result`, que a conclusão sobrescreve). */
type Kc = { state: string; nonce: string };
type IdpConfirmado = {
  sub: string;
  email?: string;
  papeis: string[];
  /** Refresh offline cifrado, base64 (AAD = uid); o adaptador grava na coluna própria da V2. */
  upstream: string;
  csrf: string;
  authTime: number;
};
type Resultado = { kc?: Kc; idp?: IdpConfirmado };

export type DependenciasInteracao = {
  provider: Provider;
  idp: Idp;
  armazem: ArmazemV2;
  chaveUpstream: Buffer;
  recurso: string;
  redirectIdp: string;
  seguro: boolean;
  log: Registrador;
  evento: (nome: string, campos?: Record<string, unknown>) => void;
  agora: () => number;
};

/**
 * Login no IdP e consentimento, numa interação só: o IdP é sempre chamado (`max_age=300`), a tela de consentimento
 * aparece sempre, e só a aprovação conclui `login` + `consent` juntos. Com a `Session` sem persistência, nenhuma
 * autorização pula esses passos (DESENHO §5.2 passos 4 a 8).
 */
export function rotasInteracao(d: DependenciasInteracao): Router {
  const r = Router();
  const cookieKc = (uid: string) => `mcp_kc_${uid}`;
  const salvar = (i: Interaction) => i.save(Math.max(1, i.exp - Math.floor(d.agora() / 1000)));
  const tela = (res: Response, status: number, html: string) => {
    res.status(status).set(CABECALHOS_TELA).type('html').send(html);
  };
  const aviso = (res: Response, status: number, titulo: string, msg: string, link?: { href: string; texto: string }) =>
    tela(res, status, paginaAviso(titulo, msg, link));
  const expirou = (res: Response) =>
    aviso(res, 400, 'Sessão expirada', 'Volte ao aplicativo e clique em Conectar de novo.');

  /** Melhor esforço: depois que a interação é concluída, o varredor não alcança mais esse refresh. */
  async function revogarOffline(refresh: string): Promise<void> {
    try {
      await d.idp.revogar(refresh);
    } catch (e) {
      // shortcut: falha aqui deixa a sessão offline viver até vencer no IdP (30 d ociosa); fila de reprocesso se aparecer no log
      d.log.warn('oauth.upstream_falha', { codigo: (e as Error).name });
    }
  }

  async function detalhes(req: Request, res: Response): Promise<Interaction | undefined> {
    try {
      const det = await d.provider.interactionDetails(req, res);
      return det.uid === req.params.uid ? det : undefined;
    } catch {
      return undefined;
    }
  }

  r.get('/interacao/:uid', async (req, res, next) => {
    try {
      const det = await detalhes(req, res);
      if (!det) return expirou(res);
      const idp = (det.result as Resultado | undefined)?.idp;
      if (idp) {
        const redirect = det.params.redirect_uri ?? '';
        const pedidos = new Set((det.params.scope ?? '').split(' '));
        return tela(
          res,
          200,
          paginaConsentimento({
            uid: det.uid,
            csrf: idp.csrf,
            aplicativo: nomeDoCliente(det.params.client_id ?? '') ?? 'Aplicativo',
            hostRetorno: URL.parse(redirect)?.host ?? '',
            loopback: ehLoopback(redirect),
            email: idp.email,
            escopos: escoposDosPapeis(idp.papeis).filter((e) => pedidos.has(e)),
          }),
        );
      }
      const kc: Kc = { state: `${det.uid}.${aleatorio()}`, nonce: aleatorio() };
      const verificador = aleatorio();
      const destino = await d.idp.urlDeLogin({ ...kc, verificador });
      det.result = { kc } satisfies Resultado;
      await salvar(det);
      // O verificador PKCE fica só no navegador que começou: um link de callback repassado a outra pessoa não troca o código.
      res.cookie(cookieKc(det.uid), verificador, {
        httpOnly: true,
        sameSite: 'lax',
        secure: d.seguro,
        path: '/oauth/keycloak/callback',
        maxAge: 600_000,
      });
      res.redirect(303, destino.href);
    } catch (e) {
      next(e);
    }
  });

  r.get('/oauth/keycloak/callback', async (req, res, next) => {
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const uid = state.split('.')[0] ?? '';
      if (!UID.test(uid)) return expirou(res);
      const det = await d.provider.Interaction.find(uid);
      const kc = (det?.result as Resultado | undefined)?.kc;
      if (!det || !kc || !igual(kc.state, state)) return expirou(res);
      const verificador = lerCookie(req, cookieKc(uid));
      res.clearCookie(cookieKc(uid), { path: '/oauth/keycloak/callback' });
      det.result = {}; // uso único: o mesmo state não serve de novo, nem se a troca abaixo falhar
      await salvar(det);
      if (!verificador) return expirou(res);
      if (req.query.error !== undefined) {
        return concluirComErro(res, det, 'login cancelado no provedor de identidade');
      }

      let login: Awaited<ReturnType<Idp['trocarCodigo']>>;
      try {
        login = await d.idp.trocarCodigo(new URL(`${d.redirectIdp}${new URL(req.originalUrl, 'http://x').search}`), {
          ...kc,
          verificador,
        });
      } catch {
        d.evento('login_falhou');
        return aviso(res, 400, 'Login não confirmado', 'Não foi possível confirmar o login. Tente conectar de novo.');
      }
      if (!login.refresh) {
        d.evento('sem_offline');
        return aviso(res, 502, 'Login incompleto', 'O provedor de identidade não liberou o acesso offline ao MCP.');
      }
      if (!login.papeis.includes(PAPEL_ACESSO)) {
        await revogarOffline(login.refresh);
        d.evento('negado_sem_acesso');
        det.result = { error: 'access_denied', error_description: 'conta sem acesso ao MCP' };
        await salvar(det);
        return aviso(
          res,
          403,
          'Sem acesso ao MCP',
          'Sua conta não tem acesso ao MCP da Resgata.ai. Peça a liberação a quem administra o painel.',
          { href: det.returnTo, texto: 'Voltar ao aplicativo' },
        );
      }
      det.result = {
        idp: {
          sub: login.sub,
          email: login.email,
          papeis: login.papeis.filter((p) => p.startsWith('MCP_')),
          upstream: cifrar(d.chaveUpstream, login.refresh, uid).toString('base64'),
          csrf: aleatorio(),
          authTime: login.authTime,
        },
      } satisfies Resultado;
      await salvar(det);
      res.redirect(303, `/interacao/${uid}`);
    } catch (e) {
      next(e);
    }
  });

  async function concluirComErro(res: Response, det: Interaction, descricao: string) {
    det.result = { error: 'access_denied', error_description: descricao };
    await salvar(det);
    res.redirect(303, det.returnTo);
  }

  r.post('/interacao/:uid/decisao', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res, next) => {
    try {
      const det = await detalhes(req, res);
      const idp = (det?.result as Resultado | undefined)?.idp;
      if (!det || !idp) return expirou(res);
      const corpo = (req.body ?? {}) as Record<string, unknown>;
      if (!igual(corpo.csrf, idp.csrf))
        return aviso(res, 403, 'Pedido inválido', 'Recarregue a página e tente de novo.');

      // Uma decisão por interação, mesmo com dois cliques ou duas réplicas: o consumo na V2 é atômico.
      if ((await d.armazem.consumir('Interaction', hashId(det.uid))) !== 'ok') return expirou(res);

      const clientId = det.params.client_id ?? '';
      const pedidos = (det.params.scope ?? '').split(' ').filter(Boolean);
      const efetivos = escoposDosPapeis(idp.papeis).filter((e) => pedidos.includes(e));
      const liberado: ReadonlySet<string> = new Set(efetivos);
      if (corpo.decisao !== 'aprovar' || efetivos.length === 0) {
        await revogarOffline(decifrar(d.chaveUpstream, Buffer.from(idp.upstream, 'base64'), det.uid));
        d.evento('recusado', { client_id: clientId });
        return d.provider.interactionFinished(
          req,
          res,
          { error: 'access_denied', error_description: 'autorização recusada' },
          { mergeWithLastSubmission: false },
        );
      }

      // Escopo efetivo = pedido ∩ papéis MCP_*; o resto é recusado explicitamente para o provider não pedir de novo.
      const grant = new d.provider.Grant({ accountId: idp.sub, clientId });
      const oidc = pedidos.filter((s) => s === 'openid' || liberado.has(s));
      const recusadosOidc = pedidos.filter((s) => !oidc.includes(s));
      if (oidc.length) grant.addOIDCScope(oidc.join(' '));
      if (recusadosOidc.length) grant.rejectOIDCScope(recusadosOidc.join(' '));
      grant.addResourceScope(d.recurso, efetivos.join(' '));
      const recusados = pedidos.filter((s) => ESCOPO_MCP.has(s) && !liberado.has(s));
      if (recusados.length) grant.rejectResourceScope(d.recurso, recusados.join(' '));
      const grantId = await grant.save();

      const offline = decifrar(d.chaveUpstream, Buffer.from(idp.upstream, 'base64'), det.uid);
      await d.armazem.gravarGrant(grantId, {
        userSub: idp.sub,
        userEmail: idp.email,
        clientId,
        clientName: nomeDoCliente(clientId) ?? 'Aplicativo',
        scopes: efetivos,
        expiresAt: new Date(d.agora() + VIDA_GRANT_S * 1000).toISOString(),
        upstreamCiphertext: cifrar(d.chaveUpstream, offline, grantId).toString('base64'),
      });
      d.evento('grant_criado', { grant_id: grantId, client_id: clientId });
      // O resultado novo substitui o anterior: o refresh cifrado com AAD = uid sai da interação aqui.
      await d.provider.interactionFinished(
        req,
        res,
        { login: { accountId: idp.sub, ts: idp.authTime, remember: false }, consent: { grantId } },
        { mergeWithLastSubmission: false },
      );
    } catch (e) {
      next(e);
    }
  });

  return r;
}

function lerCookie(req: Request, nome: string): string | undefined {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return undefined;
}
