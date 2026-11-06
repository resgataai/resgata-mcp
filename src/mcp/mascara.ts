/**
 * Máscara de dados pessoais na saída das ferramentas (DESENHO §7.2). Sem `resgata:pii` (não concedido no inc. 1),
 * CPF, telefone, e-mail e CEP saem mascarados nos campos e também dentro de qualquer texto livre.
 */

const so = (v: string) => v.replace(/\D/g, '');

export function mascararCpf(v: string | null | undefined): string | null {
  const d = so(v ?? '');
  return d.length === 11 ? `***.***.*${d.slice(7, 9)}-${d.slice(9)}` : v ? '***' : null;
}

export function mascararTelefone(v: string | null | undefined): string | null {
  const d = so(v ?? '');
  return d.length >= 8 ? `(**) *****-${d.slice(-4)}` : v ? '***' : null;
}

export function mascararEmail(v: string | null | undefined): string | null {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec((v ?? '').trim());
  if (!m) return v ? '***' : null;
  const [local, dominio] = [m[1] ?? '', m[2] ?? ''];
  const tld = dominio.includes('.') ? dominio.slice(dominio.lastIndexOf('.')) : '';
  return `${local.slice(0, 1)}***@${dominio.slice(0, 1)}***${tld}`;
}

// Fronteiras: não morder pedaços de UUID, ids ou números maiores (lookbehind/lookahead de letra, dígito e hífen).
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_CPF = /(?<![\w-])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\w-]|\.\d)/g;
const RE_TELEFONE = /(?<![\w-])(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?![\w-]|\.\d)/g;
const RE_CEP = /(?<![\w.-])\d{5}-\d{3}(?![\w-])|\bCEP:?\s*\d{5}-?\d{3}\b/gi;

/** Máscara por regex em texto livre (mensagens, motivos, notas, resumos). */
export function mascararTextoLivre(texto: string): string {
  return texto
    .replace(RE_EMAIL, (m) => mascararEmail(m) ?? '***')
    .replace(RE_CPF, (m) => mascararCpf(m) ?? '***')
    .replace(RE_TELEFONE, (m) => mascararTelefone(m) ?? '***')
    .replace(RE_CEP, '*****-***');
}

/** Campos que nunca carregam dado pessoal e não podem ser alterados (o cursor e o plano são opacos). */
const CHAVES_INTACTAS = new Set(['request_id', 'proximo_cursor', 'plan_id', 'url']);

/** Aplica a máscara em todas as strings de um objeto, menos nas chaves opacas. */
export function mascararProfundo<T>(valor: T, chave?: string): T {
  if (typeof valor === 'string') return (chave && CHAVES_INTACTAS.has(chave) ? valor : mascararTextoLivre(valor)) as T;
  if (Array.isArray(valor)) return valor.map((v) => mascararProfundo(v)) as T;
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, mascararProfundo(v, k)])) as T;
  }
  return valor;
}

// Controle (menos \n e \t) e formatação invisível (zero-width, bidi), que escondem instruções em texto de terceiros.
const INVISIVEIS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Texto de origem externa (cliente, provedor, UTM, nomes): sem invisíveis, tamanho limitado, nunca `undefined`. */
export function textoExterno(v: unknown, maximo = 500): string | null {
  if (v === null || v === undefined) return null;
  const limpo = String(v)
    .replace(INVISIVEIS, (c) => (c === '\n' || c === '\t' ? c : ''))
    .trim();
  return limpo.length > maximo ? `${limpo.slice(0, maximo - 1)}…` : limpo;
}
