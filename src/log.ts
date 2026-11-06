import { createHmac } from 'node:crypto';
import pino from 'pino';

/**
 * Log técnico por lista positiva. Só estes campos saem; o resto é descartado.
 * Parâmetros de ferramenta entram só pela allowlist da ferramenta (`paramsAuditaveis`).
 */
const CAMPOS_PERMITIDOS = new Set([
  'evento',
  'request_id',
  'grant_id',
  'client_id',
  'ferramenta',
  'operacao',
  'resultado',
  'codigo',
  'status',
  'metodo',
  'rota',
  'latencia_ms',
  'params',
  'modo',
  'porta',
  'dependencia',
  'motivo',
  'quantidade',
]);

/** Segunda barreira: chaves que nunca aparecem, mesmo que alguém as ponha na lista positiva por engano. */
const CHAVES_REDIGIDAS = [
  'authorization',
  'code',
  'code_verifier',
  'refresh_token',
  'access_token',
  'id_token',
  'client_secret',
  'cookie',
  'texto',
  'cpf',
  'telefone',
  'email',
];

const CPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;
const EMAIL = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/g;
const TELEFONE = /\+?\d{2}\s?\(?\d{2}\)?\s?9?\d{4}-?\d{4}/g;

/** Terceira barreira, para texto que escapou das outras duas. */
export function mascararTexto(texto: string): string {
  return texto.replace(CPF, '[cpf]').replace(EMAIL, '[email]').replace(TELEFONE, '[telefone]');
}

export type Tratamento = 'claro' | 'hmac';
export type AllowlistParams = Readonly<Record<string, Tratamento>>;

/** Filtra os argumentos de uma ferramenta pela allowlist; `hmac` vira digest truncado (correlaciona sem expor). */
export function paramsAuditaveis(
  args: Record<string, unknown>,
  allowlist: AllowlistParams,
  chaveHmac: Buffer,
): Record<string, string | number | boolean> {
  const saida: Record<string, string | number | boolean> = {};
  for (const [campo, tratamento] of Object.entries(allowlist)) {
    const valor = args[campo];
    if (valor === undefined || valor === null) continue;
    if (tratamento === 'hmac') {
      saida[campo] = `hmac:${createHmac('sha256', chaveHmac).update(String(valor)).digest('base64url').slice(0, 22)}`;
    } else if (typeof valor === 'number' || typeof valor === 'boolean') {
      saida[campo] = valor;
    } else {
      saida[campo] = mascararTexto(String(valor)).slice(0, 200);
    }
  }
  return saida;
}

function filtrar(campos: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(campos)) {
    if (!CAMPOS_PERMITIDOS.has(k) || v === undefined) continue;
    saida[k] = typeof v === 'string' ? mascararTexto(v).slice(0, 500) : v;
  }
  return saida;
}

export type Registrador = {
  info(evento: string, campos?: Record<string, unknown>): void;
  warn(evento: string, campos?: Record<string, unknown>): void;
  error(evento: string, campos?: Record<string, unknown>): void;
  debug(evento: string, campos?: Record<string, unknown>): void;
};

export function criarLog(nivel: string, destino?: pino.DestinationStream): Registrador {
  const base = pino(
    {
      level: nivel,
      base: undefined,
      messageKey: 'evento',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ nivel: label }) },
      redact: { paths: [...CHAVES_REDIGIDAS, ...CHAVES_REDIGIDAS.map((c) => `*.${c}`)], censor: '[redigido]' },
    },
    destino,
  );
  const emitir =
    (n: 'info' | 'warn' | 'error' | 'debug') =>
    (evento: string, campos: Record<string, unknown> = {}) =>
      base[n](filtrar(campos), evento);
  return { info: emitir('info'), warn: emitir('warn'), error: emitir('error'), debug: emitir('debug') };
}
