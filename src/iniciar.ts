import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry } from 'prom-client';
import type { Config } from './config.js';
import { iniciarIdpFalso } from './demo/idp-falso.js';
import { iniciarV2Falsa } from './demo/v2-falsa.js';
import { FERRAMENTAS } from './ferramentas/index.js';
import { criarLimites } from './limites.js';
import { criarLog, type Registrador } from './log.js';
import { criarHandlerMcp } from './mcp/servidor-mcp.js';
import { criarArmazemV2 } from './oauth/armazem-v2.js';
import { criarIdp } from './oauth/keycloak.js';
import { criarServidorAutorizacao } from './oauth/provider.js';
import { criarApp, dependenciaHttp } from './servidor.js';
import { clienteV2Pendente } from './v2/pendente.js';

export const VERSAO = '0.0.0';

export type Instancia = { url: string; log: Registrador; fechar(): Promise<void> };

/**
 * Monta e sobe o serviço. Em modo demo sobe antes a V2 falsa e o IdP falso, só em 127.0.0.1.
 * P4 troca `clienteV2Pendente` aqui.
 */
export async function iniciar(config: Config, log: Registrador = criarLog(config.logLevel)): Promise<Instancia> {
  const aoFechar: Array<() => Promise<void>> = [];
  // Escuta antes de montar: em demo com PORT=0 o emissor OAuth precisa da porta real.
  const servidor = http.createServer();
  await new Promise<void>((ok) => servidor.listen(config.porta, config.modo === 'demo' ? '127.0.0.1' : '0.0.0.0', ok));
  const { port } = servidor.address() as AddressInfo;
  const urlPublica = config.modo === 'demo' && config.porta === 0 ? `http://127.0.0.1:${port}` : config.urlPublica;
  const recurso = config.modo === 'demo' ? `${urlPublica}/mcp` : config.recurso;

  let v2BaseUrl = config.v2BaseUrl;
  let keycloak = config.keycloak;
  if (config.modo === 'demo') {
    const v2 = await iniciarV2Falsa();
    const idp = await iniciarIdpFalso({ redirectMcp: `${urlPublica}/oauth/keycloak/callback` });
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

  const registro = new Registry();
  const limites = criarLimites();
  const idp = criarIdp({ ...keycloak, redirectUri: `${urlPublica}/oauth/keycloak/callback` });
  const autorizacao = criarServidorAutorizacao({
    urlPublica,
    recurso,
    jwks: config.chaves.jwks,
    cookieKeys: config.chaves.cookieKeys,
    chaveUpstream: config.chaves.upstream,
    idp,
    armazem: criarArmazemV2({ baseUrl: v2BaseUrl, token: idp.tokenServico }),
    log,
    registro,
    sondarCimd: config.modo === 'producao',
  });
  const mcp = criarHandlerMcp({
    versao: VERSAO,
    ferramentas: FERRAMENTAS,
    desligadas: new Set(config.ferramentasDesligadas),
    efeitosLigados: config.efeitosLigados,
    v2: clienteV2Pendente(),
    log,
    limites,
    chaveHmac: config.chaves.auditoriaHmac,
  });
  const app = criarApp({
    urlPublica,
    recurso,
    saltosProxy: config.saltosProxy,
    autorizacao,
    mcp,
    limites,
    log,
    registro,
    dependencias: [
      dependenciaHttp('v2', `${v2BaseUrl}/v2/health/ready`),
      dependenciaHttp('idp', `${keycloak.issuer}/.well-known/openid-configuration`),
    ],
    chavesCarregadas: config.chaves.jwks.keys.length > 0 && config.chaves.cookieKeys.length > 0,
  });
  servidor.on('request', app);
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
