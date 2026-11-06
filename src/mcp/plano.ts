import { createHash, randomUUID } from 'node:crypto';
import { CompactEncrypt, compactDecrypt } from 'jose';
import { ErroV2 } from '../v2/tipos.js';

/** Validade do plano do inc. 1 (DESENHO §7.3). */
export const PLANO_VALIDADE_S = 30 * 60;

export type ConteudoPlano = {
  sub: string;
  grantId: string;
  /** Ferramenta que pode executar o plano. */
  ferramenta: string;
  /** Argumentos canônicos do efeito (o que vai à V2) e o `dia` BRT da prévia, que só entra na chave. */
  args: Record<string, string>;
  repeticaoIntencional: boolean;
};

type Selado = ConteudoPlano & { jti: string; hash: string; exp: number };

const canonico = (args: Record<string, string>) =>
  JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
const hashArgs = (args: Record<string, string>) => createHash('sha256').update(canonico(args)).digest('base64url');

/** Plano JWE (`dir`/`A256GCM`, `MCP_PLAN_KEY`): cifrado e autenticado; preso a usuário, grant e ferramenta. */
export async function selarPlano(c: ConteudoPlano, chave: Buffer, agora: Date) {
  const exp = Math.floor(agora.getTime() / 1000) + PLANO_VALIDADE_S;
  const jti = randomUUID();
  const corpo: Selado = { ...c, jti, hash: hashArgs(c.args), exp };
  const planId = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(corpo)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', typ: 'resgata-plano+jwe' })
    .encrypt(chave);
  return { planId, jti, expiraEm: new Date(exp * 1000).toISOString() };
}

/** Abre e confere o plano. Outro usuário, outro grant, outra ferramenta, vencido ou adulterado → recusa. */
export async function abrirPlano(
  planId: string,
  chave: Buffer,
  esperado: { sub: string; grantId: string; ferramenta: string },
  agora: Date,
): Promise<Selado> {
  let corpo: Selado;
  try {
    const { plaintext } = await compactDecrypt(planId, chave, { contentEncryptionAlgorithms: ['A256GCM'] });
    corpo = JSON.parse(new TextDecoder().decode(plaintext)) as Selado;
  } catch {
    throw new ErroV2('invalido', 'plano inválido ou adulterado; gere outro com a prévia');
  }
  if (corpo.sub !== esperado.sub || corpo.grantId !== esperado.grantId || corpo.ferramenta !== esperado.ferramenta) {
    throw new ErroV2('invalido', 'este plano não pertence a esta conexão; gere outro com a prévia');
  }
  if (corpo.exp * 1000 <= agora.getTime()) throw new ErroV2('invalido', 'plano vencido; gere outro com a prévia');
  if (corpo.hash !== hashArgs(corpo.args)) throw new ErroV2('invalido', 'plano inválido; gere outro com a prévia');
  return corpo;
}

/**
 * `Idempotency-Key` derivada do CONTEÚDO, não do plano (DESENHO §7.3): o mesmo pedido no mesmo dia (outro plano,
 * outras palavras, turno reenviado, dois planos em paralelo) cai na mesma chave e a V2 devolve o replay por 24 h.
 * `dia` é o dia BRT da prévia, selado no plano: o mesmo plano executado depois da meia-noite mantém a chave.
 * `nonce` só com repetição intencional.
 */
export function chaveIdempotencia(p: {
  sub: string;
  ferramenta: string;
  userUuid: string;
  canal: string;
  templateId: string;
  dia: string;
  nonce?: string;
}): string {
  const partes = ['mcp:v1', p.sub, p.ferramenta, p.userUuid, p.canal, p.templateId, p.dia];
  if (p.nonce) partes.push(p.nonce);
  return createHash('sha256').update(partes.join('|')).digest('base64url');
}
