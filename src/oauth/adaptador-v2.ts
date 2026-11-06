import { createHash } from 'node:crypto';
import Provider, { errors, type Payload } from 'oidc-provider';
import { type ArmazemV2, MODELOS } from './armazem-v2.js';

/** O id de um artefato OAuth é o próprio token (código, refresh): na V2 só entra o SHA-256. */
export const hashId = (id: string) => createHash('sha256').update(id).digest('base64url');

export type OpcoesAdaptador = {
  armazem: ArmazemV2;
  agora: () => number;
  /** Refresh consumido há menos que isso some (`invalid_grant` sem revogar); depois disso o reuso revoga o grant. */
  janelaReusoMs: number;
  aoReusoDetectado: (grantId: string) => void;
};

/**
 * Adaptador do `oidc-provider` sobre o armazém da V2 (sem estado no pod).
 * - `jti` sai do payload antes de gravar e volta no `find`;
 * - `Session` não persiste: toda autorização começa sem sessão e passa pelo IdP (DESENHO §5.2 passo 4); modelos fora do
 *   armazém (`Client`, de clientes estáticos, que não existem: só CIMD) também não;
 * - o refresh offline cifrado de uma `Interaction` vai na coluna própria (`upstreamCiphertext`), nunca no payload;
 * - `revokeByGrantId` chega uma vez por modelo e vira uma chamada à V2 por grant, com o motivo pelo contexto.
 */
export function classeAdaptador(o: OpcoesAdaptador) {
  const revogacoes = new Map<string, Promise<void>>();

  return class AdaptadorV2 {
    readonly #modelo: string;
    readonly #nulo: boolean;

    constructor(modelo: string) {
      this.#modelo = modelo;
      this.#nulo = modelo === 'Session' || !MODELOS.has(modelo);
    }

    async upsert(id: string, payload: Payload, expiresIn: number): Promise<void> {
      if (this.#nulo) return;
      const { jti: _jti, ...resto } = payload;
      let upstream: string | undefined;
      const idp = (resto.result as { idp?: { upstream?: string } } | undefined)?.idp;
      if (this.#modelo === 'Interaction' && idp?.upstream) {
        upstream = idp.upstream;
        resto.result = { ...(resto.result as object), idp: { ...idp, upstream: undefined } };
      }
      await o.armazem.gravarArtefato(this.#modelo, hashId(id), {
        payload: resto,
        grantId: this.#modelo === 'Grant' ? id : texto(payload.grantId),
        uid: this.#modelo === 'Interaction' ? id : texto(payload.uid),
        userSub: texto(payload.accountId),
        clientId: texto(payload.clientId),
        upstreamCiphertext: upstream,
        expiresAt: new Date(o.agora() + expiresIn * 1000).toISOString(),
      });
    }

    async find(id: string): Promise<Payload | undefined> {
      if (this.#nulo) return undefined;
      const a = await o.armazem.lerArtefato(this.#modelo, hashId(id));
      if (!a) return undefined;
      const payload: Payload = { ...a.payload, jti: id };
      if (a.consumedAt) {
        const consumido = Date.parse(a.consumedAt);
        // Duas sessões que renovam juntas: a segunda recebe invalid_grant e o grant segue vivo (DESENHO §5.2 passo 11).
        if (this.#modelo === 'RefreshToken' && o.agora() - consumido < o.janelaReusoMs) return undefined;
        payload.consumed = Math.floor(consumido / 1000);
      }
      if (this.#modelo === 'Interaction' && a.upstreamCiphertext) {
        const result = (payload.result ?? {}) as { idp?: object };
        payload.result = { ...result, idp: { ...result.idp, upstream: a.upstreamCiphertext } };
      }
      return payload;
    }

    async findByUid(): Promise<undefined> {}

    async findByUserCode(): Promise<undefined> {}

    async consume(id: string): Promise<void> {
      if (this.#nulo) return;
      // Corrida de dois consumidores: a V2 deixa só um passar; o outro vê invalid_grant, sem revogar.
      if ((await o.armazem.consumir(this.#modelo, hashId(id))) !== 'ok') throw new errors.InvalidGrant('já usado');
    }

    async destroy(id: string): Promise<void> {
      if (this.#nulo) return;
      await o.armazem.apagarArtefato(this.#modelo, hashId(id));
    }

    revokeByGrantId(grantId: string): Promise<void> {
      if (this.#nulo) return Promise.resolve();
      let p = revogacoes.get(grantId);
      if (!p) {
        // Em /oauth/revoke é o cliente; no /oauth/token é reuso de credencial já consumida (refresh fora da janela ou código).
        const motivo = Provider.ctx?.oidc?.route === 'revocation' ? 'client_revoked' : 'refresh_reuse';
        if (motivo === 'refresh_reuse') o.aoReusoDetectado(grantId);
        p = o.armazem.revogarPorGrant(grantId, motivo).finally(() => revogacoes.delete(grantId));
        revogacoes.set(grantId, p);
      }
      return p;
    }
  };
}

const texto = (v: unknown) => (typeof v === 'string' ? v : undefined);
