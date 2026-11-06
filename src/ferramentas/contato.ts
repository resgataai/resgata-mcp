import * as z from 'zod';
import { diaBrt, envelope, horaBrt, type Lacuna, saidaEnvelope } from '../mcp/envelope.js';
import { mascararEmail, textoExterno } from '../mcp/mascara.js';
import { abrirPlano, chaveIdempotencia, selarPlano } from '../mcp/plano.js';
import { hashChave } from '../mcp/servidor-mcp.js';
import { ErroV2 } from '../v2/tipos.js';
import { definir, LEITURA, lista, obj, sn, str, uuid } from './comum.js';

/** Inc. 1: só e-mail por modelo (WhatsApp, SMS e texto livre no inc. 2). Na V2 o canal é `EMAIL`. */
const CANAL_V2 = 'EMAIL';
const canal = z.enum(['email']).default('email');
/** Modelo de e-mail na V2: id numérico do modelo transacional (`TemplateSendService`). */
const modeloId = z.string().regex(/^[1-9][0-9]{0,17}$/, 'id numérico do modelo (veja modelos_listar)');
const EXECUTAR = 'contato_executar';

type Modelo = { id?: string; name?: string; preview?: string };

const modelosListar = definir({
  nome: 'modelos_listar',
  titulo: 'Modelos de mensagem',
  descricao: 'Modelos aprovados para envio individual, com id, nome e prévia. Incremento 1: só e-mail.',
  escopos: ['resgata:read.bi'],
  operacoes: ['adminIndividualSendTemplates'],
  paramsAuditaveis: { canal: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['Quais modelos de e-mail posso mandar a um cliente?'],
  entrada: z.strictObject({ canal }),
  saida: saidaEnvelope(z.strictObject({ canal: z.string() }), z.strictObject({ id: sn, nome: sn, previa: sn })),
  async executar(args, ctx) {
    const { dados } = await ctx.chamar<Modelo[]>({
      operacao: 'adminIndividualSendTemplates',
      consulta: { channel: CANAL_V2 },
    });
    const itens = lista<Modelo>(dados).map((m) => ({
      id: str(m.id),
      nome: textoExterno(m.name, 120),
      previa: textoExterno(m.preview, 500),
    }));
    return envelope(ctx, {
      operacoes: ['adminIndividualSendTemplates'],
      dados: { canal: args.canal },
      pagina: { itens: itens.slice(0, 50), proximo_cursor: null, total: itens.length },
    });
  },
});

const planejar = definir({
  nome: 'contato_planejar',
  titulo: 'Prévia de contato com cliente',
  descricao:
    'Prévia SEM EFEITO de um envio de modelo por e-mail a um cliente: destino mascarado, conteúdo, impedimentos e envios recentes. Devolve plan_id (válido 30 min) para contato_executar. Mostre a prévia à pessoa antes de executar. Incremento 1: só e-mail por modelo.',
  escopos: ['resgata:contact'],
  operacoes: ['lookup', 'adminIndividualSendTemplates', 'listUserCommunications'],
  paramsAuditaveis: { userUuid: 'claro', canal: 'claro', modeloId: 'claro', repeticao_intencional: 'claro' },
  anotacoes: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  efeito: false,
  exemplos: ['Mande o modelo de boas-vindas por e-mail para este cliente', 'Prepare o envio do modelo 12 ao cliente'],
  entrada: z.strictObject({
    userUuid: uuid,
    canal,
    modeloId,
    repeticao_intencional: z
      .boolean()
      .default(false)
      .describe('true só se a pessoa pediu para repetir um envio já feito hoje'),
  }),
  saida: saidaEnvelope(
    z.strictObject({
      plan_id: sn,
      expira_em: sn,
      canal: z.string(),
      motivo_canal: z.string(),
      destino: sn,
      cliente: sn,
      modelo: z.strictObject({ id: z.string(), nome: sn, previa: sn }),
      impedimentos: z.array(z.strictObject({ codigo: z.string(), mensagem: z.string() })),
      envios_recentes: z.array(z.strictObject({ quando: sn, titulo: sn, resultado: sn, fonte: sn })),
      irreversivel: z.literal(true),
    }),
  ),
  async executar(args, ctx) {
    ctx.registro.targetType = 'user';
    ctx.registro.targetId = args.userUuid;
    const desde = ctx.agora().getTime() - 86_400_000;
    const [perfil, modelos, comunicacoes] = await Promise.all([
      ctx.chamar<Record<string, unknown>>({ operacao: 'lookup', corpo: { uuid: args.userUuid } }),
      ctx.chamar<Modelo[]>({ operacao: 'adminIndividualSendTemplates', consulta: { channel: CANAL_V2 } }),
      ctx.chamar<Record<string, unknown>>({
        operacao: 'listUserCommunications',
        caminho: { userUuid: args.userUuid },
        consulta: { channel: CANAL_V2, limit: 50 },
      }),
    ]);
    const modelo = lista<Modelo>(modelos.dados).find((m) => String(m.id) === args.modeloId);
    if (!modelo) throw new ErroV2('nao_encontrado', 'modelo não encontrado entre os aprovados; veja modelos_listar');
    const u = obj(perfil.dados.user);
    const recentes = lista<Record<string, unknown>>(obj(comunicacoes.dados).items)
      .filter((c) => Date.parse(String(c.occurredAt ?? '')) >= desde)
      .map((c) => ({
        quando: horaBrt(c.occurredAt),
        titulo: textoExterno(c.title, 200),
        resultado: str(c.outcome),
        fonte: str(c.source),
      }));
    const impedimentos: Array<{ codigo: string; mensagem: string }> = [];
    if (!str(u.email)) impedimentos.push({ codigo: 'sem_email', mensagem: 'cliente sem e-mail cadastrado' });
    if (u.accountStatus === 'DEACTIVATED')
      impedimentos.push({ codigo: 'conta_desativada', mensagem: 'conta do cliente desativada' });
    const mesmoModelo = recentes.some((r) => r.titulo && modelo.name && r.titulo === textoExterno(modelo.name, 200));
    if (mesmoModelo && !args.repeticao_intencional) {
      impedimentos.push({
        codigo: 'repeticao_requer_confirmacao',
        mensagem: 'este modelo já saiu para o cliente nas últimas 24 h; confirme com repeticao_intencional=true',
      });
    }
    if (!ctx.efeitosLigados) {
      impedimentos.push({
        codigo: 'efeitos_desligados',
        mensagem: 'envios desligados nesta instalação (MCP_EFFECTS_ENABLED)',
      });
    }
    const bloqueia = impedimentos.some((i) => i.codigo !== 'efeitos_desligados');
    const plano = bloqueia
      ? undefined
      : await selarPlano(
          {
            sub: ctx.sub,
            grantId: ctx.grantId,
            ferramenta: EXECUTAR,
            // `dia` (BRT da prévia) vai assinado no plano e entra na chave; nunca no corpo enviado à V2.
            args: { userUuid: args.userUuid, channel: CANAL_V2, templateId: args.modeloId, dia: diaBrt(ctx.agora()) },
            repeticaoIntencional: args.repeticao_intencional,
          },
          ctx.chaves.plano,
          ctx.agora(),
        );
    if (plano) ctx.registro.planId = plano.jti;
    const lacunas: Lacuna[] = [
      {
        codigo: 'envio_individual_fora_do_historico',
        mensagem:
          'Envios individuais anteriores não aparecem no histórico; a repetição no mesmo dia é neutralizada pela chave de idempotência.',
      },
    ];
    return envelope(ctx, {
      operacoes: ['lookup', 'adminIndividualSendTemplates', 'listUserCommunications'],
      dados: {
        plan_id: plano?.planId ?? null,
        expira_em: plano?.expiraEm ?? null,
        canal: 'email',
        motivo_canal: 'único canal de envio direto no incremento 1',
        destino: mascararEmail(str(u.email)),
        cliente: textoExterno(u.name, 120),
        modelo: { id: args.modeloId, nome: textoExterno(modelo.name, 120), previa: textoExterno(modelo.preview, 500) },
        impedimentos,
        envios_recentes: recentes.slice(0, 10),
        irreversivel: true,
      },
      lacunas,
    });
  },
});

const esquemaEnvio = z.strictObject({
  id: sn,
  status: sn,
  motivo: sn,
  canal: sn,
  modelo: sn,
  destino: sn,
  aceito_em: sn,
  concluido_em: sn,
});
const envio = (r: Record<string, unknown>) => ({
  id: str(r.testId),
  status: str(r.status),
  motivo: str(r.reason),
  canal: str(r.channel),
  modelo: textoExterno(r.templateName, 120),
  destino: str(r.destinationMasked),
  aceito_em: horaBrt(r.acceptedAt),
  concluido_em: horaBrt(r.completedAt),
});

const executar = definir({
  nome: EXECUTAR,
  titulo: 'Executar contato com cliente',
  descricao:
    'EFEITO EXTERNO E IRREVERSÍVEL: envia ao cliente o que a prévia (contato_planejar) mostrou. Só aceita plan_id da prévia, da mesma pessoa e conexão, em até 30 min. Repetir o mesmo pedido no mesmo dia não reenvia: devolve o mesmo envio. Peça aprovação a cada uso.',
  escopos: ['resgata:contact'],
  operacoes: ['adminIndividualSend'],
  paramsAuditaveis: {},
  anotacoes: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  efeito: true,
  exemplos: ['Pode enviar (depois de ver a prévia)'],
  entrada: z.strictObject({ plan_id: z.string().min(20).max(4000) }),
  saida: saidaEnvelope(z.strictObject({ envio: esquemaEnvio, repetido: z.boolean() })),
  async executar(args, ctx) {
    const plano = await abrirPlano(
      args.plan_id,
      ctx.chaves.plano,
      { sub: ctx.sub, grantId: ctx.grantId, ferramenta: EXECUTAR },
      ctx.agora(),
    );
    const { userUuid = '', channel = CANAL_V2, templateId = '', dia = '' } = plano.args;
    ctx.registro.targetType = 'user';
    ctx.registro.targetId = userUuid;
    ctx.registro.planId = plano.jti;
    const limite = ctx.limites.efeitosPorUsuario.consumir(ctx.sub);
    if (!limite.ok) {
      throw new ErroV2('tentar_novamente', 'teto diário de envios atingido', {
        tentarNovamenteEmS: Math.ceil(limite.reiniciaEmMs / 1000),
      });
    }
    const chave = chaveIdempotencia({
      sub: ctx.sub,
      ferramenta: EXECUTAR,
      userUuid,
      canal: channel,
      templateId,
      dia,
      ...(plano.repeticaoIntencional ? { nonce: plano.jti } : {}),
    });
    ctx.registro.idempotencyKeyHash = hashChave(chave);
    await ctx.antesDoEfeito();
    const r = await ctx.chamar<Record<string, unknown>>({
      operacao: 'adminIndividualSend',
      corpo: { userUuid, channel, templateId },
      idempotencyKey: chave,
      motivoAuditoria: `mcp:${EXECUTAR}:${ctx.grantId}:${ctx.requestId}`,
    });
    if (r.replay) ctx.registro.outcome = 'replayed';
    return envelope(ctx, {
      operacoes: ['adminIndividualSend'],
      dados: { envio: envio(r.dados), repetido: r.replay },
      definicoes: { dia_da_chave: dia },
    });
  },
});

const status = definir({
  nome: 'contato_status',
  titulo: 'Situação do envio',
  descricao: 'Situação de um envio feito por contato_executar: aceito, enviado ou bloqueado (com motivo).',
  escopos: ['resgata:read.clientes'],
  operacoes: ['adminTemplateTestGet'],
  paramsAuditaveis: { id: 'claro' },
  anotacoes: LEITURA,
  efeito: false,
  exemplos: ['O e-mail que mandei saiu?'],
  entrada: z.strictObject({ id: uuid.describe('id devolvido por contato_executar') }),
  saida: saidaEnvelope(z.strictObject({ envio: esquemaEnvio })),
  async executar(args, ctx) {
    ctx.registro.targetType = 'template_send';
    ctx.registro.targetId = args.id;
    const { dados } = await ctx.chamar<Record<string, unknown>>({
      operacao: 'adminTemplateTestGet',
      caminho: { id: args.id },
    });
    return envelope(ctx, {
      operacoes: ['adminTemplateTestGet'],
      dados: { envio: envio(dados) },
      lacunas: [{ codigo: 'estados_parciais', mensagem: 'Entrega, leitura e resposta só no incremento 2.' }],
    });
  },
});

export const FERRAMENTAS_CONTATO = [modelosListar, planejar, executar, status];
