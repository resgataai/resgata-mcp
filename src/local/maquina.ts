import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, openSync } from 'node:fs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as z from 'zod';
import type { Limites } from '../limites.js';
import type { Auditoria, LinhaAuditoria } from '../mcp/auditoria.js';
import { escoposDosPapeis, PAPEL_ACESSO } from '../mcp/escopos.js';
import type { Ferramenta } from '../mcp/ferramenta.js';
import type { TokenGrant } from '../v2/cliente.js';
import { pedirToken, urlTokenKeycloak } from '../v2/servico.js';
import type { ClienteV2 } from '../v2/tipos.js';
import { ErroV2 } from '../v2/tipos.js';

const chave = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const https = z.url().refine((v) => new URL(v).protocol === 'https:', 'exige HTTPS');
export const esquemaCredencialMaquina = z.strictObject({
  clientId: z.literal('resgata-mcp'),
  clientSecret: z.string().min(16),
  issuer: https,
  apiBase: https,
  subject: z.uuid(),
  keys: z.strictObject({ plano: chave, cursor: chave, auditoriaHmac: chave }),
});

/** O segredo entra só pela saída capturada do Keychain, nunca por argv ou env. */
export function carregarCredencialMaquina(item: string, conta: string) {
  try {
    const b64 = execFileSync('/usr/bin/security', ['find-generic-password', '-s', item, '-a', conta, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return esquemaCredencialMaquina.parse(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')));
  } catch {
    throw new Error('credencial da máquina ausente ou inválida no Keychain');
  }
}

/** Token próprio da máquina: o JWT retornado pelo IdP também é validado localmente. */
export function criarTokenMaquina(
  o: { issuer: string; clientId: string; clientSecret: string; subject: string },
  agora: () => number = Date.now,
): (() => Promise<TokenGrant>) & { invalidar(): void } {
  const jwks = createRemoteJWKSet(new URL(`${o.issuer}/protocol/openid-connect/certs`));
  let atual: TokenGrant | undefined;
  let emCurso: Promise<TokenGrant> | undefined;
  const renovar = async (): Promise<TokenGrant> => {
    const t = await pedirToken(
      urlTokenKeycloak(o.issuer),
      { id: o.clientId, segredo: o.clientSecret },
      { grant_type: 'client_credentials' },
    );
    try {
      const { payload } = await jwtVerify(t.access_token, jwks, {
        issuer: o.issuer,
        audience: 'resgata-api',
        algorithms: ['RS256', 'ES256'],
        currentDate: new Date(agora()),
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const realm = payload.realm_access as { roles?: unknown } | undefined;
      const roles = Array.isArray(realm?.roles) ? realm.roles.filter((r): r is string => typeof r === 'string') : [];
      if (payload.sub !== o.subject || payload.azp !== o.clientId || !roles.includes(PAPEL_ACESSO))
        throw new Error('principal');
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= agora()) throw new Error('exp');
      atual = {
        token: t.access_token,
        venceEm: Math.min(payload.exp * 1000, agora() + t.expires_in * 1000),
        escopos: new Set(escoposDosPapeis(roles)),
      };
      return atual;
    } catch {
      atual = undefined;
      throw new ErroV2('reautenticar', 'credencial de máquina revogada ou token inválido');
    }
  };
  const obter = () => {
    if (atual && atual.venceEm - 30_000 > agora()) return Promise.resolve(atual);
    emCurso ??= renovar().finally(() => {
      emCurso = undefined;
    });
    return emCurso;
  };
  return Object.assign(obter, {
    invalidar: () => {
      atual = undefined;
    },
  });
}

/** Append privado e sincronizado; nenhum efeito é iniciado sem a linha accepted persistida. */
export function criarAuditoriaLocal(caminho: string): Auditoria {
  const gravar = (linha?: LinhaAuditoria) => {
    const fd = openSync(
      caminho,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
        throw new Error('auditoria exige arquivo privado do usuário');
      if (linha) {
        appendFileSync(fd, `${JSON.stringify({ timestamp: new Date().toISOString(), ...linha })}\n`);
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
  };
  gravar();
  return { registrar: gravar, registrarAgora: async (l) => gravar(l), cheia: () => false, esvaziar: async () => {} };
}

/** Equivalente ao portão HTTP: cada chamada stdio revalida acesso e escopos. */
export function protegerFerramentasLocais(
  ferramentas: readonly Ferramenta[],
  v2: ClienteV2,
  limites: Limites,
): Ferramenta[] {
  return ferramentas.map((f) => ({
    ...f,
    async executar(args, ctx) {
      if (!limites.porGrant.consumir(ctx.grantId).ok)
        throw new ErroV2('ocupado', 'limite de consultas atingido', { tentarNovamenteEmS: 60 });
      const efetivos = await v2.escoposEfetivos(ctx.grantId);
      ctx.escopos = new Set([...ctx.escopos].filter((e) => efetivos.has(e)));
      if (!f.escopos.every((e) => ctx.escopos.has(e)))
        throw new ErroV2('insufficient_scope', 'permissão retirada desta conexão');
      return f.executar(args, ctx);
    },
  }));
}
