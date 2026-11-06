# Segurança

Encontrou uma vulnerabilidade? Não abra issue pública. Use **Security → Report a vulnerability** neste repositório, o relato privado do GitHub, e responderemos por lá.

Princípios do desenho:

- Toda chamada é autorizada no servidor com o login do usuário (OAuth pelo painel admin). O cliente de IA nunca recebe a senha nem o cookie do painel.
- Mensagens de clientes, documentos e respostas de integrações são tratados como dados, nunca como ordens.
- Ações com efeito externo (mensagens, campanhas, ligações) seguem as mesmas regras de consentimento, bloqueio e limites da plataforma, com prévia e proteção contra duplicidade.
- Toda ação é auditada, sem gravar segredos nem dados pessoais desnecessários.
