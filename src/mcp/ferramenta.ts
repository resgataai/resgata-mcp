import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { Limites } from '../limites.js';
import type { AllowlistParams, Registrador } from '../log.js';
import type { PedidoV2, RespostaV2 } from '../v2/tipos.js';
import type { Escopo } from './escopos.js';
import type { No } from './provedores.js';

/** Pedido de uma ferramenta à V2: grant, request id e escopos entram pelo contexto. */
export type PedidoFerramenta = Omit<PedidoV2, 'grantId' | 'requestId' | 'escopos'>;

/** O que a ferramenta informa para a linha de auditoria da chamada. */
export type RegistroChamada = {
  targetType?: string;
  targetId?: string;
  planId?: string;
  idempotencyKeyHash?: string;
  /** `replayed` quando a V2 devolveu a resposta guardada. */
  outcome?: 'replayed';
};

/** O que uma ferramenta recebe por chamada. Tudo é por grant: nada aqui é compartilhado entre usuários. */
export type ContextoFerramenta = {
  sub: string;
  grantId: string;
  clientId: string;
  /** Escopo efetivo (grant ∩ papéis do realm, recalculado a cada token novo da V2). */
  escopos: ReadonlySet<string>;
  requestId: string;
  log: Registrador;
  limites: Limites;
  efeitosLigados: boolean;
  /** Transcrições e mensagens do provedor (D4); desligado = `indisponivel_por_gate`. */
  transcricoesLigadas: boolean;
  chaves: { plano: Buffer; cursor: Buffer };
  catalogo: { ferramentas: readonly Ferramenta[]; desligadas: ReadonlySet<string> };
  /** Nós de provedor do `diagnostico_provedor` (`MCP_PROVEDORES_JSON` ou o padrão genérico). */
  provedores: readonly No[];
  /** Preenchido pela ferramenta para a auditoria (alvo, plano, hash da chave). */
  registro: RegistroChamada;
  chamar<T = unknown>(pedido: PedidoFerramenta): Promise<RespostaV2<T>>;
  /** Grava a linha de auditoria (`accepted`) e espera o 201; sem ela o efeito não acontece. */
  antesDoEfeito(): Promise<void>;
  agora(): Date;
};

/**
 * Definição de uma ferramenta: uma por domínio em `src/ferramentas/<dominio>.ts`, listadas em
 * `src/ferramentas/index.ts`. `executar` devolve o `structuredContent` já no envelope do DESENHO §7.2.
 */
export type Ferramenta<E extends z.ZodObject = z.ZodObject> = {
  nome: string;
  titulo: string;
  descricao: string;
  /** Todos exigidos; vazio = só `MCP_ACCESS`. */
  escopos: readonly Escopo[];
  /** operationIds do manifesto que a ferramenta chama (conferido pelo `catalogo:check`). */
  operacoes: readonly string[];
  /** Argumentos que vão para log e auditoria; o resto nunca sai do processo. */
  paramsAuditaveis: AllowlistParams;
  anotacoes: ToolAnnotations;
  /** Efeito externo: some do catálogo com `MCP_EFFECTS_ENABLED=false`. */
  efeito: boolean;
  /** Pedidos de exemplo (aparecem em `resgata_capacidades`). */
  exemplos: readonly string[];
  entrada: E;
  saida: z.ZodObject;
  executar(args: z.infer<E>, ctx: ContextoFerramenta): Promise<Record<string, unknown>>;
};
