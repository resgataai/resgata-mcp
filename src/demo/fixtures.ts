/**
 * Respostas sintéticas da V2 falsa, por operationId. Nenhum dado real: CPFs só com o prefixo reservado
 * `000.000.`, nomes fictícios, e-mails em `exemplo.invalid`. O P5 acrescenta o formato completo de cada operação.
 */
export type PedidoFixture = { params: Record<string, string>; consulta: URLSearchParams; corpo: unknown };
export type Fixture = (
  p: PedidoFixture,
) => { status: number; corpo: unknown } | Promise<{ status: number; corpo: unknown }>;

let envios = 0;

export const FIXTURES: Record<string, Fixture> = {
  me: () => ({
    status: 200,
    corpo: { sub: 'demo-usuario-1', email: 'pessoa.demo@exemplo.invalid', name: 'Pessoa Demo', roles: ['ADMIN'] },
  }),
  lookup: () => ({
    status: 200,
    corpo: {
      results: [
        { userUuid: '00000000-0000-4000-8000-000000000001', name: 'Cliente Sintético Um', cpf: '000.000.001-91' },
      ],
    },
  }),
  health_1: () => ({
    status: 200,
    corpo: { providers: [{ provider: 'provedor-demo', status: 'UP', calls: 120, failures: 3 }] },
  }),
  adminIndividualSendTemplates: () => ({
    status: 200,
    corpo: { items: [{ id: 'modelo-demo-1', channel: 'EMAIL', name: 'Boas-vindas (demo)' }] },
  }),
  adminIndividualSend: () => {
    envios += 1;
    return { status: 202, corpo: { testId: `envio-demo-${envios}`, status: 'QUEUED' } };
  },
};
