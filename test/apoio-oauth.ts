// Apoio dos testes de OAuth: documentos CIMD dos três clientes (servidos sem rede) e um navegador mínimo.
import { createHash, randomBytes } from 'node:crypto';

export const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
export const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CODEX = 'https://chatgpt.com/oauth/codex/client.json';
// Documentos públicos dos clientes (como publicados em 06/11/2026), servidos sem rede.
export const CIMD: Record<string, Record<string, unknown>> = {
  [CLAUDE_CODE]: {
    client_id: CLAUDE_CODE,
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  [CLAUDE]: {
    client_id: CLAUDE,
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    jwks_uri: 'https://claude.ai/jwks',
    sector_identifier_uri: 'https://claude.ai/sector',
    logo_uri: 'https://claude.ai/logo.png',
  },
  [CODEX]: {
    client_id: CODEX,
    application_type: 'native',
    redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
    token_endpoint_auth_method: 'none',
    token_endpoint_auth_methods_supported: ['none'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Codex',
  },
};
export const REDIRECT: Record<string, string> = {
  [CLAUDE_CODE]: 'http://localhost:53682/callback',
  [CLAUDE]: 'https://claude.ai/api/mcp/auth_callback',
  [CODEX]: 'http://127.0.0.1:53683/callback',
};

/** Navegador mínimo: segue redirects, guarda cookies por caminho e para ao sair para o retorno do cliente. */
export class Navegador {
  readonly cookies = new Map<string, { valor: string; caminho: string }>();
  readonly visitados: string[] = [];
  constructor(readonly origens: string[]) {}

  async ir(destino: string, init: RequestInit = {}): Promise<{ status: number; html?: string; saida?: URL }> {
    let url = new URL(destino);
    let pedido = init;
    for (let i = 0; i < 20; i++) {
      this.visitados.push(url.href);
      const r = await fetch(url, {
        ...pedido,
        redirect: 'manual',
        headers: { ...pedido.headers, cookie: this.para(url) },
      });
      for (const c of r.headers.getSetCookie()) this.guardar(c);
      const loc = r.headers.get('location');
      if (!loc || r.status < 300 || r.status >= 400) return { status: r.status, html: await r.text() };
      url = new URL(loc, url);
      if (!this.origens.includes(url.origin)) return { status: r.status, saida: url };
      pedido = {};
    }
    throw new Error('redirects demais');
  }

  private para(url: URL): string {
    if (url.origin !== this.origens[0]) return '';
    return [...this.cookies]
      .filter(([, c]) => url.pathname === c.caminho || url.pathname.startsWith(c.caminho.replace(/\/?$/, '/')))
      .map(([k, c]) => `${k.split('|')[0]}=${c.valor}`)
      .join('; ');
  }

  private guardar(linha: string): void {
    const [par = '', ...attrs] = linha.split(';').map((s) => s.trim());
    const i = par.indexOf('=');
    const nome = par.slice(0, i);
    const caminho = attrs.find((a) => /^path=/i.test(a))?.slice(5) ?? '/';
    const apagar = attrs.some((a) => /^max-age=0$/i.test(a) || /^expires=thu, 01 jan 1970/i.test(a));
    if (apagar) this.cookies.delete(`${nome}|${caminho}`);
    else this.cookies.set(`${nome}|${caminho}`, { valor: par.slice(i + 1), caminho });
  }
}

export const pkce = () => {
  const verificador = randomBytes(32).toString('base64url');
  return { verificador, desafio: createHash('sha256').update(verificador).digest('base64url') };
};
