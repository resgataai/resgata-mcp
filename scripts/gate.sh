#!/bin/sh
# Gate local do resgata-mcp (substitui o CI; o release refaz no Cloud Build). Para no primeiro erro.
set -eu
cd "$(dirname "$0")/.."
passo() { printf '\n== %s\n' "$1"; }

passo "dependências (lockfile congelado, sem scripts)"
bun install --frozen-lockfile --ignore-scripts
passo "segredos (gitleaks: histórico e árvore)"
sh scripts/segredos.sh
passo "nomes proibidos"
bun scripts/nomes-proibidos.ts
passo "lint (biome)"
bun run lint
passo "tipos (tsc)"
bun run tipos
passo "testes (vitest)"
bun run test
passo "catálogo de ferramentas × manifesto"
bun run catalogo:check
passo "drift contra a OpenAPI da V2 (recorte versionado)"
bun run drift:v2
printf '\ngate ok\n'
