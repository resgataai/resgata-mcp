import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FERRAMENTAS } from '../ferramentas/index.js';
import { criarLimites } from '../limites.js';
import { criarLog } from '../log.js';
import { criarServidorMcp } from '../mcp/servidor-mcp.js';
import { criarClienteOperacoes } from '../v2/cliente.js';
import {
  carregarCredencialMaquina,
  criarAuditoriaLocal,
  criarTokenMaquina,
  protegerFerramentasLocais,
} from './maquina.js';

async function iniciar() {
  const [item, conta, arquivoAuditoria] = process.argv.slice(2);
  if (!item || !conta || !arquivoAuditoria) throw new Error('uso: local <item-keychain> <conta> <auditoria.jsonl>');
  const credencial = carregarCredencialMaquina(item, conta);
  const log = criarLog('info', process.stderr);
  const limites = criarLimites();
  const token = criarTokenMaquina(credencial);
  const inicial = await token();
  const v2 = criarClienteOperacoes({ baseUrl: credencial.apiBase, limites, log }, token, token.invalidar);
  const grantId = `maquina-${credencial.subject}`;
  // Verifica os gates do backend antes de anunciar qualquer ferramenta ao cliente de IA.
  await v2.chamar({ operacao: 'me', grantId, requestId: crypto.randomUUID() });
  const auditoria = criarAuditoriaLocal(arquivoAuditoria);
  const chaves = Object.fromEntries(
    Object.entries(credencial.keys).map(([k, v]) => [k, Buffer.from(v, 'base64url')]),
  ) as { plano: Buffer; cursor: Buffer; auditoriaHmac: Buffer };
  serveStdio(() =>
    criarServidorMcp(
      {
        versao: '0.0.0-local',
        ferramentas: protegerFerramentasLocais(FERRAMENTAS, v2, limites),
        desligadas: new Set(),
        efeitosLigados: true,
        transcricoesLigadas: false,
        v2,
        auditoria,
        log,
        limites,
        chaves,
      },
      {
        token: '',
        clientId: 'https://chatgpt.com/oauth/codex/client.json',
        scopes: [...inicial.escopos],
        extra: { sub: credencial.subject, grantId, clientId: 'https://chatgpt.com/oauth/codex/client.json' },
      },
    ),
  );
}

iniciar().catch(() => {
  process.stderr.write('MCP local não iniciou: verifique credencial, acesso à API e gate do MCP.\n');
  process.exitCode = 1;
});
