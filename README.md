# Resgata MCP

Servidor MCP (Model Context Protocol) oficial da [Resgata.ai](https://resgata.ai). Ele vai permitir que pessoas
autorizadas consultem dados, peçam análises e executem operações de negócio da plataforma em linguagem natural, a
partir do **Claude** (Claude.ai, Claude Desktop, app móvel e Claude Code) e do **Codex** (CLI, extensão de IDE e app).
O login usa a mesma conta do painel administrativo da Resgata.ai, por OAuth.

> **Estado em 06/11/2026: modo remoto em construção.** O servidor HTTP ainda não está liberado. O [modo local autorizado](docs/LOCAL.md) está disponível para um Mac provisionado pelo administrador; a demonstração usa dados sintéticos ([INSTALAR.md](INSTALAR.md) seção 8). Consulte o [catálogo](CATALOGO.md) para distinguir ferramentas disponíveis de capacidades futuras.

## O que já existe e o que é planejado

| | Situação |
|---|---|
| Plataforma por trás (API da Resgata, painel, atendimento, campanhas, cobrança) | Em produção. O MCP não cria regras novas: usa as que já existem. |
| Endereço do servidor (`https://mcp.resgata.ai/mcp`) | Planejado. Ainda não responde. |
| Login OAuth com a conta do painel | Incremento 1: pronto no modo demonstração, aguarda liberação. |
| Consultas (clientes, propostas, jornada, indicadores, campanhas, atendimento, saúde das integrações) | Incremento 1: pronto no modo demonstração, aguarda liberação. |
| Envio de e-mail por modelo a um cliente, com prévia | Incremento 1: pronto no modo demonstração (envio simulado), aguarda liberação. |
| "Chame o cliente X e fale Y" por WhatsApp, SMS e e-mail; pedir à Agente Rê para retomar um atendimento | Planejado para o incremento 2. |
| Campanhas, cobrança, acompanhamentos ("acompanhe por 3 dias"), rotinas e alertas | Planejado para o incremento 3. |
| Respostas técnicas registradas por CPF/cliente | Disponíveis no modo local autorizado: HTTP, corpo sanitizado, erro e correlação. |
| Diagnóstico completo de provedores, custos por anúncio, relatórios, CRM, voz | Entrega incremental; capacidades restantes planejadas. |
| Modo demonstração com dados sintéticos, para testar sem conta | Disponível: `bun run dev:demo` ([INSTALAR.md](INSTALAR.md) seção 8). |

## Ordem de entrega

1. Login OAuth pelo painel admin, consultas essenciais e comandos diretos por canal, com prévia e auditoria.
2. Atendimento com o Chatwoot e a Agente Rê, comando "chame o cliente" em todos os canais, jornada completa do cliente.
3. Acompanhamentos, rotinas e central de execuções; campanhas e cobrança.
4. Diagnóstico de conversão, de custos e de provedores, atribuição e recomendações.

A ordem não tira nada do escopo: o MCP só será chamado de completo quando tudo estiver entregue.

## Capacidades (objetivo final)

- **Dados e relatórios:** clientes, propostas, jornada (de onde o cliente veio, até onde chegou, o que foi dito a ele),
  audiências, campanhas, indicadores, com busca, filtros, paginação e fonte de cada número.
- **Inteligência de negócio:** conversão por canal e anúncio, custo por canal, funil, desembolsos por período. Fatos
  calculados e insights de IA vêm sempre separados.
- **Comunicação:** e-mail, SMS e WhatsApp por modelo; pedir à Agente Rê para conduzir o atendimento; voz/URA quando
  liberada. Sempre com as regras de consentimento, bloqueio, horário e limite da plataforma.
- **Atendimento:** consultar conversas, atribuir, nota interna, transferir entre IA e humano, pausar e retomar a IA.
- **Execuções que continuam sozinhas:** campanhas, acompanhamentos e rotinas guardados no servidor, consultáveis depois,
  mesmo com a conversa fechada.
- **Diagnóstico:** saúde das integrações e dos provedores, investigação de uma tentativa de simulação.

Lista completa, por domínio e com o estado de cada ferramenta: [CATALOGO.md](CATALOGO.md).

## Segurança em linguagem simples

- **Você entra com a sua conta.** O cliente de IA nunca vê sua senha nem o cookie do painel. Ele recebe uma
  autorização própria, curta, que você pode desligar a qualquer momento.
- **Cada um vê só o que pode.** O servidor confere seu perfil e suas permissões em toda chamada. Ter acesso ao painel
  não libera o MCP automaticamente: o acesso é concedido por pessoa e por tipo de ação (leitura, contato, campanhas,
  cobrança, voz, automações).
- **Nada sai sem prévia.** Antes de enviar mensagem, criar campanha ou ligar, o MCP mostra o que vai acontecer.
  Repetir o mesmo pedido no mesmo dia não duplica o envio.
- **Mensagens de clientes são dados, não ordens.** Texto vindo de cliente, documento ou integração volta marcado como
  não confiável. O servidor não sabe se um pedido partiu de você ou de um texto que o modelo leu: por isso as ações com
  efeito pedem a sua aprovação no cliente de IA.
- **Dados pessoais protegidos.** CPF, telefone, e-mail e CEP aparecem mascarados por padrão. Use só em contas de
  trabalho aprovadas pela Resgata.
- **Tudo é auditado**, sem gravar senhas, tokens ou conteúdo de mensagens.

Detalhes e como reportar uma vulnerabilidade: [SECURITY.md](SECURITY.md).

## Instalação

Para uso restrito a um Mac autorizado, existe também o [modo local por identidade da máquina](docs/LOCAL.md), sem depender do servidor HTTP remoto. Ele exige provisionamento pelo administrador e mantém o gate de acesso da API.

Veja [INSTALAR.md](INSTALAR.md). Resumo, para quando o servidor estiver no ar:

```bash
# Claude Code
claude mcp add --transport http --scope user resgata https://mcp.resgata.ai/mcp && claude mcp login resgata

# Codex (CLI, extensão de IDE e app usam a mesma configuração)
codex mcp add resgata --url https://mcp.resgata.ai/mcp && codex mcp login resgata
```

No Claude.ai e no Claude Desktop, o servidor entra como conector personalizado (passo a passo no guia).

## O que este repositório contém, e o que não contém

Contém o servidor MCP, a documentação, o catálogo, exemplos e um modo de demonstração com dados sintéticos.

Não contém, e nunca vai conter: senhas, chaves, tokens, dados de clientes, endereços internos, configuração de
infraestrutura de produção ou regras de negócio da plataforma. As regras ficam na API da Resgata, que é a fonte de
verdade, e a segurança do serviço não depende de o código ser fechado.

Antes de cada envio ao repositório roda uma verificação automática de segredos e de dados pessoais (gitleaks com
regras próprias).

Para desenvolver ou testar localmente com dados sintéticos: [docs/DESENVOLVIMENTO.md](docs/DESENVOLVIMENTO.md).

## Direitos

Copyright (c) 2026 Resgata.ai. Todos os direitos reservados. O código é público para transparência e para facilitar a
instalação. Isso não concede licença de uso, cópia ou redistribuição. Texto completo em [LICENSE](LICENSE).
