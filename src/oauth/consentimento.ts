import { createHash } from 'node:crypto';
import type { Escopo } from '../mcp/escopos.js';

/** O que cada escopo permite, em português (DESENHO §6.1). Textos públicos: "o provedor", nunca o nome do parceiro. */
export const DESCRICAO_ESCOPO: Readonly<Record<Escopo, string>> = {
  'resgata:read.bi': 'Ler indicadores agregados (BI, saúde, campanhas e modelos), sem registros de clientes',
  'resgata:read.clientes': 'Ler registros de clientes, propostas e conversas, com dados pessoais mascarados',
  'resgata:pii': 'Ver CPF, telefone e e-mail completos (cada revelação fica registrada)',
  'resgata:export': 'Gerar exportações (o arquivo fica no painel)',
  'resgata:contact': 'Falar com clientes (e-mail e mensagens) e fazer pedidos à Agente Rê',
  'resgata:attendance': 'Agir no atendimento: atribuir, anotar, rotular, transferir, pausar a IA',
  'resgata:campaigns': 'Criar e gerir audiências e campanhas',
  'resgata:billing': 'Agir na cobrança',
  'resgata:voice': 'Fazer ligações e usar a URA',
  'resgata:automation': 'Criar automações, réguas, rotinas e monitoramentos',
  'resgata:crm.write': 'Alterar cadastro e CRM',
  'resgata:diagnostics.cpf': 'Investigar um CPF ou uma tentativa junto ao provedor',
  'resgata:reprocess': 'Reprocessar operações elegíveis',
};

const CSS =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}' +
  'h1{font-size:1.4rem}ul{padding-left:1.2rem}.alerta{background:#fff4d6;border-left:4px solid #c98a00;padding:.6rem .8rem}' +
  '.botoes{display:flex;gap:.8rem;margin-top:1.4rem}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}' +
  'button[value=aprovar]{background:#0b5;color:#fff;border:0}.mudo{color:#555;font-size:.9rem}';

/** Cabeçalhos das telas: sem script, só o CSS acima, sem moldura e sem cache. */
export const CABECALHOS_TELA: Readonly<Record<string, string>> = {
  'content-security-policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(CSS).digest('base64')}'; frame-ancestors 'none'; base-uri 'none'`,
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const pagina = (titulo: string, corpo: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo)} · Resgata.ai</title><style>${CSS}</style></head><body><h1>${esc(titulo)}</h1>${corpo}</body></html>`;

export type DadosConsentimento = {
  uid: string;
  csrf: string;
  aplicativo: string;
  hostRetorno: string;
  loopback: boolean;
  email?: string;
  escopos: readonly Escopo[];
};

/** Mostrada sempre, nunca lembrada (DESENHO §5.2 passo 7). */
export function paginaConsentimento(d: DadosConsentimento): string {
  const itens = d.escopos.map((e) => `<li>${esc(DESCRICAO_ESCOPO[e])}</li>`).join('');
  const local = d.loopback
    ? `<p>Este aplicativo roda <strong>no seu computador</strong>. Se você não abriu agora o ${esc(d.aplicativo)} nesta máquina, recuse.</p>`
    : '';
  const corpo = d.escopos.length
    ? `<p>O que ele poderá fazer em seu nome:</p><ul>${itens}</ul>`
    : '<p>Sua conta não tem nenhuma permissão do MCP além do acesso. Peça a liberação a quem administra o painel.</p>';
  return pagina(
    `Conectar ${d.aplicativo} à Resgata.ai`,
    `<p class="alerta"><strong>Só aprove se você acabou de clicar em Conectar neste aplicativo.</strong></p>` +
      `<p>Aplicativo: <strong>${esc(d.aplicativo)}</strong><br>Retorno para: <strong>${esc(d.hostRetorno)}</strong>` +
      `${d.email ? `<br>Sua conta: <strong>${esc(d.email)}</strong>` : ''}</p>${local}${corpo}` +
      '<p class="mudo">Validade: até 90 dias, e termina antes se ficar 30 dias sem uso. Você pode desconectar a ' +
      'qualquer momento em Perfil → Integrações de IA, no painel.</p>' +
      `<form method="post" action="/oauth/interacao/${esc(d.uid)}/decisao"><input type="hidden" name="csrf" value="${esc(d.csrf)}">` +
      `<div class="botoes">${d.escopos.length ? '<button name="decisao" value="aprovar">Aprovar</button>' : ''}` +
      '<button name="decisao" value="recusar">Recusar</button></div></form>',
  );
}

export function paginaAviso(titulo: string, mensagem: string, link?: { href: string; texto: string }): string {
  return pagina(
    titulo,
    `<p>${esc(mensagem)}</p>${link ? `<p><a href="${esc(link.href)}">${esc(link.texto)}</a></p>` : ''}`,
  );
}
