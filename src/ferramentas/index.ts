import type { Ferramenta } from '../mcp/ferramenta.js';

/**
 * Catálogo do incremento 1. O P5 acrescenta uma linha por domínio (`./bi.js`, `./clientes.js` …);
 * cada domínio exporta a sua lista para evitar conflito entre frentes.
 */
export const FERRAMENTAS: readonly Ferramenta[] = [];
