import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry } from 'prom-client';
import type { Config } from './config.js';
import { type IdpFalso, iniciarIdpFalso } from './demo/idp-falso.js';
import { iniciarV2Falsa, type V2Falsa } from './demo/v2-falsa.js';
import { FERRAMENTAS } from './ferramentas/index.js';
import { criarLimites } from './limites.js';
import { criarLog, type Registrador } from './log.js';
import { criarAuditoria } from './mcp/auditoria.js';
import { criarPortao } from './mcp/portao.js';
import { criarHandlerMcp } from './mcp/servidor-mcp.js';
import { criarArmazemV2 } from './oauth/armazem-v2.js';
import { criarIdp } from './oauth/keycloak.js';
import { criarServidorAutorizacao, type OpcoesServidorAutorizacao } from './oauth/provider.js';
import { criarApp, dependenciaHttp } from './servidor.js';
import { criarClienteV2 } from './v2/cliente.js';
import { criarCredencialServico, urlTokenKeycloak } from './v2/servico.js';

export const VERSAO = '0.0.0';

export type Instancia = {
  url: string;
  log: Registrador;
  /** Só em modo demo: a V2 e o IdP falsos, para os testes de ponta a ponta. */
  demo?: { v2: V2Falsa; idp: IdpFalso };
  fechar(): Promise<void>;
};

/**
 * Monta e sobe o serviço. Em modo demo sobe antes a V2 falsa e o IdP falso, só em 127.0.0.1.
 */
export async function iniciar(
  config: Config,
  log: Registrador = criarLog(config.logLevel),
  testes: Pick<OpcoesServidorAutorizacao, 'buscaCimd'> = {},
): Promise<Instancia> {
  const aoFechar: Array<() => Promise<void>> = [];
  // Escuta antes de montar: em demo com PORT=0 o emissor OAuth precisa da porta real.
  const servidor = http.createServer();
  await new Promise<void>((ok) => servidor.listen(config.porta, config.modo === 'demo' ? '127.0.0.1' : '0.0.0.0', ok));
  const { port } = servidor.address() as AddressInfo;
  const urlPublica = config.modo === 'demo' && config.porta === 0 ? `http://127.0.0.1:${port}` : config.urlPublica;
  const recurso = config.modo === 'demo' ? `${urlPublica}/mcp` : config.recurso;

  let v2BaseUrl = config.v2BaseUrl;
  let keycloak = config.keycloak;
  let demo: Instancia['demo'];
  if (config.modo === 'demo') {
    const v2 = await iniciarV2Falsa();
    const idp = await iniciarIdpFalso({ redirectMcp: `${urlPublica}/oauth/keycloak/callback` });
    demo = { v2, idp };
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
    ...testes,
  });
  const tokenUrl = urlTokenKeycloak(keycloak.issuer);
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
    provedores: config.provedores,
  });
  const portaoMcp = criarPortao({
    ferramentas: FERRAMENTAS,
    desligadas,
    efeitosLigados: config.efeitosLigados,
    v2,
    auditoria,
    log,
    chaveHmac: config.chaves.auditoriaHmac,
    urlPrm: `${urlPublica}/.well-known/oauth-protected-resource/mcp`,
  });
  const app = criarApp({
    urlPublica,
    recurso,
    hostsPermitidos: [new URL(urlPublica).hostname, ...(config.modo === 'demo' ? ['localhost', '127.0.0.1'] : [])],
    saltosProxy: config.saltosProxy,
    autorizacao,
    mcp,
    portaoMcp,
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
    demo,
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
