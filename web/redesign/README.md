# 🎨 Redesign — SuXen Edition

Prototipação de novas landing pages e dashboard para o Financas AI.

## Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `index.html` | **Conta na Mão** — Landing principal (versão recomendada) |
| `index-grana-facil.html` | **Grana Fácil** — Variação de nome mais direta |
| `index-roio.html` | **Roiô** — Variação ousada/marcante |
| `dashboard.html` | **Dashboard v2** — UX repensada, mobile-first, zero fricção |

## Instruções

1. Abrir os HTMLs direto no navegador (CDN Tailwind carrega via script tag)
2. Landing pages linkam para o dashboard atual (`jryans-system.github.io`)
3. Dashboard v2 é protótipo visual (não conecta Firebase ainda)
4. **Nada aqui altera o funcional existente**

## Para reverter

```bash
git checkout main
git branch -D feat/suxen-landing-redesign
git push origin --delete feat/suxen-landing-redesign
```
