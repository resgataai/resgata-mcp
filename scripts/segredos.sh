#!/bin/sh
# gitleaks com as regras próprias: histórico inteiro (repositório pequeno) e árvore de trabalho.
set -eu
cd "$(dirname "$0")/.."
command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks não encontrado (exigido pelo gate)" >&2; exit 1; }
if git rev-parse --git-dir >/dev/null 2>&1; then
  gitleaks git --no-banner --redact -c .gitleaks.toml .
fi
gitleaks dir --no-banner --redact -c .gitleaks.toml .
