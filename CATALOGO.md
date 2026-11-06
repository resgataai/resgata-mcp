# Catálogo de ferramentas

> **Modo remoto ainda não liberado (06/11/2026).** As ferramentas implementadas do incremento 1 também podem ser usadas no [modo local autorizado](docs/LOCAL.md), conforme permissões e gates. O diagnóstico técnico por cliente exige `read.clientes`, `diagnostics.cpf` e `pii`. Os incrementos futuros continuam planejados. Consulte `resgata_capacidades` para a disponibilidade do seu perfil.
>
> Transcrições em `atendimento_mensagens` continuam condicionadas à liberação específica. Envios exigem prévia, permissão e gates da plataforma; não são liberados pela consulta técnica.

Legenda do tipo:
- **Leitura:** só consulta.
- **Escrita interna:** grava algo na plataforma sem falar com cliente (ex.: criar audiência, agendar rotina).
- **Efeito externo:** fala com cliente, provedor ou telefone. Sempre em dois passos: `*_planejar` (prévia, sem efeito)
  e `*_executar` (com o plano). Não pode ser desfeito.

Permissões sem o prefixo `resgata:` (ver [SECURITY.md](SECURITY.md)). `acesso` = qualquer conexão válida; `read.bi` =
indicadores e agregados; `read.clientes` = registros de clientes e conversas. Dados pessoais vêm mascarados, salvo com
`pii`. Ferramentas de execução são marcadas como destrutivas: deixe-as com aprovação a cada uso no seu cliente de IA.

## Conta e ajuda

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `resgata_quem_sou` | Seu nome, perfil, permissões e validade da autorização | Leitura | `acesso` | Inc. 1 — pronta no modo demonstração |
| `resgata_capacidades` | Busca no catálogo: o que você pode fazer, o que não pode e por quê, com exemplos | Leitura | qualquer | Inc. 1 — pronta no modo demonstração |
| `auditoria_minhas_acoes` | O que você fez pelo MCP, por período (só as suas ações) | Leitura | `acesso` | Inc. 1 — pronta no modo demonstração |
| `resgata_novidades` | O que mudou desde a última conversa: execuções concluídas, falhas, alertas | Leitura | `acesso` | Inc. 3 — planejada |

## Clientes e jornada

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `clientes_buscar` | Encontra cliente por CPF, e-mail ou telefone; com homônimos, pede o dado mínimo em vez de escolher | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração (busca por nome no Inc. 2) |
| `cliente_dossie` | Resumo do cliente: cadastro, propostas, finanças, conversas, comunicações, possíveis duplicidades | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `cliente_linha_do_tempo` | Eventos do cliente em ordem, com fonte e horário | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `jornada_listar` | A lista da página Jornada do painel, com os mesmos filtros (período, produto, resultado, erro, status, canal, origem) | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `cliente_jornada` | De onde o cliente veio, até onde chegou, tentativas, erros, o que foi dito a ele; lacunas explícitas | Leitura | `read.clientes` | Inc. 1 em parte; completa no Inc. 2 |
| `cliente_o_que_foi_feito` | Tudo o que campanhas, réguas, cobrança, Agente Rê e o MCP fizeram com o cliente | Leitura | `read.clientes` | Inc. 3 — planejada |
| `cliente_proxima_acao` | Próxima ação sugerida, com justificativa e restrições (marcada como sugestão de IA) | Leitura | `read.clientes` | Inc. 4 — planejada |
| `crm_planejar` / `crm_executar` | Alterar contato, endereço, tags, notas, responsável, preferências | Escrita interna | `crm.write` | Inc. 4 — planejada |

## Propostas

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `propostas_buscar` | Busca com filtros, facetas e paginação | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `proposta_detalhe` | Situação, provedor, valores e link para o painel | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |

## Indicadores e relatórios

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `bi_hoje` | Painel do dia | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração |
| `bi_conversao` | Funil, conversão por canal e aquisição, gargalos | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração |
| `bi_canais_custos` | Custo e retorno por canal; gasto de anúncios aparece como lacuna enquanto não houver integração | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração (custo por anúncio no Inc. 4) |
| `bi_desembolsos` | Volume e valor desembolsados no período | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração |
| `bi_comparar_periodos` | Comparação entre períodos e segmentos, com definições | Leitura | `read.bi` | Inc. 4 — planejada |
| `bi_insights_ia` | Insights gerados por IA, separados dos fatos | Leitura | `read.bi` | Inc. 4 — planejada |
| `relatorio_salvar` / `relatorio_executar` / `relatorio_agendar` | Filtros salvos e relatórios recorrentes | Escrita interna | `read.bi` (agendar: `automation`) | Inc. 4 — planejada |
| `dados_exportar` | Exportação com finalidade; o arquivo fica no painel | Escrita interna | `export` | Inc. 4 — planejada |

## Audiências e campanhas

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `audiencias_listar` / `audiencia_detalhe` | Audiências existentes e sua definição | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração |
| `audiencias_campos` / `audiencias_previa` | Campos disponíveis e prévia (quantidade e exclusões) de uma audiência descrita em português | Leitura | `read.bi` | Inc. 3 — planejada |
| `audiencias_criar` / `audiencias_editar` | Criar ou editar audiência | Escrita interna | `campaigns` | Inc. 3 — planejada |
| `audiencia_por_que_entrou` | Por que um cliente entrou numa audiência | Leitura | `read.clientes` | Inc. 4 — planejada |
| `selecao_operacional_previa` / `selecao_operacional_salvar` | "Clientes sem atendimento ontem", "clientes que receberam o erro X": encontrados, elegíveis, excluídos e motivos | Leitura / escrita interna | `read.clientes` / `campaigns` | Inc. 3 — planejada |
| `campanhas_listar` / `campanha_resultados` | Campanhas e resultados (entrega, falha, rejeições, economia) | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração |
| `campanha_planejar` / `campanha_executar` | Criar e disparar ou agendar campanha | Efeito externo | `campaigns` | Inc. 3 — planejada |
| `campanha_controlar` | Pausar, retomar, cancelar, reagendar | Efeito externo | `campaigns` | Inc. 3 — planejada |

## Contato com clientes

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `modelos_listar` | Modelos aprovados por canal, com variáveis e prévia | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração (WhatsApp no Inc. 2) |
| `contato_planejar` / `contato_executar` | "Mande o modelo X para o cliente Y" e "chame o cliente X e fale Y"; envio direto ou atendimento conduzido pela Agente Rê | Efeito externo | `contact` (voz: `voice`) | Inc. 1: e-mail por modelo. Inc. 2: WhatsApp, SMS, texto e Agente Rê. Inc. 4: voz |
| `contato_status` | Situação do envio: aceito, enviado, entregue, respondido, concluído ou impedido (com motivo) | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração (estados completos no Inc. 2) |
| `contato_cancelar` | Cancela o que ainda não saiu | Efeito externo | `contact` | Inc. 2 — planejada |

## Atendimento (Chatwoot e Agente Rê)

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `atendimento_conversas` | Conversas de um cliente já identificado ou da fila: status, caixa, responsável, rótulos (sem busca de texto) | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `atendimento_mensagens` | Mensagens da conversa (marcadas como conteúdo não confiável); liberada só após a decisão da Resgata sobre dados em clientes de IA | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `atendimento_fila` | Quantas conversas pedem atenção | Leitura | `read.clientes` | Inc. 1 — pronta no modo demonstração |
| `atendimento_acao_planejar` / `atendimento_acao_executar` | Atribuir, nota interna, rótulo, transferir IA ↔ humano, pausar ou retomar a IA | Efeito no atendimento | `attendance` | Inc. 2 — planejada |

## Cobrança

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `cobranca_dossie` | Situação, parcelas, histórico e próximos passos, com fatos e sugestões separados | Leitura | `read.clientes` | Inc. 2 — planejada |
| `cobranca_parametros` | Consultar e ajustar parâmetros autorizados da régua | Escrita interna | `billing` | Inc. 3 — planejada |
| `cobranca_planejar` / `cobranca_executar` | Acionar cliente com mensagem de cobrança; quem pagou depois da seleção é excluído | Efeito externo | `billing` | Inc. 3 — planejada |

## Execuções, acompanhamentos e rotinas

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `execucoes_listar` / `execucao_status` | Progresso, contadores, falhas parciais | Leitura | `read.bi` | Inc. 3 — planejada |
| `execucao_cancelar` / `execucao_retomar` | Parar os próximos efeitos; retomar só o que falhou | Efeito externo | conforme o tipo | Inc. 3 — planejada |
| `acompanhamento_criar` / `acompanhamento_status` | "Acompanhe por 3 dias e me traga o resultado", com regra de atribuição explícita | Escrita interna / leitura | `read.bi` | Inc. 3 — planejada |
| `rotina_criar` / `rotinas_listar` / `rotina_controlar` | Rotinas por horário ou evento, com teto, validade e pausa | Escrita interna | `automation` | Inc. 3 — planejada |
| `automacoes_listar` / `automacao_planejar` / `automacao_executar` | Automações e réguas: consultar, ativar, pausar, alterar | Efeito externo | `automation` | Inc. 3 — planejada |

## Diagnóstico

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `diagnostico_saude` | Saúde da plataforma, do atendimento e dos provedores bancários | Leitura | `read.bi` | Inc. 1 — pronta no modo demonstração |
| `diagnostico_provedor` | "O que está acontecendo no provedor X?": situação, taxa de erro, latência e uma classificação com volume e confiança ("indeterminada" quando há poucos dados); resolve apelidos e pergunta antes de investigar; sem busca por texto ou CPF | Leitura | `read.bi` | Inc. 1 básico; completo no Inc. 4 (por operação, último sucesso, afetados, causa provável) |
| `diagnostico_cpf` | Resposta registrada (JSON/texto), erro, HTTP, operação, horário, evento e grupo/job por CPF ou UUID. Credenciais removidas; fonte limitada aos 200 eventos recentes. Não prova causa de abandono | Leitura | `read.clientes` + `diagnostics.cpf` + `pii` | Disponível no modo local autorizado; análise completa da jornada continua incremental |
| `diagnostico_monitorar` / `diagnostico_incidentes` | Avisar quando um provedor degradar ou normalizar; histórico | Escrita interna / leitura | `automation` / `read.bi` | Inc. 4 — planejada |
| `reprocessar_planejar` / `reprocessar_executar` | Reprocessar eventos tecnicamente elegíveis | Efeito externo | `reprocess` | Inc. 4 — planejada |

## Outras operações da plataforma

| Ferramenta | O que faz | Tipo | Permissão | Estado |
|---|---|---|---|---|
| `operacao_consultar` | Consultas da lista aprovada de operações da plataforma (produtos, provedores, fundos, bancos e outras), cada uma com campos de saída fixos | Leitura | `read.bi` | Inc. 4 — planejada |

## O que nunca estará no catálogo

SQL livre, comandos de sistema, acesso à infraestrutura, leitura de segredos, busca de endereços da internet, fusão
automática de cadastros e qualquer ação disparada por conteúdo recebido de cliente ou integração.

## Exemplos de pedidos

- "Quanto desembolsamos hoje? Compare com a mesma data da semana passada." (Inc. 1; comparação no Inc. 4)
- "Quais canais converteram mais nos últimos 30 dias e quanto custou cada um?" (Inc. 1)
- "Mostre a jornada do cliente com CPF terminado em 1234: de onde veio, até onde chegou e o que a IA falou." (Inc. 1 em parte)
- "Mande o modelo de boas-vindas por e-mail para este cliente." (Inc. 1)
- "Chame o João e diga que a proposta está disponível, pelo WhatsApp." (Inc. 2)
- "Peça à IA da Resgata para retomar esta proposta." (Inc. 2)
- "Crie uma audiência de quem teve proposta aprovada e não concluiu, dispare uma campanha por SMS e me traga os
  resultados." (Inc. 3)
- "Identifique os abandonos de ontem, acione os elegíveis e acompanhe por três dias." (Inc. 3)
- "Por que o provedor bancário parou de simular hoje?" (Inc. 1 básico; completo no Inc. 4)
- "Mostre a resposta técnica registrada do provedor para este CPF." (modo local autorizado)
