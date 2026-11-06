import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM do refresh offline do Keycloak (DESENHO §5.2 passos 6 e 8). Formato: `iv(12) || cifrado || tag(16)`;
 * a AAD prende o texto ao dono (`uid` da interação ou `grant_id`). A V2 guarda os bytes; no JSON vão em base64.
 * O servidor de autorização (P3) cifra; o cliente da V2 (P4) decifra. Os dois usam só este módulo.
 */
export function cifrar(texto: string, chave: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const corpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, corpo, c.getAuthTag()]);
}

/** Lança se a chave, a AAD ou os bytes não baterem (GCM autentica tudo). */
export function decifrar(dados: Buffer, chave: Buffer, aad: string): string {
  if (dados.length < 29) throw new Error('texto cifrado curto demais');
  const d = createDecipheriv('aes-256-gcm', chave, dados.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(dados.subarray(dados.length - 16));
  return Buffer.concat([d.update(dados.subarray(12, dados.length - 16)), d.final()]).toString('utf8');
}
