# Respostas técnicas por cliente

Pedido: exibir o retorno registrado do provedor em vínculos, simulação e demais operações, vinculando cliente e eventos para investigar interrupções da Jornada.

Abordagem: reutilizar POST /v2/users/lookup, já permitido ao MCP, que retorna timeline com rawPayload sanitizado. Adicionar diagnostico_cpf (CPF ou UUID) com permissões de leitura de cliente, diagnóstico e PII; retornar somente resposta, erro e metadados de chamada, sem requisição nem credenciais. Expor também os detalhes de erro/técnicos que cliente_jornada já recebe e descartava. Não confundir último erro com causa comprovada de abandono.

- [ ] Testar resposta literal, correlação, ausência de corpo, HTTP200 com recusa de negócio, paginação e negação por escopo.
- [ ] Implementar ferramenta e sanitização de segredos; preservar explicitamente limites da captura/fonte.
- [ ] Atualizar catálogo, fixtures, manifesto MCP e metadados da cópia da allowlist na API. Rotas/métodos e OpenAPI permanecem iguais.
- [ ] Rodar suíte, tipos, lint, build, catálogo, drift e revisão independente.
- [ ] Integrar por PRs irmãos, instalar no checkout canônico e validar leitura real sem efeitos externos.
