import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.js';
import { iniciarIdpFalso } from './demo/idp-falso.js';
import { iniciarV2Falsa } from './demo/v2-falsa.js';
import { FERRAMENTAS } from './ferramentas/index.js';
import { criarLimites } from './limites.js';
import { criarLog, type Registrador } from './log.js';
import { criarAuditoria } from './mcp/auditoria.js';
import { criarPortao } from './mcp/portao.js';
import { criarHandlerMcp } from './mcp/servidor-mcp.js';
import { servidorAutorizacaoPendente } from './oauth/pendente.js';
import { criarApp, dependenciaHttp } from './servidor.js';
import { criarClienteV2 } from './v2/cliente.js';
import { criarCredencialServico, urlTokenKeycloak } from './v2/servico.js';

export const VERSAO = '0.0.0';

export type Instancia = { url: string; log: Registrador; fechar(): Promise<void> };

/**
 * Monta e sobe o serviço. Em modo demo sobe antes a V2 falsa e o IdP falso, só em 127.0.0.1.
 * P3 troca `servidorAutorizacaoPendente` aqui.
 */
export async function iniciar(config: Config, log: Registrador = criarLog(config.logLevel)): Promise<Instancia> {
  const aoFechar: Array<() => Promise<void>> = [];
  let v2BaseUrl = config.v2BaseUrl;
  let keycloak = config.keycloak;

  if (config.modo === 'demo') {
    const v2 = await iniciarV2Falsa();
    const idp = await iniciarIdpFalso({ redirectMcp: `${config.urlPublica}/oauth/keycloak/callback` });
    aoFechar.push(v2.fechar, idp.fechar);
    v2BaseUrl = v2.url;
    keycloak = {
      issuer: idp.issuer,
      clientId: idp.clientes.mcp.clientId,
      clientSecret: idp.clientes.mcp.segredo,
      svcClientId: idp.clientes.svc.clientId,
      svcClientSecret: idp.clientes.svc.segredo,
    };
  }
  if (!v2BaseUrl || !keycloak) throw new Error('V2 e IdP precisam estar definidos');
  const issuer = keycloak.issuer;

  const limites = criarLimites();
  const tokenUrl = urlTokenKeycloak(issuer);
  const servico = criarCredencialServico({
    baseUrl: v2BaseUrl,
    tokenUrl,
    clientId: keycloak.svcClientId,
    clientSecret: keycloak.svcClientSecret,
  });
  const v2 = criarClienteV2({
    baseUrl: v2BaseUrl,
    idp: { tokenUrl, clientId: keycloak.clientId, clientSecret: keycloak.clientSecret },
    servico,
    chaveUpstream: config.chaves.upstream,
    limites,
    log,
  });
  const auditoria = criarAuditoria({ servico, log });
  aoFechar.unshift(auditoria.esvaziar);
  const desligadas = new Set(config.ferramentasDesligadas);
  const autorizacao = servidorAutorizacaoPendente();
  const mcp = criarHandlerMcp({
    versao: VERSAO,
    ferramentas: FERRAMENTAS,
    desligadas,
    efeitosLigados: config.efeitosLigados,
    transcricoesLigadas: config.transcricoesLigadas,
    v2,
    auditoria,
    log,
    limites,
    chaves: { plano: config.chaves.plano, cursor: config.chaves.cursor, auditoriaHmac: config.chaves.auditoriaHmac },
  });
  const portaoMcp = criarPortao({
    ferramentas: FERRAMENTAS,
    desligadas,
    efeitosLigados: config.efeitosLigados,
    v2,
    auditoria,
    log,
    chaveHmac: config.chaves.auditoriaHmac,
    urlPrm: `${config.urlPublica}/.well-known/oauth-protected-resource/mcp`,
  });
  const app = criarApp({
    urlPublica: config.urlPublica,
    recurso: config.recurso,
    saltosProxy: config.saltosProxy,
    autorizacao,
    mcp,
    portaoMcp,
    limites,
    log,
    dependencias: [
      dependenciaHttp('v2', `${v2BaseUrl}/v2/health/ready`),
      dependenciaHttp('idp', `${issuer}/.well-known/openid-configuration`),
    ],
    chavesCarregadas: config.chaves.jwks.keys.length > 0 && config.chaves.cookieKeys.length > 0,
  });

  const servidor: Server = await new Promise((ok) => {
    const s = app.listen(config.porta, config.modo === 'demo' ? '127.0.0.1' : '0.0.0.0', () => ok(s));
  });
  const { port } = servidor.address() as AddressInfo;
  log.info('servidor.pronto', { modo: config.modo, porta: port });

  return {
    url: `http://127.0.0.1:${port}`,
    log,
    fechar: async () => {
      await new Promise<void>((ok) => {
        servidor.closeAllConnections();
        servidor.close(() => ok());
      });
      await mcp.close();
      await autorizacao.fechar();
      for (const f of aoFechar) await f();
    },
  };
}
