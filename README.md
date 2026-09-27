# Inspeções - Infra | EDP Transmissão Construção

Aplicativo web instalável (PWA) para registro de inspeções de canteiros,
alojamentos, cozinhas/refeitórios e áreas de vivência — **EDP TRANSMISSÃO
CONSTRUÇÃO** — com funcionamento integral **sem internet**.

Versão 3.2.0 — sem servidor. Cada inspetor guarda as próprias inspeções no
aparelho, emite os PDFs para o dossiê e envia a planilha mensal.

## Comece por aqui (2 minutos)

1. Duplo clique em `iniciar-servidor.bat` (ou publique a pasta em HTTPS).
2. Na tela de login, toque em **Criar cadastro**, preencha e envie.
3. Pronto — você já está dentro, registrando inspeções.

Não há nada para configurar: sem banco de dados, sem chave de API, sem
aprovação. As contas e os registros ficam no próprio aparelho; a primeira
conta criada nele é a administradora.

## O ciclo de trabalho

| Quando | O que fazer | Onde |
|---|---|---|
| Durante a inspeção | Preencher e salvar, com fotos | **Nova** |
| Ao montar o dossiê | Gerar o PDF da inspeção | **Histórico → PDF** |
| No fechamento do mês | Baixar a planilha e enviar | **Exportar → Planilha do período** |
| De tempos em tempos | Baixar o backup JSON | **Exportar → Backup JSON** |

O **backup JSON** é a sua rede de segurança: guarda inclusive as fotos e é o
que permite recuperar tudo se o aparelho for trocado ou formatado. Nada é
enviado para servidor nenhum — o que não estiver exportado existe somente
naquele celular.

---

## 1. Conteúdo do pacote

| Arquivo | Função |
|---|---|
| `index.html` | Estrutura de todas as telas |
| `styles.css` | Identidade visual EDP e ergonomia de campo |
| `config.js` | **Único arquivo de parametrização**: Supabase, domínios, limites |
| `auth.js` | Autenticação, sessão offline de 30 dias e funções de administrador |
| `db.js` | Persistência local (IndexedDB via Dexie), segregada por usuário |
| `painel.js` | Indicadores e gráficos (SVG puro) |
| `pdf.js` | Relatórios em PDF gerados no próprio aparelho |
| `app.js` | Regras de tela e orquestração |
| `service-worker.js` | Cache offline (cache-first) e Background Sync |
| `manifest.json` | Instalação na tela de início |
| `assets/` | Logo EDP (arquivo e Base64 usado pelo PDF) |
| `vendor/` | Dexie, jsPDF e html2canvas **embarcados localmente** |
| `icons/` | Ícones do PWA |
| `ferramentas/gerar-identidade.html` | Gera logo em Base64 e ícones a partir do PNG oficial |
| `iniciar-servidor.bat` + `servidor.ps1` | Servidor local para testar no Windows |
| `legado/` | Código do modo com servidor (Supabase, SharePoint, Sheets) — fora de uso |

Nada precisa ser compilado. Publique a pasta inteira como está.

---

## 2. Publicação

> **Requisito: HTTPS** (ou `localhost`). Service Worker, câmera e
> geolocalização não funcionam em HTTP puro.

### 2.0 Testar no computador, sem instalar nada (Windows)

Duplo clique em **`iniciar-servidor.bat`** (na mesma pasta do `index.html`).
Ele sobe um servidor local em `http://localhost:8080` usando o próprio Windows
e abre o navegador. Deixe a janela preta aberta enquanto usa o app.

> **Não abra o `index.html` com duplo clique.** Pelo protocolo `file://` o
> navegador bloqueia o IndexedDB e o Service Worker.

**A página abriu só com texto, sem cores nem botões?** É o *Modo de leitura*
do Edge, que descarta o CSS e o JavaScript — dá para reconhecer pelo endereço
começando com `read://`. Pressione **F9** para sair, ou desligue a entrada
automática na engrenagem da barra do modo de leitura. O `iniciar-servidor.bat`
já prefere abrir no Chrome justamente para evitar isso.

### 2.1 GitHub Pages
1. Envie os arquivos para um repositório (raiz ou `/docs`).
2. *Settings → Pages → Deploy from a branch* → `main` → pasta.
3. O endereço fica `https://<usuario>.github.io/<repositorio>/`.
   O app usa caminhos relativos: funciona em subpasta sem ajuste.

### 2.2 Netlify / Vercel
Arraste a pasta (Netlify) ou importe o repositório (Vercel). Sem build,
publish directory na raiz, preset **Other**.

### 2.3 IIS interno (rede EDP)
1. Copie a pasta para, por exemplo, `C:\inetpub\wwwroot\inspecao`.
2. Garanta o certificado HTTPS.
3. MIME types: `.json` → `application/json`, `.webmanifest` → `application/manifest+json`.
4. `Cache-Control: no-cache` para `service-worker.js`.

### 2.4 Publicando uma nova versão
Suba o número em **dois** lugares, senão os aparelhos continuam na versão antiga:

- `service-worker.js` → `const VERSAO = 'v3.2.0';`
- `config.js` → `CONFIG.app.versao`

---

## 3. Como funciona o acesso

O cadastro é feito no próprio aparelho e liberado na hora — sem internet e sem
aprovação. A **primeira conta criada no aparelho** vira administradora; as
seguintes entram como inspetores, com os lotes que escolherem.

A senha nunca é gravada: fica apenas um hash PBKDF2-SHA256 (150 mil iterações,
com sal), conferido na entrada. A sessão não expira, porque não há servidor
para renová-la.

**Segregação por usuário e por lote:** cada inspeção carrega o dono, e trocar
de inspetor no mesmo aparelho não expõe os registros do anterior. O inspetor
só vê e só grava nos lotes aos quais está vinculado; com um único lote, o
campo já vem preenchido e travado. A tela **Mais → Administração** lista as
contas daquele aparelho e permite editar lotes, promover e desativar.

> Como não há base central, a segregação vale dentro do aparelho. Ela é
> ergonomia e organização, não uma barreira de segurança entre pessoas
> diferentes — quem tem a senha de uma conta vê os registros dela.

## 4. Tabela de domínio (Lote → Canteiro → Empresa)

Tudo em **`config.js`**, no bloco `CONFIG.dominios`:

```js
'TN07': {
  descricao: 'Infraestrutura',
  canteiros: {
    'Canteiro COX - Nome do Local': ['Cox']
  }
},
```

Configuração de fábrica:

| Lote | Canteiro | Empresa |
|---|---|---|
| TN02 | Canteiro COX - São João do Piauí | Cox |
| TN02 | Canteiro COX - São Francisco | Cox |
| TN02 | Canteiro COX - Paulistana | Cox |
| TN02 | Canteiro POWERCHINA - Canto do Buriti | Power China |
| TN02 | Canteiro POWERCHINA - Gurgueia | Power China |
| TN02 | Canteiro POWERCHINA - Flores | Power China |
| TN02 | Canteiro POWERCHINA - Ribeiro Gonçalves | Power China |
| TN02 | Canteiro FERNANDES - Curral Novo | SFernandes |
| TM05 | Canteiro COX - Rubiataba | Cox |
| TM05 | Canteiro COX - Faina | Cox |
| TM05 | Canteiro COX - Itapirapuã | Cox |
| TM05 | Canteiro COX - Buriti de Goiás | Cox |
| TM05 | Canteiro COX - São Luís de Montes Belos | Cox |
| TM05 | Canteiro CEL ENGENHARIA - Matrinchã | CEL Engenharia |
| TN07 | *(vazio, parametrizável)* | — |
| TN13 | Canteiro COX - Ribeiro Gonçalves | Cox |
| TN13 | Canteiro COX - Balsas | Cox |
| TN13 | Canteiro COX - Carolina | Cox |
| TN13 | Canteiro COX - Goiatins | Cox |
| TN13 | Canteiro COX - Colinas | Cox |
| TN13 | Canteiro FERNANDES - Colinas | SFernandes |

> O código do segundo lote é **TM05** (com M), conforme a planilha oficial da
> obra — não é erro de digitação. Se um dia virar TN05, troque a chave em
> `CONFIG.dominios` **e** os valores já gravados em `usuarios.lotes`.

Nas telas e no PDF o lote aparece **somente pela sigla** (TN02, TM05, TN07,
TN13). O campo `descricao` da tabela continua no arquivo apenas como
referência interna — não é exibido em lugar nenhum.

Regras embutidas: canteiros filtrados pelo lote; empresa preenchida
automaticamente pelo canteiro; opção "Outro" acrescentada sozinha em canteiro
e empresa (com o canteiro "Outro", a empresa passa a oferecer a lista mestra
de `CONFIG.empresas`); lote com `canteiros: {}` fica parametrizável.

### Checklist SIM / NÃO (v3.1.0)

Ao marcar **Canteiro**, **Alojamento** ou **Cozinha/Refeitório** em "O que foi
inspecionado?", abre logo abaixo a lista de verificação do item, com botões
**SIM** e **NÃO**. As perguntas ficam em `CONFIG.checklists` (5 de Canteiro,
7 de Alojamento, 4 de Cozinha/Refeitório); para incluir ou alterar uma
pergunta, basta editar a lista. Item sem lista (Área de vivência, Outros) não
abre nada.

- Todas as perguntas do item marcado são obrigatórias para salvar.
- Resposta **NÃO** marca "Não conformidade = Sim" e escreve a pergunta em
  "Quais?" — o texto que o inspetor digitar por conta própria é preservado.
- As respostas aparecem no detalhe, no PDF individual e na planilha (uma
  coluna por pergunta + "Checklist Qtd NAO").

Também em `config.js`: `CONFIG.auth.funcoes` (Consultor, Analista,
Especialista, Gestor, Outro), `CONFIG.itensInspecao`, `CONFIG.limites`
(fotos, compressão, semáforo de cobertura) e `CONFIG.cores`.

---

## 5. Painel de indicadores

Calculado **na base local**, funcionando offline, sempre restrito aos lotes do
usuário. Seletor de período: mês atual, últimos 3 meses, ano e personalizado.

Cartões: inspeções no período; com não conformidade (quantidade e %); NCs em
aberto (acumulado de toda a base); canteiros inspecionados sobre o total do
lote (cobertura %); dias desde a última inspeção; pendentes de sincronização.

Gráficos, todos em SVG puro (sem biblioteca externa): inspeções por lote com a
parcela de NC em vermelho; ranking dos 8 canteiros com mais NCs; inspeções
por empresa; evolução mensal (total e % com NC); rosca por item inspecionado;
e inspeções por responsável, visível apenas para o administrador.

Na tela do computador o painel ocupa a largura toda, em formato de dashboard:
faixa de indicadores numa linha só e gráficos lado a lado em três colunas
(duas no tablet, uma no celular). Os gráficos são redesenhados na largura de
cada cartão ao redimensionar a janela, e mostram o valor exato ao passar o
mouse. Também entram o indicador **Checklist conforme** (% de respostas SIM)
e o gráfico **Checklist — perguntas com NÃO**.

Tabela de cobertura com semáforo: verde até 30 dias, amarelo de 31 a 60,
vermelho acima de 60 dias ou nunca inspecionado. O botão **Exportar painel**
gera o PDF de tudo isso, também offline.

---

## 6. Relatórios em PDF

Todos com a faixa `#1A1F2E` no topo e no rodapé em **todas as páginas**, logo
à esquerda, título à direita, identificação do documento, data/hora de emissão
e numeração de páginas.

| Relatório | Onde | Nome do arquivo |
|---|---|---|
| Individual | Detalhe da inspeção | `Inspecao_[Lote]_[Canteiro]_[AAAA-MM-DD]_[ID].pdf` |
| Consolidado | Histórico | `Inspecoes-Infra_Consolidado_[AAAA-MM-DD].pdf` |
| Painel | Painel | `Inspecoes-Infra_Painel_[AAAA-MM-DD].pdf` |

> No iPhone com o app instalado, o iOS não dispara download: o PDF abre em
> nova aba e o usuário salva por **Compartilhar → Salvar em Arquivos**.

---

## 7. Logotipo da empresa

O pacote sai com um **placeholder marcado** (mostra a palavra LOGO). Para
colocar a marca oficial há dois caminhos.

### 7.1 Pelo próprio aplicativo (recomendado)

**Mais → Logotipo da empresa → Escolher arquivo.**

Escolha o PNG da versão **negativa** da marca (a de fundo escuro, com fundo
transparente). A troca é imediata: cabeçalho, tela de login e faixa dos
relatórios em PDF passam a usar a sua logo. A imagem é redimensionada apenas
de forma proporcional — nunca esticada nem recortada — e fica gravada no
aparelho, sobrevivendo a fechar e reabrir o app.

O botão **Voltar ao padrão** desfaz a qualquer momento.

> A logo escolhida por aí vale **naquele aparelho**. É o caminho para um teste
> rápido ou para um aparelho avulso.

### 7.2 Para todos os aparelhos

Ainda no mesmo cartão, abra **"Aplicar em todos os aparelhos"** e clique em
**Baixar arquivos para publicar**. O app gera seis arquivos:

| Arquivo | Vai para | Serve para |
|---|---|---|
| `edp-logo-neg.png` | `assets/` | cabeçalho e tela de login |
| `logo-edp-base64.js` | `assets/` | faixa do PDF (funciona offline) |
| `icon-192.png` | `icons/` | ícone do app instalado |
| `icon-512.png` | `icons/` | ícone em alta resolução |
| `icon-512-maskable.png` | `icons/` | ícone adaptativo do Android |
| `apple-touch-icon.png` | `icons/` | ícone do iPhone |

Substitua os arquivos nas pastas indicadas, **suba a versão** (seção 2.4) e
republique. Os ícones saem centralizados sobre o `#1A1F2E`, respeitando a área
de proteção da marca — maior no *maskable*, que o Android recorta em círculo.

O ícone do aplicativo **instalado** só muda por este caminho: o `manifest.json`
é lido pelo sistema operacional na instalação, não pelo app em execução.

A ferramenta `ferramentas/gerar-identidade.html` continua no pacote e faz o
mesmo, para quem preferir preparar os arquivos sem entrar no app.

## 8. Instalação no aparelho do inspetor

**Android (Chrome):** menu ⋮ → *Instalar aplicativo*.
**iPhone/iPad:** abrir **no Safari** → *Compartilhar* → *Adicionar à Tela de
Início* → abrir sempre pelo ícone criado.
**Windows/macOS:** ícone ⊕ na barra de endereço → *Instalar*.

O tutorial está dentro do app (tela de login e aba *Mais*).

---

## 9. Limitações conhecidas

**iOS / Safari**
- Não existe Background Sync: o envio ocorre com o app **aberto** (polling de
  60 s) ou quando ele volta ao primeiro plano.
- Cota de armazenamento menor e sujeita a limpeza automática se o app ficar
  semanas sem uso. O app pede `navigator.storage.persist()`, mas o iOS pode
  negar. **Sincronize com frequência.**
- PWA instalado não faz download: PDF/CSV/JSON abrem em nova aba.
- É preciso abrir o app uma vez **com internet** após instalar, para concluir
  o cache.

**Acesso e dados**
- **Não há recuperação de senha por e-mail** — sem servidor, não existe para
  onde enviar. A conta existe só naquele aparelho: se a senha se perder, o
  administrador do aparelho reativa por outra conta, ou cria-se outra com
  e-mail diferente. Antes disso, exporte o backup JSON.
- **O que não for exportado existe só no celular.** Sem sincronização, trocar
  ou formatar o aparelho sem backup significa perder os registros. Combine com
  a equipe uma rotina: planilha no fechamento do mês, backup JSON junto.
- O login offline vale para **a última conta usada naquele aparelho**. Um
  segundo inspetor no mesmo celular precisa de internet no primeiro acesso.
- Cada aparelho tem a própria base. A visão do time inteiro se monta juntando
  as planilhas mensais — no Power BI, por exemplo.
- Registros criados na versão 1.x (antes do login) ficam marcados como
  `legado-v1`: continuam no banco e saem na exportação JSON, mas não aparecem
  no histórico, porque não seria correto atribuí-los a quem logar primeiro.
- A exclusão é sempre lógica. Não há DELETE exposto na API, nem para o
  administrador.

**Geral**
- HTTPS obrigatório (exceto `localhost`).
- Em janela anônima o IndexedDB pode ser bloqueado — o app avisa.
- Câmera e GPS dependem de permissão; negados, o registro é salvo assim mesmo,
  com o motivo anotado.
- Limite de 20 fotos por inspeção (`CONFIG.limites.maxFotos`).
- Após publicar nova versão, o aparelho atualiza no segundo carregamento
  (comportamento normal do Service Worker).

---

## 10. Verificação executada nesta entrega

Bateria automatizada em navegador (Chromium), cobrindo o fluxo completo sem
servidor — cadastro, inspeção com fotos em modo avião, exportações e
relatórios. **Todas as verificações aprovadas**, entre elas:

| Critério de aceite | Resultado |
|---|---|
| Dois usuários, dois aparelhos, mesma tabela central com `usuario_id` correto | ✅ |
| Usuário do TN13 barrado **pelo servidor** ao gravar no TN02 (não só oculto na tela) | ✅ |
| Registro barrado permanece no aparelho, marcado com erro | ✅ |
| Cadastro nasce pendente e só entra após aprovação do administrador | ✅ |
| Aprovação, edição de lotes e promoção a admin pela tela de Administração | ✅ |
| Login sobrevive em modo avião, com registro de inspeção e fotos | ✅ |
| Sessão vencida bloqueia só o envio; preenchimento segue funcionando | ✅ |
| Novo login offline após 30 dias é recusado | ✅ |
| Volta da rede renova a sessão silenciosamente e sobe a fila | ✅ |
| Versão mais antiga não sobrescreve a mais recente; anterior vai ao histórico | ✅ |
| Painel calcula os 6 indicadores e desenha os gráficos offline | ✅ |
| PDF do painel e PDF individual com fotos, gerados offline | ✅ |
| Troca de inspetor no mesmo aparelho não expõe registros do anterior | ✅ |
| Fotos gravadas em `{lote}/{id}/{arquivo}` no Storage | ✅ |
| Nome do app correto no título e no manifest | ✅ |
| **v3**: navegação sem "Sincronizar"; nenhuma referência de envio nas telas | ✅ |
| **v3**: itens inspecionados reduzidos às 5 opções, com "Outros" obrigatório | ✅ |
| **v3**: planilha do período em CSV, sem coluna de sincronização | ✅ |
| **v3**: PDF consolidado e backup JSON com fotos, pelo mesmo período | ✅ |
| **v3**: cabeçalho conta as inspeções; painel mostra fotos registradas | ✅ |
| **Modo local**: cadastrar, entrar, registrar com fotos e gerar PDF sem servidor | ✅ |
| **Modo local**: duas contas no mesmo aparelho, sem uma ver os registros da outra | ✅ |
| **Modo local**: primeira conta vira administradora; senha errada recusada | ✅ |
| Envio do logotipo pelo app: aplica no cabeçalho, no login e no PDF | ✅ |
| Logotipo persiste ao reabrir; proporção preservada; volta ao padrão | ✅ |
| Geração dos 6 arquivos de identidade para publicação | ✅ |
| Nome "EDP TRANSMISSÃO CONSTRUÇÃO" em título, cabeçalho, login e PDF | ✅ |
| Nenhum erro de JavaScript no console | ✅ |

O que **não** pôde ser testado aqui, por depender do ambiente real: o projeto
Supabase de produção (a RLS foi validada contra um simulador que aplica as
mesmas regras, mas o SQL precisa ser executado e conferido no projeto de
vocês) e a instalação em iPhone/Android físicos. Faça um teste com **duas
contas reais** antes de liberar para o time.
