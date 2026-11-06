import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { Router } from 'express';
import type { ServidorAutorizacao } from './tipos.js';

/**
 * Lugar do servidor de autorização até o P3 entrar: recusa todo token e responde 501 em `/oauth/*`.
 * Mantém o contrato de `/mcp` (401 com `resource_metadata`) e os metadados do recurso funcionando.
 */
export function servidorAutorizacaoPendente(): ServidorAutorizacao {
  const rotas = Router();
  rotas.all(['/oauth', '/oauth/*caminho', '/.well-known/oauth-authorization-server'], (_req, res) => {
    res
      .status(501)
      .json({ error: 'temporarily_unavailable', error_description: 'servidor de autorização em construção' });
  });
  return {
    rotas,
    verificador: {
      verifyAccessToken: async () => {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'servidor de autorização em construção');
      },
    },
    pronto: () => true,
    fechar: async () => {},
  };
}
