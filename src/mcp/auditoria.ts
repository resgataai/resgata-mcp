import type { Registrador } from '../log.js';
import type { CredencialServico } from '../v2/servico.js';
import { ErroV2 } from '../v2/tipos.js';

/** Corpo de `POST /v2/internal/mcp/audit/tool-calls` (contrato `mcp-audit-v1` do A2). */
export type LinhaAuditoria = {
  tool: string;
  outcome: 'ok' | 'denied' | 'error' | 'accepted' | 'replayed';
  userSub: string;
  grantId: string;
  clientId: string;
  requestId: string;
  targetType?: string;
  targetId?: string;
  planId?: string;
  idempotencyKeyHash?: string;
  /** Allowlist da ferramenta; dado pessoal só como HMAC. */
  params: Record<string, string | number | boolean>;
  paramsDigest: string;
  latencyMs: number;
  errorCode?: string;
};

export type Auditoria = {
  /** Assíncrona (fila em memória) e nunca descarta; falha de envio vira log `mcp.audit`, nunca derruba a resposta. */
  registrar(linha: LinhaAuditoria): void;
  /** Fila no limite: chamada nova é recusada com `ocupado` antes de executar (DESENHO §9: nenhuma linha some). */
  cheia(): boolean;
  /** Espera o `201`. Ferramenta com efeito chama antes do efeito: falhou, não executa. */
  registrarAgora(linha: LinhaAuditoria): Promise<void>;
  /** Esvazia a fila (testes e desligamento). */
  esvaziar(): Promise<void>;
};

const CAMINHO = '/v2/internal/mcp/audit/tool-calls';

/**
 * Uma linha por `tools/call`, inclusive negadas, pela credencial de serviço (`mcp:audit`). A capacidade limita a
 * admissão de chamadas novas (`cheia`), não a fila: a linha de uma chamada já admitida sempre entra.
 */
export function criarAuditoria(o: { servico: CredencialServico; log: Registrador; capacidade?: number }): Auditoria {
  const capacidade = o.capacidade ?? 1000;
  const fila: LinhaAuditoria[] = [];
  let trabalhando: Promise<void> | undefined;

  const enviar = (l: LinhaAuditoria) => o.servico.chamar('POST', CAMINHO, l, l.requestId);
  const falhou = (l: LinhaAuditoria, e: unknown) =>
    o.log.error('mcp.audit', {
      request_id: l.requestId,
      grant_id: l.grantId,
      ferramenta: l.tool,
      resultado: l.outcome,
      codigo: e instanceof ErroV2 ? e.codigo : 'erro',
    });

  const drenar = async () => {
    for (let l = fila.shift(); l; l = fila.shift()) {
      try {
        await enviar(l);
      } catch (e) {
        falhou(l, e);
      }
    }
    // Aqui, e não num .finally(): linha registrada entre o fim do laço e o .finally ficaria parada na fila.
    trabalhando = undefined;
  };

  return {
    registrar(l) {
      fila.push(l);
      trabalhando ??= drenar();
    },
    cheia: () => fila.length >= capacidade,
    async registrarAgora(l) {
      try {
        await enviar(l);
      } catch (e) {
        falhou(l, e);
        throw new ErroV2('tentar_novamente', 'auditoria indisponível; nada foi executado', { tentarNovamenteEmS: 30 });
      }
    },
    async esvaziar() {
      while (trabalhando) await trabalhando;
    },
  };
}
