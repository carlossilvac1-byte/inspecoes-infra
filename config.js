/* =====================================================================
 * config.js — ARQUIVO ÚNICO DE PARAMETRIZAÇÃO
 * ---------------------------------------------------------------------
 * Inspeções - Infra | EDP TRANSMISSÃO CONSTRUÇÃO
 *
 * É o único arquivo que precisa ser alterado no dia a dia:
 *   1) Tabela de domínio Lote -> Canteiro -> Empresa (Construtora)
 *   2) Funções/cargos e itens inspecionáveis
 *   3) Limites operacionais (fotos, compressão)
 *
 * NÃO é necessário mexer em app.js, auth.js, db.js, painel.js ou pdf.js
 * para incluir um canteiro, uma empresa ou um lote.
 *
 * Esta versão trabalha SEM servidor: cada inspetor guarda as próprias
 * inspeções no aparelho, emite os PDFs do dossiê e envia a planilha
 * mensal. O código do backend antigo ficou em legado/, caso um dia a
 * obra volte a querer base central.
 * ===================================================================== */

const CONFIG = {

  /* -------------------------------------------------------------------
   * 1. IDENTIFICAÇÃO DA APLICAÇÃO
   * ----------------------------------------------------------------- */
  app: {
    nome: 'Inspeções - Infra | EDP TRANSMISSÃO CONSTRUÇÃO',
    nomeCurto: 'Inspeções Infra',
    obra: 'EDP TRANSMISSÃO CONSTRUÇÃO',
    empresa: 'EDP TRANSMISSÃO CONSTRUÇÃO',
    versao: '3.2.1'
  },

  /* -------------------------------------------------------------------
   * 2. ACESSO
   * ----------------------------------------------------------------- */
  auth: {
    diasSessaoOffline: 3650,   // sem servidor, a conta local não expira
    minimoSenha: 8,            // com ao menos uma letra e um número
    funcoes: ['Consultor', 'Analista', 'Especialista', 'Gestor', 'Outro']
  },

  /* -------------------------------------------------------------------
   * 3. TABELA DE DOMÍNIO — Lote -> Canteiro -> Empresa
   * -------------------------------------------------------------------
   * Estrutura:
   *   'TN02': {
   *      descricao: 'apenas informativo — não aparece nas telas',
   *      canteiros: { 'Nome do Canteiro': ['EMPRESA'] }
   *   }
   *
   * Regras já embutidas no app:
   *   - Canteiros filtrados pelo Lote; Empresas filtradas pelo Canteiro.
   *   - Canteiro com uma única empresa vem pré-selecionado.
   *   - A opção "Outro" é acrescentada automaticamente.
   *   - Lote com "canteiros: {}" fica parametrizável (caso do TN07).
   *   - O usuário só enxerga os lotes aos quais está vinculado.
   *
   * ATENÇÃO: o código do segundo lote é TM05 (com M), conforme a
   * planilha oficial da obra. Não é erro de digitação.
   * ----------------------------------------------------------------- */
  dominios: {
    'TN02': {
      descricao: 'Infraestrutura',
      canteiros: {
        'Canteiro COX - São João do Piauí':        ['Cox'],
        'Canteiro COX - São Francisco':            ['Cox'],
        'Canteiro COX - Paulistana':               ['Cox'],
        'Canteiro POWERCHINA - Canto do Buriti':   ['Power China'],
        'Canteiro POWERCHINA - Gurgueia':          ['Power China'],
        'Canteiro POWERCHINA - Flores':            ['Power China'],
        'Canteiro POWERCHINA - Ribeiro Gonçalves': ['Power China'],
        'Canteiro FERNANDES - Curral Novo':        ['SFernandes']
      }
    },
    'TM05': {
      descricao: 'Infraestrutura',
      canteiros: {
        'Canteiro COX - Rubiataba':                ['Cox'],
        'Canteiro COX - Faina':                    ['Cox'],
        'Canteiro COX - Itapirapuã':               ['Cox'],
        'Canteiro COX - Buriti de Goiás':          ['Cox'],
        'Canteiro COX - São Luís de Montes Belos': ['Cox'],
        'Canteiro CEL ENGENHARIA - Matrinchã':     ['CEL Engenharia']
      }
    },
    'TN07': {
      descricao: 'Infraestrutura',
      canteiros: {}
    },
    'TN13': {
      descricao: 'Infraestrutura',
      canteiros: {
        'Canteiro COX - Ribeiro Gonçalves': ['Cox'],
        'Canteiro COX - Balsas':            ['Cox'],
        'Canteiro COX - Carolina':          ['Cox'],
        'Canteiro COX - Goiatins':          ['Cox'],
        'Canteiro COX - Colinas':           ['Cox'],
        'Canteiro FERNANDES - Colinas':     ['SFernandes']
      }
    }
  },

  /* -------------------------------------------------------------------
   * 4. EMPRESAS (CONSTRUTORAS)
   * -------------------------------------------------------------------
   * Lista mestra, oferecida quando o canteiro escolhido é "Outro".
   * ----------------------------------------------------------------- */
  empresas: [
    'Cox',
    'Power China',
    'SFernandes',
    'CEL Engenharia'
  ],

  /* -------------------------------------------------------------------
   * 5. ITENS INSPECIONÁVEIS (seleção múltipla do formulário)
   * ----------------------------------------------------------------- */
  itensInspecao: [
    'Canteiro',
    'Alojamento',
    'Cozinha/Refeitório',
    'Área de vivência',
    'Outros'
  ],

  // Item que libera o campo de texto livre. Se você renomear a opção na
  // lista acima, troque aqui também.
  itemOutro: 'Outros',

  /* -------------------------------------------------------------------
   * 5.1 CHECKLIST SIM / NÃO POR ITEM INSPECIONADO
   * -------------------------------------------------------------------
   * Ao marcar o item no formulário, abre a lista de verificação abaixo
   * dele. Todas as perguntas do item marcado são de resposta obrigatória.
   *
   * - A chave precisa ser IGUAL ao nome do item em "itensInspecao".
   * - Item sem entrada aqui (Área de vivência, Outros) não abre lista.
   * - Para incluir/alterar/remover pergunta basta editar a lista.
   * - Resposta NÃO marca a inspeção como "Não conformidade = Sim" e
   *   acrescenta a pergunta no campo "Quais?".
   * ----------------------------------------------------------------- */
  checklists: {
    'Canteiro': [
      'Existem extintores de acordo com os riscos? Estão devidamente distribuídos?',
      'Possui Controle de Pragas e Vetores?',
      'Possui Kit de mitigação Ambiental?',
      'Possui sistema de CFTV?',
      'Possui Cercamento/Muro?'
    ],
    'Alojamento': [
      'Existe Política de Convivência?',
      'A Política de Convivência está devidamente exposta e é de conhecimento de todos?',
      'Possui Controle de Pragas e Vetores?',
      'Possui controle nominal de alojados por quarto?',
      'Possui sistema de CFTV?',
      'Possui Cercamento/Muro?',
      'Possui vigia?'
    ],
    'Cozinha/Refeitório': [
      'Existe Manual de operação/procedimento de armazenamento, manipulação e envasamento de alimentos? É de conhecimento de todos?',
      'Os colaboradores que trabalham no Refeitório/Cozinha são treinados nos manuais e procedimentos? Possui lista de presença?',
      'Existe Nutricionista responsável pelo Refeitório/Cozinha?',
      'O cardápio semanal é elaborado pela Nutricionista?'
    ]
  },

  /* -------------------------------------------------------------------
   * 6. LIMITES OPERACIONAIS
   * ----------------------------------------------------------------- */
  limites: {
    maxFotos: 20,
    fotoLadoMaior: 1600,
    fotoAlvoBytes: 300 * 1024,
    fotoQualidadeInicial: 0.82,
    fotoQualidadeMinima: 0.40,
    alertaArmazenamentoPct: 80,
    timeoutGeolocalizacaoMs: 8000,
    diasSemaforoVerde: 30,     // painel: cobertura de canteiros
    diasSemaforoAmarelo: 60
  },

  /* -------------------------------------------------------------------
   * 7. IDENTIDADE VISUAL (espelha o styles.css e alimenta o PDF)
   * ----------------------------------------------------------------- */
  cores: {
    azulMarinho:  '#1A1F2E',   // faixa de cabeçalho e navegação
    cabecalho:    '#12373D',   // cabeçalho alternativo / seções
    fundo:        '#F4F7F9',
    cartao:       '#FFFFFF',
    verdeAgua:    '#26A69A',   // ação primária
    verdeVivo:    '#32D74B',   // realce / item ativo
    texto:        '#1A1F2E',
    textoApoio:   '#5A6672',
    borda:        '#DDE3E8',
    conforme:     '#2E7D32',
    naoConforme:  '#C62828',
    pendente:     '#F9A825'
  }
};

/* ---------------------------------------------------------------------
 * FUNÇÕES AUXILIARES DE DOMÍNIO
 * ------------------------------------------------------------------- */

/** Todos os códigos de lote cadastrados. */
CONFIG.listarLotes = function () {
  return Object.keys(CONFIG.dominios);
};

/**
 * Lotes que o usuário informado pode usar.
 * @param {string[]} lotesDoUsuario - vindo do perfil (usuarios.lotes)
 * @param {boolean} ehAdmin - administrador enxerga todos
 */
CONFIG.lotesPermitidos = function (lotesDoUsuario, ehAdmin) {
  const todos = CONFIG.listarLotes();
  if (ehAdmin) return todos;
  if (!Array.isArray(lotesDoUsuario) || !lotesDoUsuario.length) return [];
  return todos.filter(l => lotesDoUsuario.indexOf(l) !== -1);
};

/** Canteiros de um lote, em ordem alfabética. */
CONFIG.listarCanteiros = function (lote) {
  if (!lote || !CONFIG.dominios[lote]) return [];
  return Object.keys(CONFIG.dominios[lote].canteiros)
    .sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
};

/** Empresas vinculadas a um canteiro dentro de um lote. */
CONFIG.listarEmpresas = function (lote, canteiro) {
  if (!lote || !canteiro || !CONFIG.dominios[lote]) return [];
  const lista = CONFIG.dominios[lote].canteiros[canteiro];
  return Array.isArray(lista) ? lista.slice() : [];
};

/**
 * Rótulo do lote exibido nas telas e no PDF: SOMENTE A SIGLA (TN02).
 * O campo "descricao" da tabela de domínio continua disponível para
 * consulta, mas não aparece mais junto do código.
 */
CONFIG.rotuloLote = function (lote) {
  return String(lote || '');
};

/** Perguntas SIM/NÃO de um item inspecionado ([] se o item não tem lista). */
CONFIG.perguntasDoItem = function (item) {
  const l = (CONFIG.checklists || {})[item];
  return Array.isArray(l) ? l.slice() : [];
};

/** Total de canteiros cadastrados nos lotes informados (base da cobertura). */
CONFIG.totalCanteiros = function (lotes) {
  return (lotes || CONFIG.listarLotes())
    .reduce((soma, l) => soma + CONFIG.listarCanteiros(l).length, 0);
};

window.CONFIG = CONFIG;
