import { randomUUID } from 'node:crypto';
import { createMcpHandler, type McpHttpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Limites } from '../limites.js';
import { paramsAuditaveis, type Registrador } from '../log.js';
import { extraDoToken } from '../oauth/tipos.js';
import type { ClienteV2 } from '../v2/tipos.js';
import type { Ferramenta } from './ferramenta.js';

export type DependenciasMcp = {
  versao: string;
  ferramentas: readonly Ferramenta[];
  desligadas: ReadonlySet<string>;
  efeitosLigados: boolean;
  v2: ClienteV2;
  log: Registrador;
  limites: Limites;
  chaveHmac: Buffer;
};

/**
 * Handler MCP sem sessão: uma instância por requisição, só com as ferramentas que o grant permite.
 * Serve 2026-07-28 e, pelo modo legado sem estado do SDK, clientes 2025-11-25 (spike P1).
 */
export function criarHandlerMcp(d: DependenciasMcp): McpHttpHandler {
  return createMcpHandler(({ authInfo }) => {
    const servidor = new McpServer({ name: 'resgata-mcp', version: d.versao });
    const token = extraDoToken(authInfo?.extra);
    if (!authInfo || !token) return servidor;
    const escopos = new Set(authInfo.scopes);
    for (const f of d.ferramentas) {
      if (d.desligadas.has(f.nome) || (f.efeito && !d.efeitosLigados)) continue;
      if (!f.escopos.every((e) => escopos.has(e))) continue;
      servidor.registerTool(
        f.nome,
        {
          title: f.titulo,
          description: f.descricao,
          inputSchema: f.entrada,
          outputSchema: f.saida,
          annotations: f.anotacoes,
        },
        async (args: Record<string, unknown>) => {
          const requestId = randomUUID();
          const inicio = performance.now();
          let resultado = 'ok';
          try {
            const saida = await f.executar(args, {
              ...token,
              escopos,
              requestId,
              v2: d.v2,
              log: d.log,
              limites: d.limites,
              efeitosLigados: d.efeitosLigados,
            });
            return { content: [{ type: 'text', text: JSON.stringify(saida) }], structuredContent: saida };
          } catch (e) {
            resultado = 'error';
            throw e;
          } finally {
            d.log.info('mcp.tool_call', {
              request_id: requestId,
              grant_id: token.grantId,
              ferramenta: f.nome,
              resultado,
              latencia_ms: Math.round(performance.now() - inicio),
              params: paramsAuditaveis(args, f.paramsAuditaveis, d.chaveHmac),
            });
          }
        },
      );
    }
    return servidor;
  });
}
