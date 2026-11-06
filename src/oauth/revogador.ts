import type { Registrador } from '../log.js';
import type { ArmazemV2 } from './armazem-v2.js';
import { decifrar } from './cifra.js';
import type { Idp } from './keycloak.js';

/**
 * Varredor: revoga no IdP o refresh offline de grants revogados ou vencidos e de interações abandonadas, e só então
 * pede à V2 para apagar o texto cifrado. Idempotente (as duas réplicas podem varrer o mesmo item).
 */
export function criarRevogador(o: { armazem: ArmazemV2; idp: Idp; chave: Buffer; log: Registrador }) {
  return async function varrer(): Promise<number> {
    let feitos = 0;
    for (const item of await o.armazem.pendentesUpstream(50)) {
      try {
        await o.idp.revogar(decifrar(o.chave, Buffer.from(item.upstreamCiphertext, 'base64'), item.aad));
        if (item.kind === 'grant') await o.armazem.grantUpstreamRevogado(item.id);
        else await o.armazem.interacaoUpstreamRevogada(item.id);
        feitos += 1;
      } catch (e) {
        // Chave trocada ou IdP fora: o item continua pendente e volta na próxima varredura.
        o.log.warn('oauth.upstream_falha', { motivo: item.kind, codigo: (e as Error).name });
      }
    }
    if (feitos) o.log.info('oauth.upstream_revogado', { quantidade: feitos });
    return feitos;
  };
}
