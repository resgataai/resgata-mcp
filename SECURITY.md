# Segurança do MCP da Resgata.ai

> O servidor ainda não está no ar (06/11/2026). Este documento descreve o modelo que está sendo construído. Cada item
> diz entre colchetes em qual incremento entra: **[Inc. 1]**, **[Inc. 2]** etc. Nada aqui vale antes de ser entregue.

## Reportar uma vulnerabilidade

**Não abra issue pública.** Use **Security → Report a vulnerability** neste repositório (relato privado do GitHub).
Responderemos por lá.

Inclua, se puder: o que encontrou, como reproduzir, o impacto que você enxerga e a versão (SHA) do código. Não inclua
dados de clientes.

Pedimos que você:

- não teste contra o servidor de produção com contas que não são suas, nem tente acessar dados de terceiros;
- não faça testes que degradem o serviço (carga, negação de serviço);
- use o modo demonstração local, com dados sintéticos, para reproduzir problemas sempre que possível;
- nos dê tempo para corrigir antes de divulgar.

Em troca, não tomaremos medida contra pesquisa feita de boa-fé dentro dessas regras. Prazos de resposta e
reconhecimento público serão publicados aqui quando definidos.

Segredo publicado por engano neste repositório também é vulnerabilidade: relate pelo mesmo canal.

## Modelo de autorização

1. **[Inc. 1] Login com a conta da pessoa.** O cliente de IA (Claude, Claude Code, Codex) abre o navegador na tela de
   login da Resgata. O cliente de IA nunca recebe a senha nem o cookie do painel. Toda nova conexão passa pelo login
   (só aproveita um login feito nos últimos 5 minutos).
2. **[Inc. 1] Consentimento explícito, sempre.** Depois do login, o MCP mostra qual aplicativo pede acesso, para onde a
   autorização volta e o que poderá ser feito. A tela aparece em toda nova conexão (nunca é "lembrada") e avisa: só
   aprove se você acabou de clicar em Conectar. Cada conexão nova aparece no seu perfil do painel.
3. **[Inc. 1] Lista fechada de aplicativos.** Só são aceitos os documentos de identidade (*Client ID Metadata
   Document*) publicados pela Anthropic e pela OpenAI para o Claude, o Claude Code e o Codex. Não há registro aberto de
   aplicativos. Isso identifica o aplicativo, **não garante qual programa roda no seu computador**: o documento de um
   aplicativo local é público, e qualquer programa local pode se apresentar com ele. Por isso o consentimento e o aviso
   de "aplicativo no seu computador" importam.
4. **[Inc. 1] Autorização própria e curta.** O MCP emite um token próprio, válido por 10 minutos, preso a este
   servidor, com renovação rotativa. Um token de renovação reaproveitado depois de 30 segundos revoga a autorização
   inteira (a janela curta evita derrubar duas sessões que renovam ao mesmo tempo).
5. **[Inc. 1] Sem repasse de token.** O token recebido do cliente de IA nunca é repassado à API da Resgata. Para
   consultar a plataforma, o MCP usa outra credencial, emitida para ele pelo provedor de identidade da Resgata.
6. **[Inc. 1] Permissões por tipo de ação.** Acesso ao MCP é concedido por pessoa, separado do acesso ao painel. Tipos:

   | Permissão | Permite |
   |---|---|
   | `resgata:read.bi` | Indicadores e dados agregados, sem registro de cliente |
   | `resgata:read.clientes` | Consultas de clientes, propostas e conversas, com dados pessoais mascarados |
   | `resgata:pii` | Ver CPF, telefone e e-mail completos (cada uso é auditado) |
   | `resgata:export` | Gerar exportações (o arquivo fica no painel, não na conversa) |
   | `resgata:contact` | Contatar clientes e pedir à Agente Rê para conduzir o atendimento |
   | `resgata:attendance` | Atribuir, anotar, transferir e pausar a IA no atendimento |
   | `resgata:campaigns` | Audiências e campanhas |
   | `resgata:billing` | Cobrança |
   | `resgata:voice` | Ligações e URA |
   | `resgata:automation` | Automações, réguas, rotinas e monitoramentos |
   | `resgata:crm.write` | Alterações cadastrais e de CRM |
   | `resgata:diagnostics.cpf` | Investigação por CPF ou tentativa de simulação |
   | `resgata:reprocess` | Reprocessamentos elegíveis |

   Ainda não existe restrição por equipe ou carteira: quem tem `read.clientes` consulta qualquer cliente.
7. **Quem confere o quê.** [Inc. 1] As permissões da IA (a tabela acima) são impostas **pelo MCP** em toda chamada; a
   lista de ferramentas mostra só o que a pessoa pode usar. A API da Resgata impõe os papéis da pessoa e as regras de
   negócio, e só aceita do MCP as operações de uma lista aprovada. [Inc. 2] A API passa a conferir também as permissões
   aprovadas no consentimento (dupla checagem).
8. **Revogação e bloqueio.** [Inc. 1] A pessoa desconecta pelo painel; o efeito chega em até 30 segundos. Desativar a
   conta, mudar o perfil, redefinir a senha ou excluir o usuário pelo painel revoga todas as autorizações dela, em até
   30 segundos. Se o bloqueio ou a retirada de permissão for feito direto no provedor de identidade, o efeito chega em
   até 5 minutos. A desconexão pelo próprio cliente de IA deve revogar no servidor; isso será confirmado no aceite e
   publicado no guia.

## Ações com efeito externo

Mensagens, campanhas, ligações e reprocessamentos não podem ser desfeitos. Por isso:

- **[Inc. 1] planejar e executar são passos separados.** A ferramenta de planejamento mostra público, exclusões,
  conteúdo, canal, horário, quantidade, custo quando houver fonte e o que é irreversível, sem efeito nenhum. A execução
  só aceita o plano emitido para a mesma pessoa, dentro da validade;
- **[Inc. 1] repetir não duplica.** A chave de idempotência vem do conteúdo (pessoa, cliente, canal, modelo e dia):
  repetir ou reformular o mesmo pedido no mesmo dia devolve o mesmo envio. Reenviar de propósito exige pedir
  explicitamente;
- **[Inc. 1] valem as regras da plataforma:** consentimento, descadastro, horários de contato, limites por canal e
  travas operacionais; [Inc. 2] atendimento humano em curso;
- **tetos:** [Inc. 1] limite de efeitos por pessoa por dia; [Inc. 3] volume e custo por execução, e acima do teto a
  aprovação é feita por uma pessoa no painel, fora do alcance da IA;
- **[Inc. 1] sem atalhos:** o MCP não oferece SQL, shell, acesso à infraestrutura nem leitura de segredos.

## Dados não confiáveis (injeção de instruções)

Mensagens de clientes, nomes e e-mails cadastrados, parâmetros de campanha, textos de indicação, respostas de
provedores e qualquer texto vindo de integração são **dados de terceiros**. O que o servidor faz [Inc. 1]:

- devolve esse conteúdo marcado como não confiável, com tamanho limitado e sem caracteres de controle, e as descrições
  das ferramentas avisam o modelo disso;
- marca as ferramentas de execução como destrutivas, para o seu cliente de IA pedir confirmação;
- não aceita endereço (URL) como argumento nem busca páginas apontadas por conteúdo;
- [Inc. 2] quando a Agente Rê é acionada, ela recebe um objetivo de vocabulário fechado e referências a registros, nunca
  texto livre para obedecer; texto livre enviado a um cliente é recusado pela API se contiver CPF, e-mail, telefone ou
  endereço que não sejam do próprio destinatário.

O que o servidor **não** consegue fazer: saber se uma chamada partiu de você ou de um texto que o modelo leu. O mesmo
modelo chama o planejamento e a execução. **A confirmação humana acontece no seu cliente de IA**: deixe as ferramentas
de execução com aprovação a cada uso (veja o guia de instalação) e leia o plano antes de aprovar.

## Dados pessoais

`diagnostico_cpf` exige leitura de clientes, diagnóstico e PII em conjunto. Retorna somente o corpo de resposta registrado e sanitizado, o erro e metadados da chamada, nunca requisições, cabeçalhos de autenticação ou segredos. O corpo pode conter campos de negócio do provedor e é marcado como conteúdo externo não confiável. Esse acesso não libera transcrições nem ações externas. Mensagens técnicas não são gravadas na auditoria.

- [Inc. 1] CPF, telefone, e-mail e CEP aparecem mascarados por padrão, também dentro de textos. Ver completo exige
  permissão específica e fica registrado.
- [Inc. 1] Conta bancária, renda e endereço não são devolvidos por padrão. Transcrições de conversas só são liberadas
  depois da decisão da Resgata sobre o uso de clientes de IA de terceiros.
- [Inc. 1] Consultas com termo pessoal (CPF, nome, telefone) vão no corpo da requisição, nunca no endereço. Buscas de
  texto livre em conversas e em registros de provedores não são oferecidas.
- [Inc. 4] Exportações viram arquivo no painel, com finalidade registrada, em vez de entrar na conversa.
- O conteúdo que uma ferramenta devolve passa a fazer parte da conversa no seu cliente de IA (Anthropic ou OpenAI). Use
  o MCP **só em contas de trabalho aprovadas pela Resgata**. A lista de planos aceitos será publicada aqui antes da
  liberação.

## Auditoria

[Inc. 1] Cada chamada de ferramenta, inclusive as negadas, gera um registro com: quem, qual aplicativo, qual
ferramenta, qual alvo (identificadores, não dados pessoais), parâmetros relevantes, horário, resultado e um
identificador de correlação que liga a chamada ao que aconteceu na plataforma. Também são registrados login,
consentimento, renovação, revogação e bloqueio. Se o registro falhar, a ação com efeito não é executada.

Nunca são registrados: senhas, tokens, códigos de autorização, segredos, conteúdo de mensagens ou dados brutos de
provedores. CPF, telefone e e-mail aparecem nos registros do MCP só como resumo criptográfico.

## Isolamento

- [Inc. 1] Cada requisição é independente; nada de uma pessoa fica em memória compartilhada com outra.
- [Inc. 1] Cursores de paginação e planos são assinados e presos à pessoa e à autorização; usados por outra pessoa, são
  recusados.
- [Inc. 1] A API da Resgata só aceita do MCP as operações de uma lista aprovada; o resto é negado por padrão.
- [Inc. 3] Rotinas e execuções criadas por uma autorização revogada como "uso indevido" são pausadas.

## Código público

Este repositório é público. A segurança do serviço **não depende** de o código ser fechado: a lista de aplicativos
aceitos, o formato dos tokens e as regras de autorização são públicos por desenho. O que protege o serviço são as
chaves (fora deste repositório) e as conferências feitas no servidor.

- Segredos, credenciais, dados pessoais, endereços internos e configuração de produção nunca entram aqui.
- Verificação de segredos e de dados pessoais (gitleaks com regras próprias) antes de cada commit e de cada push, e
  proteção de envio de segredos do GitHub.
- Dependências com versão exata, arquivo de travamento e instalação sem scripts.
- Só código revisado e integrado à `main` é publicado em produção, construído num ambiente isolado.
- Contribuições externas são lidas e reescritas pela equipe; o código de terceiros não é executado diretamente.
