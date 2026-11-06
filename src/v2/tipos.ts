/**
 * Contrato entre as ferramentas (P5) e o cliente da V2 (P4, `src/v2/cliente.ts`).
 *
 * O cliente resolve a operação pelo manifesto (`contrato/operacoes-v2.json`), valida e codifica os parâmetros de
 * caminho, obtém o token da V2 do grant, propaga `X-Request-Id`/`traceparent` e mapeia ProblemDetails para `ErroV2`.
 */
export type PedidoV2 = {
  /** operationId do manifesto; operação fora dele é recusada antes de sair do processo. */
  operacao: string;
  caminho?: Record<string, string | number>;
  consulta?: Record<string, string | number | boolean | undefined>;
  corpo?: unknown;
  grantId: string;
  requestId: string;
  /** Obrigatória nas operações com `idempotencyKey: "required"`. */
  idempotencyKey?: string;
  /** `X-Audit-Reason` das mutações (`mcp:<ferramenta>:<grant_id>:<request_id>`). */
  motivoAuditoria?: string;
};

export type RespostaV2<T = unknown> = { status: number; dados: T; requestId: string };

/** Erro acionável, já no vocabulário do envelope (DESENHO §7.2). */
export type CodigoErroV2 =
  | 'reautenticar'
  | 'insufficient_scope'
  | 'nao_encontrado'
  | 'indisponivel_por_gate'
  | 'tentar_novamente'
  | 'ocupado'
  | 'em_andamento'
  | 'invalido'
  | 'erro_interno';

export class ErroV2 extends Error {
  override name = 'ErroV2';
  constructor(
    readonly codigo: CodigoErroV2,
    mensagem: string,
    readonly detalhes: { status?: number; tentarNovamenteEmS?: number; gate?: string; requestId?: string } = {},
  ) {
    super(mensagem);
  }
}

export interface ClienteV2 {
  chamar<T = unknown>(pedido: PedidoV2): Promise<RespostaV2<T>>;
}
