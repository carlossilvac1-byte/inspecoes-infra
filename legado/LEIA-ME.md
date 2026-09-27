# Código legado — fora de uso

Estes arquivos são das versões anteriores do aplicativo, quando o destino da
sincronização era escolhido entre três backends. A partir da versão 2.0.0 o
destino é **único: Supabase** (Auth + PostgreSQL + Storage), porque só ele
resolve autenticação real, 10 usuários simultâneos e regras de acesso por lote
avaliadas no servidor.

| Arquivo | O que era |
|---|---|
| `sync-legado.js` | Adaptadores de SharePoint (Microsoft Graph) e Google Sheets/Drive |
| `apps-script.gs` | Web App do Google Apps Script que recebia os registros |

Nada aqui é carregado pelo `index.html` — a pasta existe só como referência,
caso um dia a obra precise voltar a gravar em uma Lista do SharePoint.

## A partir da versão 3.0.0

A sincronização foi retirada do aplicativo. O fluxo passou a ser: cada inspetor
guarda as próprias inspeções no aparelho, emite os PDFs para o dossiê e envia a
planilha mensal (tela **Exportar**).

Ficaram aqui, desativados mas íntegros:

| Arquivo | O que era |
|---|---|
| `sync.js` | fila de envio e adaptador do Supabase |
| `supabase.sql` | banco central: tabelas, gatilhos, RLS por lote e Storage |
| `sync-legado.js` | adaptadores de SharePoint e Google Sheets |
| `apps-script.gs` | Web App do Google Apps Script |

Para voltar a ter base central: reponha `sync.js` na pasta do app, devolva as
tags `<script src="sync.js">` no `index.html`, o bloco `supabase` e `sync` no
`config.js`, e troque em `auth.js` a função `modoLocal()` de `return true;`
para `return !configurado();`. O `auth.js` conserva todo o código do modo
servidor — login real, sessão de 30 dias, aprovação de cadastro e
administração remota.
