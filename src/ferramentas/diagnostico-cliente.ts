import * as z from 'zod';
import { endpointTecnico, sanitizarTecnico } from '../mcp/dados-tecnicos.js';
import { envelope, horaBrt, janela, saidaEnvelope } from '../mcp/envelope.js';
import { ErroV2 } from '../v2/tipos.js';
import {
  AVISO_TERCEIROS,
  cursor,
  definir,
  filtrosDe,
  LEITURA,
  lista,
  nn,
  num,
  obj,
  periodo,
  posicao,
  proximo,
  sn,
  str,
  uuid,
} from './comum.js';

const diagnostico = definir({
  nome: 'diagnostico_cpf',
  titulo: 'Resposta técnica do provedor por cliente',
  descricao: `Consulta por CPF ou userUuid as chamadas registradas de vínculos, simulação e demais operações. Retorna resposta registrada (JSON/texto), HTTP, erro, operação, horário e correlação, sem resumir o corpo. Dados de origem já sanitizados e limitados pela captura; não são os bytes originais nem prova da causa de abandono. Inclui sucessos HTTP200, que podem conter recusas de negócio. Consulte também cliente_jornada para detalhes da tentativa e retomadas. ${AVISO_TERCEIROS}`,
  escopos: ['resgata:read.clientes', 'resgata:diagnostics.cpf', 'resgata:pii'],
  operacoes: ['lookup'],
  paramsAuditaveis: {
    cpf: 'hmac',
    userUuid: 'claro',
    evento_uuid: 'claro',
    provedor: 'claro',
    operacao: 'claro',
    de: 'claro',
    ate: 'claro',
  },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: [
    'Qual foi exatamente a resposta do provedor ao consultar os vínculos deste CPF?',
    'Mostre o retorno da simulação e o evento ligado a este cliente',
  ],
  entrada: z
    .strictObject({
      cpf: z.string().max(20).optional(),
      userUuid: uuid.optional(),
      evento_uuid: uuid.optional(),
      provedor: z.string().min(1).max(80).optional(),
      operacao: z.string().min(1).max(120).optional(),
      ...periodo,
      cursor,
      limite: z.number().int().min(1).max(20).default(5),
    })
    .refine((a) => Number(Boolean(a.cpf)) + Number(Boolean(a.userUuid)) === 1, 'informe exatamente um: cpf ou userUuid')
    .refine((a) => !a.cpf || /^\d{11}$/.test(a.cpf.replace(/\D/g, '')), 'CPF precisa ter 11 dígitos'),
  saida: saidaEnvelope(
    z.strictObject({
      userUuid: uuid,
      cobertura: z.literal('parcial'),
      limite_fonte: z.literal(200),
      eventos_examinados: z.number(),
    }),
    z.strictObject({
      evento_uuid: sn,
      referencia_uuid: sn,
      proposalUuid: sn,
      grupo_simulacao_uuid: sn,
      job_vinculos_uuid: sn,
      quando: sn,
      tipo_evento: sn,
      provedor: sn,
      operacao: sn,
      metodo: sn,
      endpoint_sem_parametros: sn,
      http_status: nn,
      duracao_ms: nn,
      tentativas: nn,
      classificacao_registrada: sn,
      erro_registrado: z.json().nullable(),
      resposta_presente: z.boolean(),
      conteudo_externo_nao_confiavel: z.literal(true),
      resposta_registrada: z.json().nullable(),
    }),
  ),
  async executar(args, ctx) {
    const filtros = filtrosDe(args);
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'lookup',
      corpo: args.userUuid ? { uuid: args.userUuid } : { cpf: (args.cpf ?? '').replace(/\D/g, '') },
    });
    const userUuid = uuid.parse(obj(dados.user).userUuid);
    ctx.registro.targetType = 'user';
    ctx.registro.targetId = userUuid;
    const timeline = lista<Record<string, unknown>>(dados.timeline);
    const propostas = new Set(lista<Record<string, unknown>>(dados.proposals).map((p) => str(p.proposalUuid)));
    const j = args.de || args.ate ? janela(args.de, args.ate, 1, ctx.agora()) : undefined;
    const eventos = timeline.filter((e) => {
      if (e.kind !== 'PROVIDER' && e.kind !== 'INTEGRATION') return false;
      const p = obj(e.rawPayload);
      const temErro =
        typeof p.error === 'string'
          ? Boolean(p.error.trim())
          : p.error != null &&
            p.error !== false &&
            p.error !== 0 &&
            (typeof p.error !== 'object' || Object.keys(p.error).length > 0);
      const temChamada =
        Boolean(str(p.operation)?.trim() || str(e.operationName)?.trim()) || Object.keys(obj(p.transport)).length > 0;
      if (
        !temChamada &&
        !Object.hasOwn(obj(p.response), 'body') &&
        !temErro &&
        !/[._]failed$/.test(String(e.eventType))
      )
        return false;
      if (args.evento_uuid && e.eventUuid !== args.evento_uuid) return false;
      if (args.provedor && String(e.source ?? '').toLowerCase() !== args.provedor.toLowerCase()) return false;
      if (
        args.operacao &&
        !String(obj(e.rawPayload).operation ?? e.operationName ?? '')
          .toLowerCase()
          .includes(args.operacao.toLowerCase())
      )
        return false;
      if (j) {
        const t = Date.parse(String(e.occurredAt));
        if (!Number.isFinite(t) || t < Date.parse(j.from) || t > Date.parse(j.to)) return false;
      }
      return true;
    });
    const marcador = args.cursor ? String(posicao(ctx, 'diagnostico_cpf', filtros, args.cursor)) : undefined;
    const indice = marcador ? eventos.findIndex((e) => e.eventUuid === marcador) : -1;
    if (marcador && indice < 0) throw new ErroV2('invalido', 'a fonte mudou ou o evento expirou; refaça sem cursor');
    const selecionados = eventos.slice(indice + 1, indice + 1 + args.limite);
    const itens = selecionados.map((e) => {
      const p = obj(e.rawPayload),
        t = obj(p.transport),
        resposta = obj(p.response),
        erro = obj(p.error);
      return {
        evento_uuid: str(e.eventUuid),
        referencia_uuid: str(e.referenceUuid),
        // shortcut: a fonte copia a referência aleatória de provider.call para proposalUuid; só usar quando a API correlacionar de fato.
        proposalUuid:
          String(e.eventType).startsWith('provider.call.') || !propostas.has(str(e.proposalUuid))
            ? null
            : str(e.proposalUuid),
        grupo_simulacao_uuid: str(obj(p.correlation).simulationGroupUuid),
        job_vinculos_uuid: str(p.jobUuid),
        quando: horaBrt(e.occurredAt),
        tipo_evento: str(e.eventType),
        provedor: str(e.source),
        operacao: str(p.operation) ?? str(e.operationName),
        metodo: str(t.method),
        endpoint_sem_parametros: endpointTecnico(t.target),
        http_status: num(t.status),
        duracao_ms: num(t.durationMs),
        tentativas: num(t.attempts),
        classificacao_registrada: str(erro.outcome),
        erro_registrado: p.error == null ? null : sanitizarTecnico(p.error),
        resposta_presente: Object.hasOwn(resposta, 'body'),
        conteudo_externo_nao_confiavel: true,
        resposta_registrada: Object.hasOwn(resposta, 'body') ? sanitizarTecnico(resposta.body) : null,
      };
    });
    const mais = indice + 1 + selecionados.length < eventos.length;
    const ultimo = selecionados.at(-1);
    return envelope(ctx, {
      operacoes: ['lookup'],
      dados: { userUuid, cobertura: 'parcial', limite_fonte: 200, eventos_examinados: timeline.length },
      pagina: {
        itens,
        total: eventos.length,
        proximo_cursor: proximo(ctx, 'diagnostico_cpf', filtros, mais && ultimo ? str(ultimo.eventUuid) : null),
      },
      periodo: j,
      lacunas: [
        {
          codigo: 'captura_limitada',
          mensagem:
            'Fonte: até 200 eventos recentes por cliente, sujeitos a retenção e sanitização na captura (textos limitados a 8 KiB na fonte). Sem corpo registrado, resposta_presente=false; ausência de eventos não prova ausência de chamada.',
        },
        {
          codigo: 'proposta_exige_correlacao',
          mensagem:
            'UUID de referência de chamada não é UUID de proposta. proposalUuid só é exposto quando confirmado no perfil; chamadas de transporte usam evento, grupo de simulação e job de vínculos.',
        },
        {
          codigo: 'causa_abandono_nao_comprovada',
          mensagem:
            'O erro é evidência da chamada, não prova de abandono. Cruze evento, horário, grupo de simulação/job de vínculos e a Jornada; uma tentativa posterior pode ter recuperado a falha.',
        },
      ],
    });
  },
});

export const FERRAMENTAS_DIAGNOSTICO_CLIENTE = [diagnostico];
