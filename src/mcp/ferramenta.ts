import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { Limites } from '../limites.js';
import type { AllowlistParams, Registrador } from '../log.js';
import type { ClienteV2 } from '../v2/tipos.js';
import type { Escopo } from './escopos.js';

/** O que uma ferramenta recebe por chamada. Tudo é por grant: nada aqui é compartilhado entre usuários. */
export type ContextoFerramenta = {
  sub: string;
  grantId: string;
  clientId: string;
  escopos: ReadonlySet<string>;
  requestId: string;
  v2: ClienteV2;
  log: Registrador;
  limites: Limites;
  efeitosLigados: boolean;
};

/**
 * Definição de uma ferramenta (P5 cria uma por arquivo em `src/ferramentas/<dominio>.ts` e lista em
 * `src/ferramentas/index.ts`). `executar` devolve o `structuredContent` já no envelope do DESENHO §7.2.
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
  entrada: E;
  saida: z.ZodObject;
  executar(args: z.infer<E>, ctx: ContextoFerramenta): Promise<Record<string, unknown>>;
};
