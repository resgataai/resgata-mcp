import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM do refresh offline do IdP (`MCP_UPSTREAM_KEY`). Formato: iv (12) ‖ tag (16) ‖ texto cifrado.
 * A AAD prende o texto ao dono: `uid` da interação no callback, `grant_id` depois do consentimento.
 * O P4 decifra o do grant com `decifrar(chave, cifra, grantId)`.
 */
export function cifrar(chave: Buffer, texto: string, aad: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave, iv).setAAD(Buffer.from(aad));
  const corpo = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), corpo]);
}

/** Lança se a chave, a AAD ou o texto não baterem. */
export function decifrar(chave: Buffer, cifra: Buffer, aad: string): string {
  const d = createDecipheriv('aes-256-gcm', chave, cifra.subarray(0, 12)).setAAD(Buffer.from(aad));
  d.setAuthTag(cifra.subarray(12, 28));
  return Buffer.concat([d.update(cifra.subarray(28)), d.final()]).toString('utf8');
}
