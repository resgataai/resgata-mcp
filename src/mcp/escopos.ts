/** Escopos do MCP (DESENHO §6.1). Cada um corresponde a um papel `MCP_*` do realm. */
export const ESCOPOS = [
  'resgata:read.bi',
  'resgata:read.clientes',
  'resgata:pii',
  'resgata:export',
  'resgata:contact',
  'resgata:attendance',
  'resgata:campaigns',
  'resgata:billing',
  'resgata:voice',
  'resgata:automation',
  'resgata:crm.write',
  'resgata:diagnostics.cpf',
  'resgata:reprocess',
] as const;

export type Escopo = (typeof ESCOPOS)[number];

/** O PRM anuncia só o mínimo, como a spec manda; o AS anuncia todos. */
export const ESCOPO_MINIMO: Escopo = 'resgata:read.bi';
