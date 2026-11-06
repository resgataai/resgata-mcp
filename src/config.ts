import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as z from 'zod';

/** Host público de produção. Em modo demo o processo recusa se apresentar com ele. */
export const HOST_PRODUCAO = 'https://mcp.resgata.ai';

/** Variáveis que só existem em produção: em modo demo, a presença de qualquer uma impede a subida. */
const VARIAVEIS_DE_PRODUCAO = [
  'V2_API_BASE_URL',
  'KEYCLOAK_ISSUER',
  'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_CLIENT_SECRET',
  'KEYCLOAK_SVC_CLIENT_ID',
  'KEYCLOAK_SVC_CLIENT_SECRET',
] as const;

const chave32 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'precisa ser 32 bytes em base64url (43 caracteres, sem padding)')
  .transform((v) => Buffer.from(v, 'base64url'));

const jwks = z
  .string()
  .transform((v, ctx) => {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'não é JSON' });
      return z.NEVER;
    }
  })
  .pipe(
    z.object({
      keys: z
        .array(
          z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), d: z.string(), kid: z.string().min(1) }).loose(),
        )
        .min(1),
    }),
  );

const lista = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const booleano = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const urlHttps = z.url({ protocol: /^https$/ }).transform((v) => v.replace(/\/+$/, ''));

const comum = {
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MCP_EFFECTS_ENABLED: booleano,
  MCP_DISABLED_TOOLS: lista,
  // Saltos de proxy confiáveis para req.ip (X-Forwarded-For); o manifest de produção define o valor da borda.
  MCP_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
};

const esquemaProducao = z.object({
  ...comum,
  MCP_MODO: z.literal('producao'),
  MCP_PUBLIC_URL: urlHttps,
  MCP_RESOURCE: urlHttps,
  V2_API_BASE_URL: z.url({ protocol: /^https?$/ }).transform((v) => v.replace(/\/+$/, '')),
  KEYCLOAK_ISSUER: urlHttps,
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(16),
  KEYCLOAK_SVC_CLIENT_ID: z.string().min(1),
  KEYCLOAK_SVC_CLIENT_SECRET: z.string().min(16),
  MCP_JWKS: jwks,
  MCP_COOKIE_KEYS: lista.pipe(z.array(z.string().min(32)).min(1)),
  MCP_UPSTREAM_KEY: chave32,
  MCP_PLAN_KEY: chave32,
  MCP_CURSOR_KEY: chave32,
  MCP_AUDIT_HMAC_KEY: chave32,
});

const esquemaDemo = z.object({
  ...comum,
  MCP_MODO: z.literal('demo'),
  MCP_PUBLIC_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .transform((v) => v?.replace(/\/+$/, '')),
});

export type ChavesServico = {
  jwks: { keys: Array<Record<string, unknown>> };
  cookieKeys: string[];
  upstream: Buffer;
  plano: Buffer;
  cursor: Buffer;
  auditoriaHmac: Buffer;
};

export type Config = {
  modo: 'producao' | 'demo';
  porta: number;
  logLevel: z.infer<typeof comum.LOG_LEVEL>;
  urlPublica: string;
  recurso: string;
  efeitosLigados: boolean;
  ferramentasDesligadas: string[];
  saltosProxy: number;
  /** Ausente em modo demo: o processo sobe a V2 falsa e preenche depois. */
  v2BaseUrl?: string;
  keycloak?: { issuer: string; clientId: string; clientSecret: string; svcClientId: string; svcClientSecret: string };
  chaves: ChavesServico;
};

export class ErroDeConfiguracao extends Error {
  override name = 'ErroDeConfiguracao';
}

/** Mensagens só com nomes de variáveis e regras; nunca valores. */
function falhas(erro: z.ZodError): string {
  return erro.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
}

/** Chaves efêmeras para o modo demo (nada persiste entre execuções). */
function chavesEfemeras(): ChavesServico {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'demo', alg: 'ES256', use: 'sig' }] },
    cookieKeys: [randomBytes(32).toString('base64url')],
    upstream: randomBytes(32),
    plano: randomBytes(32),
    cursor: randomBytes(32),
    auditoriaHmac: randomBytes(32),
  };
}

export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modo = env.MCP_MODO ?? 'producao';
  if (modo === 'demo') {
    const presentes = VARIAVEIS_DE_PRODUCAO.filter((n) => env[n] !== undefined && env[n] !== '');
    if (presentes.length > 0) {
      throw new ErroDeConfiguracao(`modo demo recusa variáveis de produção: ${presentes.join(', ')}`);
    }
    const r = esquemaDemo.safeParse(env);
    if (!r.success) throw new ErroDeConfiguracao(`configuração inválida: ${falhas(r.error)}`);
    const urlPublica = r.data.MCP_PUBLIC_URL ?? `http://localhost:${r.data.PORT}`;
    if (new URL(urlPublica).origin === HOST_PRODUCAO) {
      throw new ErroDeConfiguracao('modo demo recusa MCP_PUBLIC_URL de produção');
    }
    return {
      modo: 'demo',
      porta: r.data.PORT,
      logLevel: r.data.LOG_LEVEL,
      urlPublica,
      recurso: `${urlPublica}/mcp`,
      efeitosLigados: r.data.MCP_EFFECTS_ENABLED,
      ferramentasDesligadas: r.data.MCP_DISABLED_TOOLS,
      saltosProxy: r.data.MCP_TRUST_PROXY_HOPS,
      chaves: chavesEfemeras(),
    };
  }
  if (modo !== 'producao') throw new ErroDeConfiguracao('MCP_MODO precisa ser producao ou demo');

  const r = esquemaProducao.safeParse({ ...env, MCP_MODO: 'producao' });
  if (!r.success) throw new ErroDeConfiguracao(`configuração inválida: ${falhas(r.error)}`);
  const d = r.data;
  if (d.MCP_RESOURCE !== `${d.MCP_PUBLIC_URL}/mcp`) {
    throw new ErroDeConfiguracao('MCP_RESOURCE precisa ser MCP_PUBLIC_URL + /mcp');
  }
  return {
    modo: 'producao',
    porta: d.PORT,
    logLevel: d.LOG_LEVEL,
    urlPublica: d.MCP_PUBLIC_URL,
    recurso: d.MCP_RESOURCE,
    efeitosLigados: d.MCP_EFFECTS_ENABLED,
    ferramentasDesligadas: d.MCP_DISABLED_TOOLS,
    saltosProxy: d.MCP_TRUST_PROXY_HOPS,
    v2BaseUrl: d.V2_API_BASE_URL,
    keycloak: {
      issuer: d.KEYCLOAK_ISSUER,
      clientId: d.KEYCLOAK_CLIENT_ID,
      clientSecret: d.KEYCLOAK_CLIENT_SECRET,
      svcClientId: d.KEYCLOAK_SVC_CLIENT_ID,
      svcClientSecret: d.KEYCLOAK_SVC_CLIENT_SECRET,
    },
    chaves: {
      jwks: d.MCP_JWKS,
      cookieKeys: d.MCP_COOKIE_KEYS,
      upstream: d.MCP_UPSTREAM_KEY,
      plano: d.MCP_PLAN_KEY,
      cursor: d.MCP_CURSOR_KEY,
      auditoriaHmac: d.MCP_AUDIT_HMAC_KEY,
    },
  };
}
