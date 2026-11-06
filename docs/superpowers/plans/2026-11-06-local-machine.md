# MCP local por identidade de máquina

> Execução na sessão atual, conforme aprovação do modelo local e do túnel temporário pelo responsável.

**Objetivo:** conectar o Codex local por stdio, sem login interativo, reutilizando as ferramentas e as validações da V2.

**Arquitetura:** identidade de serviço dedicada no Keycloak, segredo e chaves no Keychain, tokens de cinco minutos validados por assinatura/emissor/audience/cliente/subject. Sem porta HTTP local. As regras da API continuam valendo, inclusive o gate de acesso. Auditoria adicional das ferramentas em arquivo privado no Mac; a auditoria normal da API permanece no backend.

**Restrições:** configuração apenas no workspace da empresa; não reutilizar a SA owner do GCP; não contornar gates; não enviar mensagens de teste a clientes. O modo remoto existente permanece funcional.

## Plano

- [ ] Extrair o servidor de ferramentas e o executor de operações da V2 para permitir reutilização pelo transporte stdio, sem duplicar regras de negócio.
- [ ] Testar e implementar credencial de máquina: cache/renovação única, validação de claims, retirada de acesso, erros de credencial e nenhum segredo em logs/argv.
- [ ] Testar e implementar auditoria local privada e obrigatória antes de efeitos, usando os mesmos parâmetros sanitizados do servidor remoto.
- [ ] Implementar entrada stdio com leitura do Keychain, catálogo existente, permissões recalculadas e limites existentes. Documentar diferenças e revogação.
- [ ] Rodar a suíte completa, tipos, lint e build; fazer smoke pelo cliente MCP com dados sintéticos.
- [ ] Conferir o gate de produção e preparar a configuração mínima necessária pelo fluxo da API; só ativar o acesso conforme autorização explícita.
- [ ] Instalar o comando no Codex do workspace; validar identidade/catálogo/consulta limitada sem efeitos e encerrar o túnel temporário.

## Pontos de revisão

Credencial inválida ou revogada deve falhar fechada; perda de escopo deve impedir operação; retry não pode duplicar efeito; stdout deve conter apenas protocolo; falha de auditoria impede efeito e dados pessoais continuam mascarados. A existência da configuração não conta como prova de conexão.
