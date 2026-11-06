import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Registrador } from '../log.js';
import { extraDoToken } from '../oauth/tipos.js';
import { type ClienteV2, ErroV2 } from '../v2/tipos.js';
import type { Auditoria } from './auditoria.js';
import type { Ferramenta } from './ferramenta.js';
import { linhaAuditoria, visivel } from './servidor-mcp.js';

type Opcoes = {
  ferramentas: readonly Ferramenta[];
  desligadas: ReadonlySet<string>;
  efeitosLigados: boolean;
  v2: ClienteV2;
  auditoria: Auditoria;
  log: Registrador;
  chaveHmac: Buffer;
  urlPrm: string;
};

type Mensagem = { method?: unknown; params?: { name?: unknown; arguments?: unknown } };

/**
 * Portão de `/mcp`, depois do Bearer e antes do SDK (DESENHO §5.2 passo 10 e §6.1):
 * - recalcula o escopo efetivo do grant (grant ∩ papéis do token novo da V2) e reduz `req.auth.scopes`, então
 *   `tools/list` some com a ferramenta do escopo perdido;
 * - grant revogado (inclusive agora, por papel `MCP_ACCESS` retirado) → 401 `invalid_token`;
 * - `tools/call` de ferramenta conhecida sem escopo → 403 `insufficient_scope` com os escopos necessários;
 * - toda chamada negada aqui gera linha de auditoria `denied`.
 * V2 ou IdP fora do ar: segue com os escopos do token; a ferramenta falha com erro acionável ao chamar a V2.
 */
export function criarPortao(o: Opcoes): RequestHandler {
  const porNome = new Map(o.ferramentas.map((f) => [f.nome, f]));
  const desafio = (erro: string, extra = '') => `Bearer error="${erro}"${extra}, resource_metadata="${o.urlPrm}"`;

  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth;
    const token = extraDoToken(auth?.extra);
    if (!auth || !token) return next();
    const mensagens = (Array.isArray(req.body) ? req.body : [req.body]) as Mensagem[];
    const chamadas = mensagens
      .filter((m) => m?.method === 'tools/call' && typeof m.params?.name === 'string')
      .map((m) => ({
        f: porNome.get(String(m.params?.name)),
        args: (m.params?.arguments ?? {}) as Record<string, unknown>,
      }))
      .filter((c): c is { f: Ferramenta; args: Record<string, unknown> } => c.f !== undefined);
    const negar = (f: Ferramenta, args: Record<string, unknown>, codigo: string) =>
      o.auditoria.registrar(
        linhaAuditoria(f, token, args, o.chaveHmac, {
          outcome: 'denied',
          requestId: randomUUID(),
          latencyMs: 0,
          errorCode: codigo,
        }),
      );

    let efetivos: ReadonlySet<string>;
    try {
      efetivos = await o.v2.escoposEfetivos(token.grantId);
    } catch (e) {
      if (e instanceof ErroV2 && e.codigo === 'reautenticar') {
        for (const c of chamadas) negar(c.f, c.args, 'reautenticar');
        res
          .status(401)
          .setHeader('www-authenticate', desafio('invalid_token', ', error_description="conexao revogada"'))
          .json({ error: 'invalid_token', error_description: e.message });
        return;
      }
      o.log.warn('portao.escopo_indisponivel', { grant_id: token.grantId, codigo: (e as ErroV2)?.codigo });
      efetivos = new Set(auth.scopes);
    }
    // Cópia: o verificador pode guardar o AuthInfo em cache; o escopo reduzido vale só para esta requisição.
    req.auth = { ...auth, scopes: auth.scopes.filter((s) => efetivos.has(s)) };
    const escopos = new Set(req.auth.scopes);

    for (const { f, args } of chamadas) {
      if (!f.escopos.every((e) => escopos.has(e))) {
        negar(f, args, 'insufficient_scope');
        res
          .status(403)
          .setHeader('www-authenticate', desafio('insufficient_scope', `, scope="${f.escopos.join(' ')}"`))
          .json({ error: 'insufficient_scope', error_description: `exige ${f.escopos.join(' ')}` });
        return;
      }
      // Desligada ou efeito desligado: não está registrada; o SDK responde "não encontrada" e a negação fica auditada.
      if (!visivel(f, escopos, o)) negar(f, args, 'ferramenta_desligada');
    }
    next();
  };
}
