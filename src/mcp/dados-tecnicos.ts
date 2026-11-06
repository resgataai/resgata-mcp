import { ErroV2 } from '../v2/tipos.js';
import { textoExterno } from './mascara.js';

const CHAVE_SECRETA =
  /authorization|cookie|password|passwd|secret|apikey|privatekey|credential|signature|token$|^(?:auth|pwd|pass|sig)$/i;
const SEGREDO_EM_TEXTO =
  /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|password|passwd|pwd|authorization|cookie|token|secret|signature|credential|auth|pass|sig)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi;

/** Segunda barreira sobre a resposta já sanitizada pela API; não resume o conteúdo. */
export function sanitizarTecnico(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 20) throw new ErroV2('invalido', 'resposta técnica profunda demais para exibir com segurança');
  if (typeof valor === 'string') {
    if (/^\s*[[{]/.test(valor)) {
      try {
        return JSON.stringify(sanitizarTecnico(JSON.parse(valor), profundidade + 1));
      } catch (e) {
        if (e instanceof ErroV2) throw e;
      }
    }
    const limpo = textoExterno(valor, valor.length + 1) ?? '';
    return limpo
      .replace(/https?:\/\/[^\s"'<>]+/gi, (trecho) => {
        try {
          const u = new URL(trecho);
          u.username = '';
          u.password = '';
          for (const k of [...u.searchParams.keys()])
            if (CHAVE_SECRETA.test(k.replace(/[^a-z0-9]/gi, ''))) u.searchParams.set(k, '[credencial removida]');
          return u.href;
        } catch {
          return '[URL inválida removida]';
        }
      })
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[credencial removida]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[credencial removida]')
      .replace(SEGREDO_EM_TEXTO, '$1[credencial removida]');
  }
  if (Array.isArray(valor)) return valor.map((v) => sanitizarTecnico(v, profundidade + 1));
  if (valor && typeof valor === 'object')
    return Object.fromEntries(
      Object.entries(valor).map(([k, v]) => [
        k,
        CHAVE_SECRETA.test(k.replace(/[^a-z0-9]/gi, ''))
          ? '[credencial removida]'
          : sanitizarTecnico(v, profundidade + 1),
      ]),
    );
  return valor ?? null;
}

/** Endpoint útil ao diagnóstico, sem userinfo, querystring ou fragmento. */
export function endpointTecnico(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  try {
    const u = new URL(valor);
    return `${u.origin}${u.pathname}`;
  } catch {
    return valor.split(/[?#]/)[0] ?? null;
  }
}
