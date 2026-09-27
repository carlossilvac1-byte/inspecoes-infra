# Publicar no GitHub Pages — usar no celular (iPhone e Android), online e offline

O celular só instala o aplicativo e o faz funcionar sem sinal a partir de um
endereço **https://**. O `localhost:8080` do computador serve apenas para testes
nele mesmo. O GitHub Pages dá esse endereço de graça. Leva cerca de 10 minutos,
uma única vez.

## 0. Antes de publicar — logotipo oficial
A logo que aparece no app do computador foi carregada **naquele aparelho**. Para
que os celulares recebam a marca oficial:

1. No app do computador: **Mais → Logotipo da empresa → Aplicar em todos os
   aparelhos → Baixar arquivos para publicar**.
2. Copie `edp-logo-neg.png` e `logo-edp-base64.js` para a pasta `assets/`, e os
   quatro ícones (`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`,
   `apple-touch-icon.png`) para a pasta `icons/`, substituindo os atuais.

## 1. Conta e repositório
1. Entre em <https://github.com> (crie a conta, se ainda não tiver).
2. Botão verde **New** → **Repository name:** `inspecoes-infra`
   - Marque **Public** (o GitHub Pages gratuito exige repositório público)
   - **Não** marque "Add a README file"
3. **Create repository**.

> Público significa que os ARQUIVOS do aplicativo ficam visíveis, como qualquer
> site. Os DADOS das inspeções não: ficam guardados no aparelho de cada inspetor
> e só saem pelos PDFs, pela planilha e pelo backup JSON.

## 2. Enviar os arquivos
1. Na página do repositório vazio, clique em **uploading an existing file**.
2. Abra a pasta `inspecoes-infra-edp-v3` e selecione **tudo o que está dentro
   dela** (Ctrl+A): os arquivos soltos e as pastas `assets`, `icons`, `vendor`,
   `ferramentas` e `legado`. Arraste para a área do navegador.
   - Não arraste a pasta inteira nem um `.zip`: o `index.html` precisa ficar na
     raiz do repositório.
   - Os arquivos `iniciar-servidor.bat`, `servidor.ps1` e `desktop.ini` podem
     ficar de fora (só servem para o computador).
3. Espere a barra de progresso terminar e clique em **Commit changes**.

## 3. Ligar o GitHub Pages
1. No repositório: **Settings** → **Pages** (menu à esquerda).
2. *Source*: **Deploy from a branch** → Branch **main** · pasta **/ (root)** → **Save**.
3. Aguarde 1 a 2 minutos e recarregue: aparece
   `Your site is live at https://SEUUSUARIO.github.io/inspecoes-infra/`.

Esse é o endereço para distribuir à equipe.

## 4. Conferir
Abra o endereço no computador: deve aparecer a tela de login com a faixa escura.
Erro 404 logo após publicar é normal — espere mais um minuto.

## 5. Instalar no celular
**Android (Chrome)**
1. Abrir o endereço no **Chrome**.
2. Menu **⋮** → **Instalar aplicativo** (ou "Adicionar à tela inicial").
3. O ícone aparece junto dos outros aplicativos.

**iPhone / iPad (Safari)**
1. Abrir o endereço **no Safari** — pelo Chrome do iPhone não instala.
2. Botão **Compartilhar** (quadrado com seta) → **Adicionar à Tela de Início** → **Adicionar**.
3. Abrir sempre pelo ícone criado.

## 6. Funcionamento offline
- Abra o app **uma vez com internet** logo após instalar: é nesse momento que ele
  guarda tudo no aparelho.
- Depois disso, abre e registra inspeções **sem sinal**, com fotos, e gera os PDFs
  no próprio celular.
- Cada aparelho tem a própria base: cada inspetor cria o seu cadastro no celular
  dele. A primeira conta criada em cada aparelho é a administradora dele.
- **iPhone:** o iOS pode limpar dados de apps parados por semanas. Exporte a
  planilha e o **backup JSON** com frequência (tela Exportar).

## 7. Atualizar o app depois
No repositório: **Add file → Upload files**, arraste os arquivos alterados por
cima e **Commit changes**. Com internet, os celulares recebem a nova versão ao
abrir o app (ele se recarrega sozinho); sem internet, seguem na versão anterior
até a próxima conexão.
