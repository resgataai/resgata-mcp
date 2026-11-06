import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ErroV2 } from '../v2/tipos.js';

export type Vinculo = { grantId: string; ferramenta: string; filtros: Record<string, unknown> };

const vinculo = (v: Vinculo) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        v.grantId,
        v.ferramenta,
        Object.entries(v.filtros)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest('base64url')
    .slice(0, 22);
const assinar = (chave: Buffer, corpo: string) => createHmac('sha256', chave).update(corpo).digest('base64url');

/** Cursor opaco: posição da V2 assinada (HMAC, `MCP_CURSOR_KEY`) e presa a grant, ferramenta e filtros. */
export function selarCursor(posicao: string | number, chave: Buffer, v: Vinculo): string {
  const corpo = Buffer.from(JSON.stringify({ p: posicao, v: vinculo(v) })).toString('base64url');
  return `${corpo}.${assinar(chave, corpo)}`;
}

export function abrirCursor(cursor: string, chave: Buffer, v: Vinculo): string | number {
  const [corpo = '', assinatura = ''] = cursor.split('.');
  const esperado = Buffer.from(assinar(chave, corpo));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) {
    throw new ErroV2('invalido', 'cursor inválido; refaça a consulta sem cursor');
  }
  const { p, v: preso } = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as {
    p: string | number;
    v: string;
  };
  if (preso !== vinculo(v)) throw new ErroV2('invalido', 'cursor de outra consulta; refaça sem cursor');
  return p;
}
