# Financas AI 📊

> Sistema financeiro inteligente para microempreendedores brasileiros.
> Descreva seu gasto em português — a IA classifica tudo automaticamente.

## Stack

| Componente | Tecnologia |
|---|---|
| **Auth** | Firebase Auth (Google Login) |
| **DB** | Firebase Firestore |
| **IA** | [9Router](https://protagrouter.squareweb.app) |
| **Front** | HTML + Chart.js (vanilla) |
| **Host** | GitHub Pages |

## Planos

| Plano | IA | Custo |
|---|---|---|
| **Free** | protagnix (9Router) | **R$ 0** |
| **Pro** | OpenCode | **R$ 19,90/mês** |

## Setup

```bash
# 1. Crie um projeto Firebase
# 2. Ative Authentication (Google) + Firestore
# 3. Copie as configs do Firebase pra web/index.html e web/dashboard.html
# 4. Faça deploy no GitHub Pages
```

## Estrutura

```
web/
├── index.html       → Landing page
├── dashboard.html   → Dashboard do usuário
database/
├── firestore.rules  → Regras de segurança
├── schema.md        → Estrutura dos dados
functions/
└── classify.js      → Integração 9Router
```

Feito com ☕ por [NixRyan](https://github.com/JBRYAN333)
