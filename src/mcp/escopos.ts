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

/** Papel do realm exigido para o grant existir (`ADMIN` sozinho não dá acesso). */
export const PAPEL_ACESSO = 'MCP_ACCESS';

/** Papel do realm que libera cada escopo (DESENHO §6.1). O P4 usa no recálculo a cada token novo da V2. */
export const PAPEL_DO_ESCOPO: Readonly<Record<Escopo, string>> = {
  'resgata:read.bi': 'MCP_READ_BI',
  'resgata:read.clientes': 'MCP_READ_CLIENTES',
  'resgata:pii': 'MCP_PII',
  'resgata:export': 'MCP_EXPORT',
  'resgata:contact': 'MCP_CONTACT',
  'resgata:attendance': 'MCP_ATTENDANCE',
  'resgata:campaigns': 'MCP_CAMPAIGNS',
  'resgata:billing': 'MCP_BILLING',
  'resgata:voice': 'MCP_VOICE',
  'resgata:automation': 'MCP_AUTOMATION',
  'resgata:crm.write': 'MCP_CRM_WRITE',
  'resgata:diagnostics.cpf': 'MCP_DIAG_CPF',
  'resgata:reprocess': 'MCP_REPROCESS',
};

/** Escopos que os papéis liberam, na ordem de `ESCOPOS`. */
export function escoposDosPapeis(papeis: Iterable<string>): Escopo[] {
  const tem = new Set(papeis);
  return ESCOPOS.filter((e) => tem.has(PAPEL_DO_ESCOPO[e]));
}
