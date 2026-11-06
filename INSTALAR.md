# Instalar o MCP da Resgata.ai

> **Ainda não está no ar e não pode ser instalado (06/11/2026).** Este guia fica pronto para quem for instalar depois,
> quando o primeiro incremento for liberado. Até lá, `https://mcp.resgata.ai/mcp` não responde, os comandos abaixo vão
> falhar na hora do login e nenhum acesso está sendo concedido. O aviso sai daqui quando o servidor entrar no ar.

Comandos e menus conferidos em 06/11/2026 nas documentações oficiais e na ajuda local (`--help`) do Claude Code 2.1.319
e do Codex CLI 0.162.1. Ainda **não** foram testados contra o servidor, que não existe; o teste ponta a ponta acontece
no aceite e este guia será atualizado com o resultado. Fontes no fim da página.

## 1. Antes de começar

Você precisa de:

1. **Conta no painel administrativo da Resgata.ai** (o mesmo usuário e senha do painel).
2. **Acesso ao MCP liberado para a sua conta.** Ter acesso ao painel não basta: um administrador da Resgata libera o
   MCP e escolhe o que você pode fazer (leitura, contato com clientes, campanhas, cobrança, voz, automações). Peça ao
   administrador da Resgata responsável pelo seu acesso ao painel.
3. **Um cliente de IA compatível, numa conta de trabalho aprovada pela Resgata.** O que as ferramentas devolvem passa
   a fazer parte da conversa no fornecedor de IA (Anthropic ou OpenAI). A lista de planos aceitos será publicada aqui
   antes da liberação; a recomendação em análise é aceitar só planos corporativos (Claude Team/Enterprise, ChatGPT
   Business/Enterprise). Não use conta pessoal.
   - Claude.ai, Claude Desktop ou o app móvel do Claude;
   - Claude Code (use uma versão recente; comandos conferidos em 2.1.319);
   - Codex CLI, extensão do Codex na IDE ou app (comandos conferidos em 0.162.1).
4. **Navegador** na mesma máquina, para o login.

Endereço do servidor: **`https://mcp.resgata.ai/mcp`** (exatamente assim, sem barra no fim).

## 2. Escolha o seu cliente

### 2.1 Claude.ai, Claude Desktop e app móvel

O conector é configurado uma vez na conta e aparece no Claude.ai, no Desktop e no app móvel. Se você usa o Claude Code
logado com a mesma assinatura, ele também aparece lá (como "claude.ai Resgata").

**Plano Team ou Enterprise.** Quem adiciona é o Owner da organização (ou, no Enterprise, quem tiver permissão de gerenciar
as bibliotecas da organização):

1. Abra **Organization settings → Connectors** (https://claude.ai/admin-settings/connectors).
2. Clique em **Add** e depois em **Custom**. Se perguntar o tipo, escolha **Web**.
3. Em **MCP server URL**, informe `https://mcp.resgata.ai/mcp`.
4. Em **Authentication**, escolha **Sign in now**.
5. Em **OAuth client**, escolha **Use Claude's published identity**. Não informe client ID nem segredo.
6. Clique em **Add**.

Depois, cada pessoa:

1. Abra **Customize → Connectors** (https://claude.ai/customize/connectors).
2. Encontre o conector **Resgata**, com o rótulo **Custom**.
3. Clique em **Connect** e faça o login (seção 3).

**Plano individual (Free, Pro, Max ou Ultra)**, só se a Resgata aprovar esse plano (seção 1). Cada pessoa adiciona na
própria conta:

1. Abra **Customize → Connectors**.
2. Clique em **Add custom connector**.
3. Informe a URL `https://mcp.resgata.ai/mcp`.
4. Em **OAuth client** (pode estar em **Advanced settings**), escolha **Use Claude's published identity**.
5. Clique em **Add** e depois em **Connect**.

As opções de autenticação não podem ser mudadas depois. Para mudar, remova o conector e adicione de novo.

Para usar numa conversa: botão **+** → **Connectors** → ligue **Resgata**.

**Aprovação das ações:** se o seu plano permitir escolher a permissão de cada ferramenta do conector, deixe as
ferramentas que terminam em `_executar` como **aprovação a cada uso** (a disponibilidade dessa opção será confirmada no
aceite).

### 2.2 Claude Code (terminal)

Rode uma vez no terminal:

```bash
claude mcp add --transport http --scope user resgata https://mcp.resgata.ai/mcp && claude mcp login resgata
```

- `--scope user` deixa o servidor disponível em todos os seus projetos. A configuração fica em `~/.claude.json`.
- `claude mcp login resgata` abre o navegador para o login. Também dá para fazer de dentro do Claude Code: digite
  `/mcp`, escolha **resgata** e depois **Authenticate**.
- Se o seu conector do Claude.ai já aparece no Claude Code, você não precisa deste passo; não adicione os dois (o Claude
  Code trata o mesmo endereço como duplicado).

Abra uma sessão nova do Claude Code depois de instalar.

**Aprovação das ações:** não coloque ferramentas `mcp__resgata__*_executar` na lista de permissões liberadas
(`permissions.allow`) e não use o MCP da Resgata em sessão com permissões ignoradas (modo *bypass*, como
`--dangerously-skip-permissions`). Assim o Claude Code pede a sua confirmação antes de cada ação com efeito.

### 2.3 Codex (CLI, extensão de IDE e app)

Rode uma vez no terminal:

```bash
codex mcp add resgata --url https://mcp.resgata.ai/mcp && codex mcp login resgata
```

O comando grava em `~/.codex/config.toml`:

```toml
[mcp_servers.resgata]
url = "https://mcp.resgata.ai/mcp"
```

Acrescente, logo abaixo, a linha que faz o Codex pedir a sua aprovação antes de ferramentas que alteram algo:

```toml
default_tools_approval_mode = "writes"
```

(Chave e valores `auto`, `prompt`, `writes` e `approve` conferidos no Codex 0.162.1; a documentação oficial ainda não
os descreve. Não rode o Codex com aprovações desligadas, como `--yolo`, ao usar o MCP da Resgata.)

A CLI, a extensão do Codex na IDE e o app do Codex leem esse mesmo arquivo: instalou numa, vale nas outras. Se a
extensão da IDE mostrar que o servidor precisa de login, rode `codex mcp login resgata` no terminal.

Numa máquina sem navegador, use `codex mcp login resgata --no-browser`: o Codex mostra o endereço de login e aceita o
endereço de retorno colado.

## 3. O "prompt único"

Se você prefere pedir ao seu agente, cole este texto no **Claude Code** ou no **Codex**:

> Instale o MCP da Resgata.ai para mim. No Claude Code, rode
> `claude mcp add --transport http --scope user resgata https://mcp.resgata.ai/mcp`; no Codex, rode
> `codex mcp add resgata --url https://mcp.resgata.ai/mcp`. Depois me peça para rodar no terminal
> `claude mcp login resgata` (no Codex: `codex mcp login resgata`) e fazer o login no navegador com a minha conta do
> painel admin da Resgata. No Codex, acrescente `default_tools_approval_mode = "writes"` na seção
> `[mcp_servers.resgata]` do `~/.codex/config.toml`.

Depois do login, **você** abre uma sessão nova do agente e pergunta "Quem sou eu na Resgata?". O agente não consegue abrir
outra sessão sozinho, e o login no navegador é sempre feito por você.

No Claude.ai e no Claude Desktop não há prompt: o conector é adicionado pela interface (seção 2.1).

## 4. O login no navegador

1. Abre a **tela de login da Resgata**. Entre com o usuário e a senha do painel administrativo (ou com o link de acesso
   por e-mail, se for o seu caso).
2. Abre a tela de **autorização do MCP da Resgata**, que mostra:
   - qual aplicativo está pedindo acesso (Claude, Claude Code ou Codex);
   - para onde a autorização volta. Se aparecer o aviso de que o aplicativo roda no seu computador, confira se foi você
     quem acabou de rodar o comando;
   - o que o aplicativo poderá fazer (por exemplo "consultar dados" e "contatar clientes"). Você só recebe o que o seu
     perfil permite;
   - por quanto tempo a autorização vale.
3. **Só clique em Autorizar se você acabou de clicar em Conectar (ou rodar o comando de login) neste aplicativo.** Se
   essa tela abriu por um link que alguém mandou, feche e avise o administrador. O navegador volta para o aplicativo.

Toda conexão nova aparece em **Perfil → Integrações de IA** no painel, com a data de criação. Se aparecer uma que você
não reconhece, desconecte marcando "Foi uso indevido".

Se a tela disser que você não tem acesso ao MCP, peça a liberação ao administrador da Resgata (seção 1).

## 5. Verificar que funcionou

- **Claude Code:** `claude mcp list` mostra `resgata` como conectado; dentro do Claude Code, `/mcp` mostra o estado.
- **Codex:** `codex mcp list`; dentro do Codex, `/mcp`.
- **Claude.ai:** em **Customize → Connectors**, o conector aparece como conectado.

Depois, em qualquer cliente, peça: **"Quem sou eu na Resgata?"**. A IA deve chamar `resgata_quem_sou` e mostrar seu
nome, seu perfil e o que você pode fazer. Peça também **"O que você consegue fazer na Resgata?"** para ver o catálogo
disponível para você.

## 6. Desconectar ou revogar

| Onde | Como | O que acontece |
|---|---|---|
| Claude Code | `claude mcp logout resgata` (ou `/mcp` → **Clear authentication**) | Apaga as credenciais locais e deve revogar a autorização no servidor (a confirmar no aceite). Para garantir, use o painel |
| Claude Code | `claude mcp remove resgata` | Só remove a configuração local. **Rode o `logout` antes** e confira no painel, senão a autorização pode continuar válida no servidor até expirar |
| Codex | `codex mcp logout resgata` e, se quiser, `codex mcp remove resgata` | Apaga as credenciais locais. A documentação do Codex não diz se o `logout` revoga no servidor: para garantir, use o painel |
| Claude.ai | **Customize → Connectors** → conector → **Remove** | Remove o conector da sua conta. Para revogar no servidor, use o painel |
| Painel administrativo | **Perfil → Integrações de IA → Desconectar** | Revoga no servidor qualquer autorização sua, em até 30 segundos. É o jeito mais garantido |

Se você perdeu o computador ou suspeita de uso indevido, use o painel (última linha), marque **"Foi uso indevido"** (isso
também pausa rotinas e execuções criadas por aquela conexão) e avise o administrador.

Quando um administrador bloqueia uma conta, muda o perfil, redefine a senha ou exclui o usuário pelo painel, todas as
autorizações daquela pessoa são revogadas em até 30 segundos. Se a mudança for feita direto no provedor de identidade,
o efeito chega em até 5 minutos.

A autorização vale até 30 dias sem uso e no máximo 90 dias (valores propostos, a confirmar). Depois disso, o cliente
pede o login de novo.

## 7. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| O login não abre ou dá erro de conexão | O servidor ainda não está no ar (veja o aviso no topo) ou rede corporativa bloqueando `mcp.resgata.ai` | Confira o aviso; teste abrir `https://mcp.resgata.ai/.well-known/oauth-protected-resource/mcp` no navegador |
| Pede login toda hora | Autorização revogada, conta bloqueada, mudança de perfil ou duas sessões renovando ao mesmo tempo | Faça o login de novo; se repetir, fale com o administrador |
| A tela de autorização aparece toda vez que você conecta | É proposital: a autorização nunca é lembrada | Confira o aplicativo e clique em Autorizar |
| "Você não tem acesso ao MCP" | Sua conta não tem o MCP liberado | Peça a liberação (seção 1) |
| Uma ferramenta não aparece | Seu perfil não inclui aquele tipo de ação, ou a ferramenta ainda não foi entregue | Pergunte "o que você consegue fazer na Resgata?"; veja o [catálogo](CATALOGO.md) |
| "Permissão insuficiente" | A ação pede uma permissão que você não tem | Peça ao administrador; depois faça logout e login para atualizar |
| "Indisponível por regra da plataforma" (ex.: voz desligada) | Uma trava operacional da Resgata está fechada | Não é erro do MCP; a trava é decidida pela operação |
| O navegador não volta para o Claude Code após o login | O retorno para o computador falhou | Copie o endereço completo da barra do navegador e cole no campo que o Claude Code mostra |
| Codex: erro de porta no retorno do login | Outra aplicação usa a porta escolhida | Rode `codex mcp login resgata` de novo; se persistir, fixe uma porta livre com `mcp_oauth_callback_port = <porta>` no `~/.codex/config.toml` |
| Erro com o endereço | Barra no fim ou endereço diferente | Use exatamente `https://mcp.resgata.ai/mcp` |
| `claude -p` (modo sem interface) não autentica | Esse modo não faz login OAuth | Faça o login antes, numa sessão interativa |
| Conector do Claude.ai aparece duplicado no Claude Code | Conector da conta e servidor local com o mesmo endereço | Mantenha só um (`claude mcp remove resgata` se preferir o da conta) |
| Ferramenta demora e cancela | Consultas grandes | Peça um período menor; operações longas devolvem um identificador para consultar depois |

Ao pedir ajuda, informe o cliente e a versão, o horário aproximado e a mensagem de erro (com o `request_id`, se
aparecer). **Nunca envie senha, token ou print com dados de clientes.**

## 8. Testar sem conta (modo demonstração)

Planejado para o incremento 1: rodar o servidor na sua máquina com dados 100% sintéticos e envios simulados, sem
nenhuma credencial (`bun run dev:demo`). As instruções entram aqui junto com o código.

## Fontes

- Claude, conector por URL: https://claude.com/docs/connectors/custom/remote-mcp
- Claude, autenticação de conectores: https://claude.com/docs/connectors/building/authentication
- Claude Code e MCP: https://code.claude.com/docs/en/mcp
- Codex e MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- Ajuda local dos clientes: `claude mcp --help`, `claude mcp add --help`, `codex mcp --help`, `codex mcp add --help`,
  `codex mcp login --help`
