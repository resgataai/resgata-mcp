import type http from 'node:http';
import { decodeJwt } from 'jose';

/**
 * Armazém OAuth falso, em memória, com o mesmo contrato das rotas `/v2/internal/mcp/oauth/**` da V2
 * (envelope `{ success, data }`, 404 para ausente ou vencido, consumo atômico com 409, grant revogado não volta).
 * Só aceita a credencial de serviço com o escopo `mcp:oauth-store`, como a cadeia de segurança da V2.
 */
type Linha = {
  payload: Record<string, unknown>;
  grantId?: string;
  uid?: string;
  upstream?: string;
  expira: number;
  consumido?: number;
};
export type GrantFalso = {
  userSub: string;
  userEmail?: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  expira: number;
  upstream?: string;
  revogadoEm?: number;
  motivo?: string;
  ultimoUso?: number;
};

export type ArmazemOauthFalso = {
  artefatos: Map<string, Linha>;
  grants: Map<string, GrantFalso>;
  /** Simula o "Desconectar" do painel (ou um gancho de bloqueio de usuário). */
  revogarComoPainel(grantId: string, motivo?: string): void;
  tratar(req: http.IncomingMessage, res: http.ServerResponse, caminho: string): Promise<void>;
};

const DIAS_90 = 90 * 86_400_000 + 300_000;

export function criarArmazemOauthFalso(agora: () => number = Date.now): ArmazemOauthFalso {
  const artefatos = new Map<string, Linha>();
  const grants = new Map<string, GrantFalso>();
  const iso = (t?: number) => (t === undefined ? null : new Date(t).toISOString());
  const status = (g: GrantFalso) => (g.revogadoEm ? 'revoked' : g.expira <= agora() ? 'expired' : 'active');
  const vivo = (chave: string) => {
    const l = artefatos.get(chave);
    return l && l.expira > agora() ? l : undefined;
  };
  const apagarDoGrant = (grantId: string) => {
    for (const [k, l] of artefatos) if (l.grantId === grantId) artefatos.delete(k);
  };
  const revogar = (grantId: string, motivo: string) => {
    const g = grants.get(grantId);
    if (g && !g.revogadoEm) Object.assign(g, { revogadoEm: agora(), motivo });
    apagarDoGrant(grantId);
    return g;
  };

  async function tratar(req: http.IncomingMessage, res: http.ServerResponse, caminho: string): Promise<void> {
    const responder = (s: number, data?: unknown) => {
      res.writeHead(s, data === undefined ? {} : { 'content-type': 'application/json' });
      res.end(data === undefined ? undefined : JSON.stringify({ success: s < 400, data }));
    };
    let escopos: string[] = [];
    try {
      escopos = String(decodeJwt((req.headers.authorization ?? '').slice(7)).scope ?? '').split(' ');
    } catch {}
    if (!escopos.includes('mcp:oauth-store')) return responder(403);
    let texto = '';
    for await (const parte of req) texto += parte;
    const corpo = (texto ? JSON.parse(texto) : {}) as Record<string, unknown>;
    const p = caminho.split('/').filter(Boolean);
    const [a, b, c, d] = p;
    const m = req.method;

    if (a === 'artifacts' && b === 'by-grant' && d === 'revoke' && m === 'POST') {
      revogar(c ?? '', String(corpo.reason));
      return responder(204);
    }
    if (a === 'artifacts' && b === 'Interaction' && d === 'upstream-revoked' && m === 'POST') {
      artefatos.delete(`Interaction/${c}`);
      return responder(204);
    }
    if (a === 'artifacts' && b && c) {
      const chave = `${b}/${c}`;
      if (d === 'consume' && m === 'POST') {
        const l = vivo(chave);
        if (!l) return responder(404);
        if (l.consumido !== undefined) return responder(409);
        l.consumido = agora();
        return responder(200, { consumedAt: iso(l.consumido) });
      }
      if (m === 'PUT') {
        const anterior = artefatos.get(chave);
        artefatos.set(chave, {
          payload: corpo.payload as Record<string, unknown>,
          grantId: corpo.grantId as string | undefined,
          uid: corpo.uid as string | undefined,
          upstream: corpo.upstreamCiphertext as string | undefined,
          expira: Date.parse(String(corpo.expiresAt)),
          consumido: anterior?.consumido,
        });
        return responder(204);
      }
      if (m === 'GET') {
        const l = vivo(chave);
        if (!l) return responder(404);
        return responder(200, {
          payload: l.payload,
          consumedAt: iso(l.consumido),
          expiresAt: iso(l.expira),
          upstreamCiphertext: l.upstream ?? null,
        });
      }
      if (m === 'DELETE') {
        artefatos.delete(chave);
        return responder(204);
      }
    }
    if (a === 'grants' && b === 'upstream-pending' && m === 'GET') {
      const itens = [
        ...[...grants]
          .filter(([, g]) => g.upstream && status(g) !== 'active')
          .map(([id, g]) => ({ kind: 'grant', id, upstreamCiphertext: g.upstream, aad: id })),
        ...[...artefatos]
          .filter(([k, l]) => k.startsWith('Interaction/') && l.upstream && l.expira <= agora())
          .map(([k, l]) => ({ kind: 'interaction', id: k.slice(12), upstreamCiphertext: l.upstream, aad: l.uid })),
      ];
      return responder(200, itens);
    }
    if (a === 'grants' && b) {
      const g = grants.get(b);
      if (!c && m === 'PUT') {
        const expira = Date.parse(String(corpo.expiresAt));
        if (!(expira > agora() && expira <= agora() + DIAS_90)) return responder(400);
        if (g && (g.revogadoEm || g.userSub !== corpo.userSub)) return responder(409);
        grants.set(b, {
          userSub: String(corpo.userSub),
          userEmail: corpo.userEmail as string | undefined,
          clientId: String(corpo.clientId),
          clientName: String(corpo.clientName),
          scopes: corpo.scopes as string[],
          expira,
          upstream: corpo.upstreamCiphertext as string | undefined,
        });
        return responder(204);
      }
      if (!g) return responder(404);
      if (!c && m === 'GET') {
        const s = status(g);
        return responder(200, {
          status: s,
          userSub: g.userSub,
          clientId: g.clientId,
          scopes: g.scopes,
          expiresAt: iso(g.expira),
          upstreamCiphertext: s === 'active' ? (g.upstream ?? null) : null,
        });
      }
      if (c === 'touch' && m === 'POST') {
        g.ultimoUso = agora();
        return responder(204);
      }
      if (c === 'revoke' && m === 'POST') {
        revogar(b, String(corpo.reason));
        return responder(204);
      }
      if (c === 'upstream-revoked' && m === 'POST') {
        if (status(g) === 'active') return responder(409);
        g.upstream = undefined;
        return responder(204);
      }
    }
    return responder(404);
  }

  return {
    artefatos,
    grants,
    revogarComoPainel: (grantId, motivo = 'user') => {
      revogar(grantId, motivo);
    },
    tratar,
  };
}
