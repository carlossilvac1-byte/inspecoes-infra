/* =====================================================================
 * backend/apps-script.gs — Web App para o adaptador "gsheets"
 * ---------------------------------------------------------------------
 * Recebe o JSON enviado pelo aplicativo, grava uma linha na planilha e
 * salva as fotos em uma pasta do Google Drive (uma subpasta por
 * inspeção), devolvendo os links.
 *
 * COMO PUBLICAR
 *  1. Crie uma planilha no Google Sheets e copie o ID da URL
 *     (https://docs.google.com/spreadsheets/d/<ID>/edit).
 *  2. Crie uma pasta no Drive para as fotos e copie o ID dela.
 *  3. Na planilha: Extensões > Apps Script. Cole este arquivo.
 *  4. Preencha as constantes abaixo (ID_PLANILHA, ID_PASTA, TOKEN).
 *  5. Execute uma vez a função "prepararPlanilha" para criar o cabeçalho
 *     e autorizar os acessos.
 *  6. Implantar > Nova implantação > tipo "App da Web":
 *        Executar como: Eu
 *        Quem tem acesso: Qualquer pessoa
 *     Copie a URL terminada em /exec para CONFIG.sync.gsheets.urlWebApp.
 *  7. Use o MESMO token em CONFIG.sync.gsheets.token.
 *
 * Observação de segurança: "Qualquer pessoa" é exigido para que o app
 * consiga postar sem login Google. O TOKEN é a barreira de acesso —
 * troque-o por um valor longo e aleatório.
 * ===================================================================== */

const ID_PLANILHA = 'COLOQUE_AQUI_O_ID_DA_PLANILHA';
const ID_PASTA    = 'COLOQUE_AQUI_O_ID_DA_PASTA_DO_DRIVE';
const TOKEN       = 'TROQUE-ESTE-TOKEN';
const ABA         = 'Inspecoes';

const CABECALHO = [
  'ID Local', 'Data Inspeção', 'Responsável', 'Lote', 'Canteiro', 'Construtora',
  'O que foi inspecionado', 'Não Conformidade', 'Quais', 'Observações',
  'Latitude', 'Longitude', 'Qtd Fotos', 'Links das Fotos', 'Pasta',
  'Dispositivo', 'Data Criação', 'Data Edição', 'Versão', 'Excluído', 'Recebido em'
];

/* ---------------------------------------------------------------------
 * Executar manualmente uma vez: cria a aba e o cabeçalho.
 * ------------------------------------------------------------------- */
function prepararPlanilha() {
  const ss = SpreadsheetApp.openById(ID_PLANILHA);
  let aba = ss.getSheetByName(ABA);
  if (!aba) aba = ss.insertSheet(ABA);
  if (aba.getLastRow() === 0) {
    aba.appendRow(CABECALHO);
    aba.getRange(1, 1, 1, CABECALHO.length)
       .setFontWeight('bold')
       .setBackground('#12373D')
       .setFontColor('#FFFFFF');
    aba.setFrozenRows(1);
  }
  DriveApp.getFolderById(ID_PASTA); // força a autorização do Drive
  return 'Planilha preparada.';
}

/* ---------------------------------------------------------------------
 * Endpoint POST
 * ------------------------------------------------------------------- */
function doPost(e) {
  try {
    const dados = JSON.parse(e.postData.contents);

    if (dados.token !== TOKEN) {
      return responder({ ok: false, erro: 'Token inválido.' });
    }

    if (dados.acao === 'excluir') {
      return responder(excluirRegistro(dados.idLocal));
    }
    if (dados.acao !== 'gravar') {
      return responder({ ok: false, erro: 'Ação desconhecida: ' + dados.acao });
    }

    const insp = dados.inspecao;
    const fotos = dados.fotos || [];

    // ---- Fotos: uma subpasta por inspeção ---------------------------
    const raiz = DriveApp.getFolderById(ID_PASTA);
    let pasta = null;
    const links = [];
    if (fotos.length) {
      const nomePasta = insp.dataInspecao + '_' + insp.lote + '_' +
                        insp.canteiro + '_' + insp.idLocal.substring(0, 8);
      const existentes = raiz.getFoldersByName(nomePasta);
      pasta = existentes.hasNext() ? existentes.next() : raiz.createFolder(nomePasta);

      fotos.forEach(function (f) {
        // Evita duplicar a foto em um reenvio do mesmo registro
        const jaTem = pasta.getFilesByName(f.nome);
        if (jaTem.hasNext()) { links.push(jaTem.next().getUrl()); return; }
        const blob = Utilities.newBlob(
          Utilities.base64Decode(f.base64), f.mime || 'image/jpeg', f.nome);
        const arquivo = pasta.createFile(blob);
        if (f.legenda) arquivo.setDescription(f.legenda);
        links.push(arquivo.getUrl());
      });
    }

    // ---- Linha da planilha (upsert por ID Local) --------------------
    const aba = abaDestino();
    const linha = [
      insp.idLocal,
      insp.dataInspecao,
      insp.responsavel,
      insp.lote,
      insp.canteiro,
      insp.construtora,
      insp.inspecionado,
      insp.naoConformidade,
      insp.quais,
      insp.observacoes,
      insp.latitude,
      insp.longitude,
      fotos.length,
      links.join('\n'),
      pasta ? pasta.getUrl() : '',
      insp.dispositivo,
      insp.dataCriacao,
      insp.dataEdicao,
      insp.versao,
      'Não',
      new Date()
    ];

    const existente = localizarLinha(aba, insp.idLocal);
    let numeroLinha;
    if (existente > 0) {
      aba.getRange(existente, 1, 1, linha.length).setValues([linha]);
      numeroLinha = existente;
    } else {
      aba.appendRow(linha);
      numeroLinha = aba.getLastRow();
    }

    return responder({ ok: true, linha: numeroLinha, fotos: links.length });

  } catch (erro) {
    return responder({ ok: false, erro: String(erro) });
  }
}

/* Verificação rápida no navegador (GET). */
function doGet() {
  return responder({ ok: true, servico: 'Inspeção de Campo — Web App ativo.' });
}

/* ---------------------------------------------------------------------
 * Auxiliares
 * ------------------------------------------------------------------- */
function abaDestino() {
  const ss = SpreadsheetApp.openById(ID_PLANILHA);
  let aba = ss.getSheetByName(ABA);
  if (!aba) { prepararPlanilha(); aba = ss.getSheetByName(ABA); }
  return aba;
}

/** Procura a linha cujo "ID Local" seja igual ao informado (0 = não achou). */
function localizarLinha(aba, idLocal) {
  const ultima = aba.getLastRow();
  if (ultima < 2) return 0;
  const ids = aba.getRange(2, 1, ultima - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idLocal)) return i + 2;
  }
  return 0;
}

/** Exclusão lógica: marca a coluna "Excluído" como Sim. */
function excluirRegistro(idLocal) {
  const aba = abaDestino();
  const linha = localizarLinha(aba, idLocal);
  if (!linha) return { ok: true, aviso: 'Registro não encontrado; nada a excluir.' };
  aba.getRange(linha, CABECALHO.indexOf('Excluído') + 1).setValue('Sim');
  aba.getRange(linha, CABECALHO.indexOf('Recebido em') + 1).setValue(new Date());
  return { ok: true, linha: linha };
}

function responder(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}
