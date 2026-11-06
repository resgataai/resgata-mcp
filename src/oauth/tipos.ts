import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Router } from 'express';

/**
 * Contrato entre o esqueleto (P2) e o servidor de autorização (P3, `src/oauth/`).
 *
 * O `verificador` devolve um `AuthInfo` cujo `extra` segue `ExtraDoToken`: é dali que o servidor MCP
 * tira `sub` e `grant_id` para limites, auditoria e escopo das ferramentas.
 */
export interface ServidorAutorizacao {
  /** Montado na raiz: `/.well-known/oauth-authorization-server`, `/oauth/*` e telas de interação. */
  rotas: Router;
  /** Valida o Bearer de `/mcp`: assinatura, `iss`, `aud`, `exp` e estado do grant na V2. */
  verificador: OAuthTokenVerifier;
  /** Chaves carregadas e rotas montadas (entra no `/readyz`). */
  pronto(): boolean;
  fechar(): Promise<void>;
}

export type ExtraDoToken = {
  sub: string;
  grantId: string;
  /** URL do CIMD do cliente de IA. */
  clientId: string;
};

export function extraDoToken(extra: Record<string, unknown> | undefined): ExtraDoToken | undefined {
  const sub = extra?.sub;
  const grantId = extra?.grantId;
  const clientId = extra?.clientId;
  if (typeof sub !== 'string' || typeof grantId !== 'string' || typeof clientId !== 'string') return undefined;
  return { sub, grantId, clientId };
}
