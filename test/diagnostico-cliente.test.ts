import { afterEach, expect, it } from 'vitest';
import { CLIENTE_1 } from '../src/demo/fixtures.js';
import { type Ambiente, subirAmbiente, TODOS } from './ambiente.js';

let amb: Ambiente | undefined;
afterEach(async () => {
  await amb?.fechar();
  amb = undefined;
});
const ESCOPO_TECNICO = [...TODOS, 'resgata:diagnostics.cpf', 'resgata:pii'];
async function subirTecnico() {
  const a = await subirAmbiente();
  a.idp.definirPapeis('demo-usuario-1', [
    'ADMIN',
    'MCP_ACCESS',
    'MCP_READ_BI',
    'MCP_READ_CLIENTES',
    'MCP_CONTACT',
    'MCP_DIAG_CPF',
    'MCP_PII',
  ]);
  return a;
}
const EVENTO = '00000000-0000-4000-9000-000000000111';
const RESPOSTA = {
  code: 'BOND_NOT_ELIGIBLE',
  message: 'Vínculo não elegível: mínimo de 6 meses.',
  details: { requiredMonths: 6, currentMonths: 3 },
};

it('ignora sincronização de contato sem chamada e preserva erro legado em texto', async () => {
  amb = await subirTecnico();
  amb.v2.definir('lookup', () => ({
    status: 200,
    corpo: {
      user: { userUuid: CLIENTE_1 },
      timeline: [
        {
          kind: 'INTEGRATION',
          source: 'CRM_DEMO',
          eventType: 'contact_updated',
          eventUuid: EVENTO,
          rawPayload: { contactId: 7, error: false },
        },
        {
          kind: 'PROVIDER',
          source: 'PROVEDOR_DEMO',
          eventType: 'simulation.failed',
          eventUuid: '00000000-0000-4000-9000-000000000444',
          rawPayload: { error: 'Vínculo sem margem disponível' },
        },
      ],
    },
  }));
  const c = await amb.mcp(await amb.conectar('demo-usuario-1', ESCOPO_TECNICO));
  const r = await c.callTool({ name: 'diagnostico_cpf', arguments: { userUuid: CLIENTE_1 } });
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent).toMatchObject({
    pagina: {
      total: 1,
      itens: [{ tipo_evento: 'simulation.failed', erro_registrado: 'Vínculo sem margem disponível' }],
    },
  });
});

it('diagnóstico por CPF preserva a resposta registrada e correlação, sem credenciais ou requisição', async () => {
  amb = await subirTecnico();
  amb.v2.definir('lookup', () => ({
    status: 200,
    corpo: {
      user: { userUuid: CLIENTE_1 },
      timeline: [
        {
          kind: 'PROVIDER',
          source: 'PROVEDOR_DEMO',
          eventType: 'provider.call.failed',
          eventUuid: EVENTO,
          referenceUuid: '00000000-0000-4000-9000-000000000112',
          proposalUuid: '00000000-0000-4000-9000-000000000112',
          occurredAt: '2026-11-06T12:00:00Z',
          rawPayload: {
            operation: 'clt.bonds.fetch',
            jobUuid: '00000000-0000-4000-9000-000000000113',
            transport: {
              method: 'POST',
              target: 'https://example.invalid/bonds?access_token=segredo-na-url',
              status: 422,
              durationMs: 123,
              attempts: 2,
            },
            error: { type: 'BOND_NOT_ELIGIBLE', message: RESPOSTA.message, outcome: 'business_refusal' },
            request: { body: { password: 'nunca-deve-sair' } },
            response: {
              body: {
                ...RESPOSTA,
                access_token: 'credencial-que-nao-pode-sair',
                nested: { clientSecret: 'outro-segredo' },
              },
            },
          },
        },
      ],
    },
  }));
  const c = await amb.mcp(await amb.conectar('demo-usuario-1', ESCOPO_TECNICO));
  expect((await c.listTools()).tools.some((t) => t.name === 'diagnostico_cpf')).toBe(true);
  const r = await c.callTool({ name: 'diagnostico_cpf', arguments: { cpf: '000.000.001-91' } });
  expect(r.isError).toBeFalsy();
  const s = r.structuredContent as {
    dados: { userUuid: string };
    pagina: { itens: Array<{ detalhes: { erros: Array<{ valor: string }>; tecnicos: Array<{ valor: string }> } }> };
    lacunas: unknown[];
  };
  expect(s.dados.userUuid).toBe(CLIENTE_1);
  expect(s.pagina.itens[0]).toMatchObject({
    evento_uuid: EVENTO,
    provedor: 'PROVEDOR_DEMO',
    operacao: 'clt.bonds.fetch',
    http_status: 422,
    job_vinculos_uuid: '00000000-0000-4000-9000-000000000113',
    proposalUuid: null,
    resposta_registrada: RESPOSTA,
    classificacao_registrada: 'business_refusal',
  });
  const texto = JSON.stringify(r);
  for (const segredo of [
    'nunca-deve-sair',
    'credencial-que-nao-pode-sair',
    'outro-segredo',
    'segredo-na-url',
    '000.000.001-91',
  ])
    expect(texto).not.toContain(segredo);
  expect(amb.v2.chamadas.find((x) => x.operacao === 'lookup')?.corpo).toEqual({ cpf: '00000000191' });
});

it.each([
  ['resgata:read.clientes', 'resgata:read.bi'],
  ['resgata:read.clientes', 'resgata:diagnostics.cpf'],
  ['resgata:read.clientes', 'resgata:pii'],
])('nega diagnóstico técnico sem todas as permissões: %j', async (...escopos: string[]) => {
  amb = await subirTecnico();
  const grant = await amb.conectar('demo-usuario-1', escopos);
  const c = await amb.mcp(grant);
  expect((await c.listTools()).tools.some((t) => t.name === 'diagnostico_cpf')).toBe(false);
  expect((await amb.chamarHttp(grant, 'diagnostico_cpf', { userUuid: CLIENTE_1 })).status).toBe(403);
  expect(amb.v2.chamadas.filter((x) => x.operacao === 'lookup')).toHaveLength(0);
});

it('Jornada mostra as mensagens e detalhes técnicos disponíveis, inclusive ausência de corpo', async () => {
  amb = await subirTecnico();
  amb.v2.definir('journeyLog', () => ({
    status: 200,
    corpo: {
      items: [
        {
          occurredAt: '2026-11-06T12:00:00Z',
          code: 'SIMULATION_FAILED',
          error: true,
          details: {
            errors: [{ label: 'Mensagem original do provedor', value: RESPOSTA.message }],
            technical: [{ label: 'HTTP do provedor', value: '422' }],
            eligibility: [],
            limited: false,
          },
        },
      ],
      hasMore: false,
    },
  }));
  const c = await amb.mcp(await amb.conectar('demo-usuario-1', ESCOPO_TECNICO));
  const r = await c.callTool({ name: 'cliente_jornada', arguments: { userUuid: CLIENTE_1, produto: 'CLT' } });
  expect(r.isError).toBeFalsy();
  const s = r.structuredContent as {
    dados: { userUuid: string };
    pagina: { itens: Array<{ detalhes: { erros: Array<{ valor: string }>; tecnicos: Array<{ valor: string }> } }> };
    lacunas: unknown[];
  };
  expect(s.pagina.itens[0]).toMatchObject({
    detalhes: { erros: [{ valor: RESPOSTA.message }], tecnicos: [{ valor: '422' }] },
  });
  expect(JSON.stringify(s.lacunas)).not.toContain('mensagens_do_provedor_fora');
});

it('não confunde HTTP200 com aprovação, declara corpo ausente e pagina pelo evento mesmo após nova inserção', async () => {
  amb = await subirTecnico();
  const segundo = '00000000-0000-4000-9000-000000000222';
  const novo = '00000000-0000-4000-9000-000000000333';
  const evento = (id: string, corpo: boolean) => ({
    kind: 'PROVIDER',
    source: 'PROVEDOR_DEMO',
    eventUuid: id,
    eventType: 'provider.call.succeeded',
    occurredAt: '2026-11-06T12:00:00Z',
    rawPayload: {
      operation: 'credit.simulate',
      transport: { status: 200 },
      ...(corpo ? { response: { body: { eligible: false, reason: 'Regra do fundo não atendida' } } } : {}),
    },
  });
  let eventos = [evento(EVENTO, true), evento(segundo, false)];
  amb.v2.definir('lookup', () => ({ status: 200, corpo: { user: { userUuid: CLIENTE_1 }, timeline: eventos } }));
  const c = await amb.mcp(await amb.conectar('demo-usuario-1', ESCOPO_TECNICO));
  type Pagina = { pagina: { itens: unknown[]; proximo_cursor: string }; lacunas: Array<{ codigo: string }> };
  const r1 = await c.callTool({ name: 'diagnostico_cpf', arguments: { userUuid: CLIENTE_1, limite: 1 } });
  expect(r1.isError).toBeFalsy();
  const a = r1.structuredContent as Pagina;
  expect(a.pagina.itens[0]).toMatchObject({
    http_status: 200,
    resposta_presente: true,
    resposta_registrada: { eligible: false, reason: 'Regra do fundo não atendida' },
  });
  expect(a.lacunas.some((x) => x.codigo === 'causa_abandono_nao_comprovada')).toBe(true);
  eventos = [evento(novo, true), ...eventos];
  const r2 = await c.callTool({
    name: 'diagnostico_cpf',
    arguments: { userUuid: CLIENTE_1, limite: 1, cursor: a.pagina.proximo_cursor },
  });
  expect(r2.isError).toBeFalsy();
  expect((r2.structuredContent as Pagina).pagina.itens[0]).toMatchObject({
    evento_uuid: segundo,
    resposta_presente: false,
    resposta_registrada: null,
  });
});
