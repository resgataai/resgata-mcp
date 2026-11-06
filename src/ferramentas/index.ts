import type { Ferramenta } from '../mcp/ferramenta.js';
import { FERRAMENTAS_ATENDIMENTO } from './atendimento.js';
import { FERRAMENTAS_BI } from './bi.js';
import { FERRAMENTAS_CAMPANHAS } from './campanhas.js';
import { FERRAMENTAS_CLIENTES } from './clientes.js';
import { FERRAMENTAS_CONTA } from './conta.js';
import { FERRAMENTAS_CONTATO } from './contato.js';
import { FERRAMENTAS_DIAGNOSTICO } from './diagnostico.js';
import { FERRAMENTAS_PROPOSTAS } from './propostas.js';

/** Catálogo do incremento 1 (27 ferramentas; PLANO §3.1 P5). Um arquivo por domínio. */
export const FERRAMENTAS: readonly Ferramenta[] = [
  ...FERRAMENTAS_CONTA,
  ...FERRAMENTAS_CLIENTES,
  ...FERRAMENTAS_PROPOSTAS,
  ...FERRAMENTAS_BI,
  ...FERRAMENTAS_CAMPANHAS,
  ...FERRAMENTAS_CONTATO,
  ...FERRAMENTAS_ATENDIMENTO,
  ...FERRAMENTAS_DIAGNOSTICO,
];
