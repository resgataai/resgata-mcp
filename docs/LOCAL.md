# Codex local com identidade da máquina

Alternativa ao conector remoto para um Mac autorizado. Usa stdio, sem abrir porta HTTP e sem login interativo. O servidor remoto e seu OAuth continuam independentes.

O administrador provisiona uma identidade de serviço dedicada no Keycloak, com `clientId=resgata-mcp`, audience `resgata-api`, token de até cinco minutos e somente os papéis autorizados. Não reutilizar identidades existentes de outras integrações. O gate `APP_MCP_ACCESS_ENABLED` e a allowlist da V2 continuam obrigatórios; o processo testa `/v2/auth/me` antes de anunciar ferramentas.

O runtime lê um item de senha genérica do Keychain por `security find-generic-password`, com saída capturada. O valor é JSON codificado em base64 contendo `clientId`, `clientSecret`, `issuer`, `apiBase`, `subject` e `keys` (`plano`, `cursor`, `auditoriaHmac`, 32 bytes em base64url cada). Base64 não é cifra: a proteção vem do Keychain. Não coloque o conteúdo no terminal, config, ambiente, logs, repositório ou argumentos de processo.

Depois de buildar com `bun install --frozen-lockfile --ignore-scripts` e `bun run build`, configure **apenas no workspace**:

```toml
[mcp_servers.resgata]
command = "/caminho/para/node"
args = ["/caminho/para/resgata-mcp/dist/local/principal.js", "item-keychain", "conta-keychain", "/diretorio-privado/auditoria.jsonl"]
default_tools_approval_mode = "writes"
```

Use Node 22 conforme o `package.json`. O diretório da auditoria deve existir, pertencer ao operador e ter modo 0700; o arquivo é criado com 0600. Em macOS, a primeira leitura pode exigir autorização do Keychain. Nomes de item/conta e caminhos não são segredos.

## Permissões e auditoria

As ferramentas são as mesmas do catálogo existente. A assinatura e os claims do token são conferidos localmente; os escopos vêm dos papéis da identidade de serviço. A renovação ocorre antes de vencer e reavalia `MCP_ACCESS` e os demais papéis. Cada chamada revalida acesso e escopos; a API continua validando o token e as operações permitidas. A lista anunciada ao cliente é a da abertura da conexão; depois de mudar permissões, reconecte para atualizar a lista, mesmo que chamadas já sejam negadas pelos escopos novos.

Os parâmetros sanitizados das ferramentas são registrados em JSONL privado no Mac, com fsync antes de efeitos externos. Se essa gravação falhar, o efeito não começa. Essa auditoria adicional é **local**, não é o armazém OAuth nem o painel de auditoria central do conector remoto. A auditoria normal das operações da API continua no backend sob a identidade da máquina. Todas as pessoas que usarem este perfil local aparecem como essa mesma identidade; não há atribuição por pessoa.

`stdout` contém só protocolo MCP; diagnóstico vai a `stderr`. As ferramentas preservam prévia, idempotência, mascaramento e limites de consultas/efeitos. Este modo permite os efeitos já implementados no catálogo, sujeitos a papel e gates; não libera ferramentas planejadas de incrementos futuros. Não enviar mensagens reais para testar a instalação.

## Revogar e verificar

Desabilitar a identidade ou retirar seus papéis bloqueia novas emissões; tokens já emitidos podem continuar válidos por até cinco minutos. Para interromper imediatamente, pare o processo/conexão local. Remover o item do Keychain impede novas inicializações, mas não revoga um token já em memória. Rotacionar o segredo exige atualizar o item e reiniciar o MCP.

Abra uma nova sessão e peça “quem sou eu na Resgata?” e “quais ferramentas estão disponíveis?”. Valide identidade, permissões, catálogo e uma consulta de leitura limitada. Credencial inválida, gate fechado e API indisponível devem impedir inicialização. Não considere apenas a existência da configuração como prova de acesso.

## Retornos técnicos de provedores

Peça “mostre exatamente a resposta registrada do provedor para este CPF” ou use `diagnostico_cpf` com CPF/UUID. A identidade precisa de `read.clientes`, `diagnostics.cpf` e `pii`; não basta ter leitura genérica. O retorno inclui corpo JSON/texto, mensagem/código, HTTP, operação, horário e evento, grupo de simulação ou job de vínculos. `cliente_jornada` inclui erros, detalhes técnicos e regras de elegibilidade que a API já registrou.

A consulta reutiliza o lookup da API (até 200 eventos recentes). O corpo já pode ter sido sanitizado/limitado na captura; a ferramenta não reconstrói informação ausente. `resposta_presente=false` indica que não há corpo registrado, inclusive em timeout ou registros antigos. O limite de saída do MCP é 200 KiB: filtre por evento e reduza `limite` para respostas grandes. Não há busca arbitrária em logs, SQL ou reexecução de simulação.

Referência de transporte não é UUID de proposta. Chamadas de vínculos/simulação usam evento, grupo/job e o cliente como evidência; proposta só aparece quando confirmada. Um erro pode ter sido recuperado: compare a sequência da Jornada antes de concluir que ele causou abandono. Credenciais são removidas, dados pessoais continuam mascarados e todo conteúdo do provedor é dado de terceiros, nunca instrução.
