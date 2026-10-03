/* =====================================================================
 * db.js — CAMADA DE PERSISTÊNCIA LOCAL (IndexedDB via Dexie)
 * ---------------------------------------------------------------------
 * Princípio offline-first: TUDO é gravado primeiro aqui. A rede é um
 * detalhe posterior. Nenhuma tela fala com o servidor; todas falam com
 * este arquivo.
 *
 * SEGREGAÇÃO POR USUÁRIO (v2)
 * Cada inspeção carrega usuarioId. Todas as consultas do app filtram
 * pelo usuário autenticado, de modo que trocar de inspetor no mesmo
 * aparelho não expõe os registros do anterior. A fila de sincronização
 * também é por usuário: cada um envia o que é seu.
 *
 * Tabelas:
 *   inspecoes  - o registro da inspeção (sem as fotos)
 *   fotos      - uma linha por foto, com o Blob binário
 *   versoes    - histórico: cópia da versão anterior a cada edição
 *   auditoria  - trilha de auditoria (criação, edição, exclusão, envio)
 *   syncLog    - log das sincronizações
 *   kv         - sessão e preferências do aparelho
 * ===================================================================== */

const DB = (function () {

  // ---------------------------------------------------------------
  // Banco
  // ---------------------------------------------------------------
  const db = new Dexie('inspecoes_lt500');

  // v1 — versão anterior, monousuário (mantida para a migração)
  db.version(1).stores({
    inspecoes: 'id, dataInspecao, lote, canteiro, empresa, naoConformidade, status, excluido, criadoEm, atualizadoEm',
    fotos:     'id, inspecaoId, ordem',
    versoes:   '++seq, inspecaoId, salvoEm',
    auditoria: '++seq, inspecaoId, em, acao',
    syncLog:   '++seq, em',
    kv:        'chave'
  });

  // v2 — multiusuário
  db.version(2).stores({
    inspecoes: 'id, usuarioId, dataInspecao, lote, canteiro, empresa, naoConformidade, status, excluido, criadoEm, atualizadoEm',
    fotos:     'id, inspecaoId, ordem',
    versoes:   '++seq, inspecaoId, salvoEm',
    auditoria: '++seq, inspecaoId, em, acao',
    syncLog:   '++seq, em',
    kv:        'chave'
  }).upgrade(async (tx) => {
    // Registros da v1 não têm dono. Ficam marcados como legado: não
    // aparecem para nenhum usuário (não seria correto atribuí-los a
    // quem logar primeiro), mas continuam no banco e saem na
    // exportação JSON completa.
    await tx.table('inspecoes').toCollection().modify(r => {
      if (!r.usuarioId) r.usuarioId = 'legado-v1';
    });
  });

  // v3 — contas locais, para o app funcionar SEM servidor configurado.
  // Em Dexie basta declarar o que mudou; as demais tabelas seguem iguais.
  db.version(3).stores({
    usuariosLocais: 'id, email'
  });

  // v4 — cronograma de inspeções (programado x realizado)
  db.version(4).stores({
    cronograma: 'id, usuarioId, ano, lote, status'
  });

  // ---------------------------------------------------------------
  // Utilitários
  // ---------------------------------------------------------------

  /** UUID v4. */
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const buf = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
           '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function agora() { return new Date().toISOString(); }

  /** Descrição curta do dispositivo/navegador, gravada em cada registro. */
  function dispositivo() {
    const ua = navigator.userAgent || '';
    let so = 'Desconhecido';
    if (/Android/i.test(ua)) so = 'Android';
    else if (/iPhone|iPad|iPod/i.test(ua)) so = 'iOS';
    else if (/Windows/i.test(ua)) so = 'Windows';
    else if (/Mac OS X/i.test(ua)) so = 'macOS';
    else if (/Linux/i.test(ua)) so = 'Linux';
    let nav = 'Outro';
    if (/Edg\//.test(ua)) nav = 'Edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) nav = 'Chrome';
    else if (/Firefox\//.test(ua)) nav = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) nav = 'Safari';
    return so + ' / ' + nav;
  }

  /** Usuário autenticado no momento (ou null antes do login). */
  function usuarioAtual() {
    return (window.AUTH && AUTH.usuarioId) ? AUTH.usuarioId() : null;
  }

  // ---------------------------------------------------------------
  // Preferências (chave/valor) — nível de aparelho
  // ---------------------------------------------------------------
  async function kvSet(chave, valor) {
    await db.kv.put({ chave: chave, valor: valor });
    return valor;
  }

  async function kvGet(chave, padrao) {
    const r = await db.kv.get(chave);
    if (!r) return padrao === undefined ? null : padrao;
    return r.valor === null || r.valor === undefined
      ? (padrao === undefined ? null : padrao) : r.valor;
  }

  // ---------------------------------------------------------------
  // Contas locais (modo sem servidor)
  // ---------------------------------------------------------------
  // Usadas quando o Supabase ainda não foi configurado. Ficam apenas
  // neste aparelho; a senha nunca é gravada, só o hash PBKDF2.

  async function contarUsuariosLocais() {
    return db.usuariosLocais.count();
  }

  async function listarUsuariosLocais() {
    const l = await db.usuariosLocais.toArray();
    l.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    return l;
  }

  async function obterUsuarioLocalPorEmail(email) {
    const alvo = String(email || '').trim().toLowerCase();
    const todos = await db.usuariosLocais.toArray();
    return todos.filter(u => String(u.email).toLowerCase() === alvo)[0] || null;
  }

  async function criarUsuarioLocal(dados) {
    const registro = {
      id: 'local-' + uuid(),
      nome: dados.nome,
      email: String(dados.email).trim().toLowerCase(),
      funcao: dados.funcao,
      lotes: dados.lotes || [],
      perfil: dados.perfil || 'inspetor',
      status: 'ativo',
      credencial: dados.credencial,
      criado_em: agora(),
      ultimo_acesso: null,
      ultimo_sync: null,
      local: true
    };
    await db.usuariosLocais.add(registro);
    await auditar('(sistema)', 'cadastro-local',
      'Conta criada neste aparelho: ' + registro.email + ' (' + registro.perfil + ')', registro.nome);
    return registro;
  }

  async function atualizarUsuarioLocal(id, campos) {
    await db.usuariosLocais.update(id, campos);
    return db.usuariosLocais.get(id);
  }

  /**
   * Passa os registros de uma conta local para a conta do servidor,
   * quando a mesma pessoa (mesmo e-mail) entra depois que o Supabase
   * foi configurado. Sem isso, o histórico ficaria invisível.
   */
  async function migrarRegistrosLocais(idAntigo, idNovo) {
    if (!idAntigo || !idNovo || idAntigo === idNovo) return 0;
    const afetados = await db.inspecoes.where('usuarioId').equals(idAntigo)
      .modify({ usuarioId: idNovo });
    if (afetados) {
      await auditar('(sistema)', 'migracao',
        afetados + ' registro(s) da conta local passaram para a conta do servidor.', '');
    }
    return afetados;
  }

  // ---------------------------------------------------------------
  // Compressão de imagem
  // ---------------------------------------------------------------
  /**
   * Redimensiona para no máximo CONFIG.limites.fotoLadoMaior no lado
   * maior e comprime em JPEG até ficar perto de 300 KB.
   * Retorna { blob, largura, altura, bytes }.
   */
  async function comprimirImagem(arquivo) {
    const L = CONFIG.limites;
    let bitmap = null, img = null, url = null;
    let larguraOrig, alturaOrig;

    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(arquivo);
      larguraOrig = bitmap.width;
      alturaOrig = bitmap.height;
    } else {
      url = URL.createObjectURL(arquivo);
      img = await new Promise((ok, erro) => {
        const e = new Image();
        e.onload = () => ok(e);
        e.onerror = () => erro(new Error('Falha ao ler a imagem.'));
        e.src = url;
      });
      larguraOrig = img.naturalWidth;
      alturaOrig = img.naturalHeight;
    }

    const maior = Math.max(larguraOrig, alturaOrig);
    const escala = maior > L.fotoLadoMaior ? L.fotoLadoMaior / maior : 1;
    const largura = Math.max(1, Math.round(larguraOrig * escala));
    const altura = Math.max(1, Math.round(alturaOrig * escala));

    const canvas = document.createElement('canvas');
    canvas.width = largura;
    canvas.height = altura;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, largura, altura);
    ctx.drawImage(bitmap || img, 0, 0, largura, altura);

    if (bitmap && bitmap.close) bitmap.close();
    if (url) URL.revokeObjectURL(url);

    let qualidade = L.fotoQualidadeInicial;
    let blob = await paraBlob(canvas, qualidade);
    while (blob.size > L.fotoAlvoBytes && qualidade > L.fotoQualidadeMinima) {
      qualidade = Math.max(L.fotoQualidadeMinima, qualidade - 0.10);
      blob = await paraBlob(canvas, qualidade);
    }
    if (blob.size > L.fotoAlvoBytes && largura > 640) {
      const c2 = document.createElement('canvas');
      c2.width = Math.round(largura * 0.8);
      c2.height = Math.round(altura * 0.8);
      c2.getContext('2d').drawImage(canvas, 0, 0, c2.width, c2.height);
      blob = await paraBlob(c2, L.fotoQualidadeMinima + 0.1);
      return { blob: blob, largura: c2.width, altura: c2.height, bytes: blob.size };
    }
    return { blob: blob, largura: largura, altura: altura, bytes: blob.size };
  }

  function paraBlob(canvas, qualidade) {
    return new Promise((ok) => {
      if (canvas.toBlob) canvas.toBlob(b => ok(b), 'image/jpeg', qualidade);
      else ok(dataUrlParaBlob(canvas.toDataURL('image/jpeg', qualidade)));
    });
  }

  function dataUrlParaBlob(dataUrl) {
    const partes = dataUrl.split(',');
    const mime = partes[0].match(/:(.*?);/)[1];
    const bin = atob(partes[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function blobParaBase64(blob) {
    return new Promise((ok, erro) => {
      const fr = new FileReader();
      fr.onload = () => { const s = String(fr.result); ok(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = () => erro(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  function blobParaDataUrl(blob) {
    return new Promise((ok, erro) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result));
      fr.onerror = () => erro(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------
  // Geolocalização (tratamento gracioso quando negada)
  // ---------------------------------------------------------------
  function obterGeolocalizacao() {
    return new Promise((ok) => {
      if (!navigator.geolocation) {
        return ok({ latitude: null, longitude: null, precisao: null,
                    obs: 'Geolocalização não suportada pelo navegador.' });
      }
      let respondido = false;
      const tempo = setTimeout(() => {
        if (!respondido) {
          respondido = true;
          ok({ latitude: null, longitude: null, precisao: null,
               obs: 'Tempo esgotado ao obter a localização.' });
        }
      }, CONFIG.limites.timeoutGeolocalizacaoMs);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (respondido) return;
          respondido = true; clearTimeout(tempo);
          ok({
            latitude: +pos.coords.latitude.toFixed(6),
            longitude: +pos.coords.longitude.toFixed(6),
            precisao: pos.coords.accuracy ? Math.round(pos.coords.accuracy) : null,
            obs: null
          });
        },
        (err) => {
          if (respondido) return;
          respondido = true; clearTimeout(tempo);
          const motivos = {
            1: 'Permissão de localização negada pelo usuário.',
            2: 'Localização indisponível no momento.',
            3: 'Tempo esgotado ao obter a localização.'
          };
          ok({ latitude: null, longitude: null, precisao: null,
               obs: motivos[err.code] || 'Não foi possível obter a localização.' });
        },
        { enableHighAccuracy: true,
          timeout: CONFIG.limites.timeoutGeolocalizacaoMs,
          maximumAge: 60000 }
      );
    });
  }

  // ---------------------------------------------------------------
  // Auditoria
  // ---------------------------------------------------------------
  async function auditar(inspecaoId, acao, detalhe, usuario) {
    const p = (window.AUTH && AUTH.perfil) ? AUTH.perfil() : null;
    await db.auditoria.add({
      inspecaoId: inspecaoId || '(sistema)',
      usuarioId: usuarioAtual(),
      acao: acao,
      detalhe: detalhe || '',
      usuario: usuario || (p ? p.nome : 'não identificado'),
      dispositivo: dispositivo(),
      em: agora()
    });
  }

  // ---------------------------------------------------------------
  // CRUD de inspeções
  // ---------------------------------------------------------------

  /**
   * Modelo em branco já vinculado ao usuário autenticado.
   * O responsável não é mais digitável: vem do cadastro.
   */
  function novaInspecao() {
    const p = (window.AUTH && AUTH.perfil) ? AUTH.perfil() : null;
    const hoje = new Date();
    const iso = new Date(hoje.getTime() - hoje.getTimezoneOffset() * 60000)
                  .toISOString().slice(0, 10);
    const lotesUsuario = (window.AUTH && AUTH.lotes) ? AUTH.lotes() : [];
    return {
      id: uuid(),
      usuarioId: usuarioAtual(),
      dataInspecao: iso,
      responsavel: p ? p.nome : '',
      funcaoResponsavel: p ? p.funcao : '',
      emailResponsavel: p ? p.email : '',
      // Lote único do usuário já vem preenchido
      lote: lotesUsuario.length === 1 ? lotesUsuario[0] : '',
      canteiro: '',
      canteiroOutro: '',
      empresa: '',
      empresaOutro: '',
      inspecionado: [],
      inspecionadoOutro: '',
      checklist: {},          // { item: [{ pergunta, resposta: 'SIM'|'NÃO' }] }
      naoConformidade: 'Não',
      quais: '',
      observacoes: '',
      latitude: null,
      longitude: null,
      precisaoGps: null,
      obsGeo: null,
      dispositivo: dispositivo(),
      criadoEm: agora(),
      atualizadoEm: agora(),
      versao: 1,
      status: 'pendente',
      erroMsg: '',
      tentativas: 0,
      remotoId: null,
      sincronizadoEm: null,
      excluido: 0,
      excluidoEm: null
    };
  }

  /**
   * Grava (cria ou atualiza). Em edição, arquiva a versão anterior e
   * devolve o registro à fila de envio.
   */
  async function salvarInspecao(registro) {
    const anterior = await db.inspecoes.get(registro.id);
    const ehNovo = !anterior;

    if (anterior) {
      await db.versoes.add({
        inspecaoId: anterior.id,
        usuarioId: anterior.usuarioId,
        salvoEm: agora(),
        versao: anterior.versao || 1,
        conteudo: JSON.parse(JSON.stringify(anterior))
      });
      registro.criadoEm = anterior.criadoEm;
      registro.versao = (anterior.versao || 1) + 1;
      registro.remotoId = anterior.remotoId || null;
      registro.usuarioId = anterior.usuarioId;   // dono não muda
    } else if (!registro.usuarioId) {
      registro.usuarioId = usuarioAtual();
    }

    registro.atualizadoEm = agora();
    registro.excluido = registro.excluido ? 1 : 0;
    registro.status = 'pendente';
    registro.erroMsg = '';
    registro.tentativas = 0;

    await db.inspecoes.put(registro);
    await auditar(registro.id, ehNovo ? 'criacao' : 'edicao',
      ehNovo ? 'Registro criado no dispositivo.'
             : 'Registro editado (versão ' + registro.versao + ').',
      registro.responsavel);
    return registro;
  }

  /** O usuário logado pode ver este registro neste aparelho? */
  function podeVer(r, u) {
    u = u || usuarioAtual();
    if (!u || !r.usuarioId || r.usuarioId === u) return true;
    return !!(window.AUTH && AUTH.veTodas && AUTH.veTodas() && r.origem === 'servidor');
  }

  /** O registro é do usuário logado (pode editar/excluir)? */
  function ehMeu(r) {
    const u = usuarioAtual();
    return !!r && (!r.usuarioId || r.usuarioId === u);
  }

  async function obterInspecao(id) {
    const r = await db.inspecoes.get(id);
    if (!r) return null;
    // Barreira de tela: registro que o usuário não pode ver não é devolvido.
    if (!podeVer(r)) return null;
    return r;
  }

  /**
   * Grava uma inspeção recebida da base central. Nunca passa por cima de
   * uma edição local que ainda não subiu. Devolve true se gravou algo novo.
   */
  async function salvarRecebida(l) {
    const local = await db.inspecoes.get(l.id_local);
    if (local && (local.status === 'pendente' || local.status === 'erro')) return false;
    if (local && local.atualizadoEm && l.atualizado_em &&
        new Date(local.atualizadoEm).getTime() >= new Date(l.atualizado_em).getTime() &&
        local.origem !== 'servidor') {
      // É o nosso próprio envio voltando: só registra os caminhos das fotos.
      local.fotosRemotas = l.fotos || local.fotosRemotas || [];
      await db.inspecoes.put(local);
      return false;
    }
    const itens = Array.isArray(l.o_que_inspecionado) ? l.o_que_inspecionado : [];
    const reg = Object.assign({}, local || {}, {
      id: l.id_local,
      usuarioId: l.usuario_id,
      origem: (local && local.usuarioId === usuarioAtual() && local.origem !== 'servidor') ? 'aparelho' : 'servidor',
      responsavel: l.responsavel,
      funcaoResponsavel: l.funcao_responsavel || '',
      dataInspecao: l.data_inspecao,
      lote: l.lote,
      canteiro: l.canteiro, canteiroOutro: '',
      empresa: l.construtora, empresaOutro: '',
      inspecionado: itens, inspecionadoOutro: '',
      checklist: l.checklist || {},
      naoConformidade: l.nao_conformidade ? 'Sim' : 'Não',
      quais: l.quais || '',
      observacoes: l.observacoes || '',
      latitude: l.latitude, longitude: l.longitude, precisaoGps: l.precisao_gps,
      obsGeo: (l.latitude === null || l.latitude === undefined) ? 'Não capturada' : null,
      dispositivo: l.dispositivo || '',
      criadoEm: l.criado_em, atualizadoEm: l.atualizado_em,
      versao: l.versao || 1,
      status: 'sincronizado', erroMsg: '', tentativas: 0,
      sincronizadoEm: agora(),
      fotosRemotas: l.fotos || [],
      qtdFotosRemotas: l.qtd_fotos || (l.fotos || []).length,
      excluido: l.excluido ? 1 : 0,
      excluidoEm: l.excluido_em || null,
      motivoExclusao: l.motivo_exclusao || ''
    });
    await db.inspecoes.put(reg);
    return true;
  }

  /** Foto baixada da base para uma inspeção recebida. */
  async function salvarFotoRecebida(inspecaoId, meta, blob) {
    let largura = 0, altura = 0;
    try {
      const bmp = await createImageBitmap(blob);
      largura = bmp.width; altura = bmp.height;
      if (bmp.close) bmp.close();
    } catch (e) { /* dimensões são opcionais */ }
    await db.fotos.put({
      id: 'r-' + inspecaoId.slice(0, 8) + '-' + (meta.ordem || 0),
      inspecaoId: inspecaoId,
      blob: blob,
      legenda: meta.legenda || '',
      nome: String(meta.caminho || '').split('/').pop(),
      largura: largura, altura: altura,
      bytes: blob.size,
      ordem: meta.ordem || 0,
      criadoEm: agora(),
      enviada: 1,
      caminhoRemoto: meta.caminho
    });
  }

  async function marcarFotoRemota(fotoId, caminho) {
    await db.fotos.update(fotoId, { caminhoRemoto: caminho, enviada: 1 });
  }

  /** Exclusão LÓGICA, com motivo e trilha de auditoria. */
  async function excluirInspecao(id, motivo, usuario) {
    const reg = await obterInspecao(id);
    if (!reg) return false;
    await db.versoes.add({
      inspecaoId: id, usuarioId: reg.usuarioId, salvoEm: agora(),
      versao: reg.versao || 1, conteudo: JSON.parse(JSON.stringify(reg))
    });
    reg.excluido = 1;
    reg.excluidoEm = agora();
    reg.atualizadoEm = agora();
    reg.motivoExclusao = motivo || '';
    reg.status = 'pendente';
    await db.inspecoes.put(reg);
    await auditar(id, 'exclusao', 'Exclusão lógica. Motivo: ' + (motivo || 'não informado'), usuario);
    return true;
  }

  async function restaurarInspecao(id, usuario) {
    const reg = await obterInspecao(id);
    if (!reg) return false;
    reg.excluido = 0;
    reg.excluidoEm = null;
    reg.atualizadoEm = agora();
    reg.status = 'pendente';
    await db.inspecoes.put(reg);
    await auditar(id, 'restauracao', 'Registro restaurado.', usuario);
    return true;
  }

  /**
   * Lista as inspeções DO USUÁRIO AUTENTICADO, aplicando os filtros.
   * filtros = { de, ate, lote, lotes[], canteiro, empresa,
   *             naoConformidade, status, texto, incluirExcluidos,
   *             todosUsuarios }
   */
  async function listarInspecoes(filtros) {
    filtros = filtros || {};
    const u = usuarioAtual();
    let lista = await db.inspecoes.toArray();

    // Segregação por usuário: cada um vê o que é dele; o administrador
    // e quem tem visão "todas" veem também as inspeções recebidas da base
    // central (o servidor só entrega o que a pessoa tem direito de ver).
    lista = lista.filter(r => r.usuarioId !== 'legado-v1' && podeVer(r, u));

    // Segregação por lote do perfil
    const permitidos = (window.AUTH && AUTH.lotes) ? AUTH.lotes() : null;
    if (permitidos && permitidos.length) {
      lista = lista.filter(r => !r.lote || permitidos.indexOf(r.lote) !== -1);
    }

    if (!filtros.incluirExcluidos) lista = lista.filter(r => !r.excluido);
    if (filtros.de)    lista = lista.filter(r => r.dataInspecao >= filtros.de);
    if (filtros.ate)   lista = lista.filter(r => r.dataInspecao <= filtros.ate);
    if (filtros.lote)  lista = lista.filter(r => r.lote === filtros.lote);
    if (filtros.lotes && filtros.lotes.length) {
      lista = lista.filter(r => filtros.lotes.indexOf(r.lote) !== -1);
    }
    if (filtros.canteiro) lista = lista.filter(r => nomeCanteiro(r) === filtros.canteiro);
    if (filtros.empresa)  lista = lista.filter(r => nomeEmpresa(r) === filtros.empresa);
    if (filtros.naoConformidade) lista = lista.filter(r => r.naoConformidade === filtros.naoConformidade);
    if (filtros.status)   lista = lista.filter(r => r.status === filtros.status);
    if (filtros.responsavel) lista = lista.filter(r => r.responsavel === filtros.responsavel);

    if (filtros.texto) {
      const t = filtros.texto.toLowerCase().trim();
      lista = lista.filter(r => {
        const alvo = [
          r.responsavel, r.lote, nomeCanteiro(r), nomeEmpresa(r),
          (r.inspecionado || []).join(' '), r.inspecionadoOutro,
          r.quais, r.observacoes, r.id, r.dataInspecao
        ].join(' ').toLowerCase();
        return alvo.indexOf(t) !== -1;
      });
    }

    lista.sort((a, b) => (b.dataInspecao + b.criadoEm).localeCompare(a.dataInspecao + a.criadoEm));
    return lista;
  }

  function nomeCanteiro(r) {
    return r.canteiro === 'Outro' ? (r.canteiroOutro || 'Outro') : r.canteiro;
  }
  function nomeEmpresa(r) {
    return r.empresa === 'Outro' ? (r.empresaOutro || 'Outro') : r.empresa;
  }
  function itensInspecionados(r) {
    const itens = (r.inspecionado || []).slice();
    const rotuloOutro = (window.CONFIG && CONFIG.itemOutro) || 'Outros';
    const i = itens.indexOf(rotuloOutro);
    if (i !== -1 && r.inspecionadoOutro) itens[i] = rotuloOutro + ': ' + r.inspecionadoOutro;
    return itens;
  }

  // ---------------------------------------------------------------
  // Fotos
  // ---------------------------------------------------------------
  async function adicionarFoto(inspecaoId, arquivo, legenda) {
    const qtd = await db.fotos.where('inspecaoId').equals(inspecaoId).count();
    if (qtd >= CONFIG.limites.maxFotos) {
      throw new Error('Limite de ' + CONFIG.limites.maxFotos + ' fotos por inspeção atingido.');
    }
    const comp = await comprimirImagem(arquivo);
    const foto = {
      id: uuid(),
      inspecaoId: inspecaoId,
      blob: comp.blob,
      legenda: legenda || '',
      nome: 'foto_' + (qtd + 1) + '.jpg',
      largura: comp.largura,
      altura: comp.altura,
      bytes: comp.bytes,
      ordem: qtd + 1,
      criadoEm: agora(),
      enviada: 0
    };
    await db.fotos.add(foto);
    return foto;
  }

  async function listarFotos(inspecaoId) {
    const fotos = await db.fotos.where('inspecaoId').equals(inspecaoId).toArray();
    fotos.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
    return fotos;
  }

  async function removerFoto(fotoId) { await db.fotos.delete(fotoId); }
  async function atualizarLegenda(fotoId, legenda) { await db.fotos.update(fotoId, { legenda: legenda }); }
  async function removerFotosDaInspecao(id) { await db.fotos.where('inspecaoId').equals(id).delete(); }
  async function contarFotos(id) {
    const n = await db.fotos.where('inspecaoId').equals(id).count();
    if (n) return n;
    const r = await db.inspecoes.get(id);           // recebida da base: fotos ainda não baixadas
    return (r && r.qtdFotosRemotas) || 0;
  }

  // ---------------------------------------------------------------
  // Fila de sincronização (por usuário)
  // ---------------------------------------------------------------
  async function listarPendentes() {
    const u = usuarioAtual();
    const lista = await db.inspecoes.toArray();
    return lista
      .filter(r => r.usuarioId === u)
      .filter(r => r.status === 'pendente' || r.status === 'erro')
      .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  }

  async function contarPorStatus() {
    const u = usuarioAtual();
    const lista = (await db.inspecoes.toArray()).filter(r => r.usuarioId === u && !r.excluido);
    return {
      total: lista.length,
      pendente: lista.filter(r => r.status === 'pendente').length,
      sincronizado: lista.filter(r => r.status === 'sincronizado').length,
      erro: lista.filter(r => r.status === 'erro').length
    };
  }

  async function marcarStatus(id, status, mensagem, remotoId, atualizadoEmEnviado) {
    const reg = await db.inspecoes.get(id);
    if (!reg) return;
    // Editado enquanto subia: continua pendente para subir a versão nova.
    if (status === 'sincronizado' && atualizadoEmEnviado && reg.atualizadoEm !== atualizadoEmEnviado) return;
    reg.status = status;
    reg.erroMsg = mensagem || '';
    if (remotoId) reg.remotoId = remotoId;
    if (status === 'sincronizado') {
      reg.sincronizadoEm = agora();
      reg.tentativas = 0;
      await db.fotos.where('inspecaoId').equals(id).modify({ enviada: 1 });
    } else if (status === 'erro') {
      reg.tentativas = (reg.tentativas || 0) + 1;
    }
    await db.inspecoes.put(reg);
  }

  async function registrarLogSync(entrada) {
    entrada.em = agora();
    entrada.usuarioId = usuarioAtual();
    await db.syncLog.add(entrada);
    const total = await db.syncLog.count();
    if (total > 100) {
      const antigas = await db.syncLog.orderBy('seq').limit(total - 100).toArray();
      await db.syncLog.bulkDelete(antigas.map(e => e.seq));
    }
  }

  async function listarLogsSync(limite) {
    const u = usuarioAtual();
    const todos = await db.syncLog.orderBy('seq').reverse().toArray();
    return todos.filter(l => !l.usuarioId || l.usuarioId === u).slice(0, limite || 20);
  }

  async function listarAuditoria(inspecaoId) {
    const l = await db.auditoria.where('inspecaoId').equals(inspecaoId).toArray();
    l.sort((a, b) => b.em.localeCompare(a.em));
    return l;
  }

  async function listarVersoes(inspecaoId) {
    const l = await db.versoes.where('inspecaoId').equals(inspecaoId).toArray();
    l.sort((a, b) => b.salvoEm.localeCompare(a.salvoEm));
    return l;
  }

  // ---------------------------------------------------------------
  // Armazenamento
  // ---------------------------------------------------------------
  async function estimativaArmazenamento() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        const usado = e.usage || 0, cota = e.quota || 0;
        return { usado: usado, cota: cota,
                 percentual: cota ? (usado / cota) * 100 : 0, suportado: true };
      } catch (err) { /* cai no cálculo aproximado */ }
    }
    const fotos = await db.fotos.toArray();
    const bytes = fotos.reduce((s, f) => s + (f.bytes || 0), 0);
    return { usado: bytes, cota: 0, percentual: 0, suportado: false };
  }

  async function solicitarPersistencia() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch (e) { return false; }
    }
    return false;
  }

  // ---------------------------------------------------------------
  // Exportação para backup manual
  // ---------------------------------------------------------------
  async function exportarJSON(comFotos, tudo) {
    const u = usuarioAtual();
    const todas = await db.inspecoes.toArray();
    const inspecoes = tudo ? todas : todas.filter(r => r.usuarioId === u);
    const p = (window.AUTH && AUTH.perfil) ? AUTH.perfil() : null;
    const saida = {
      aplicacao: CONFIG.app.nome,
      versao: CONFIG.app.versao,
      exportadoEm: agora(),
      exportadoPor: p ? { nome: p.nome, email: p.email, lotes: p.lotes } : null,
      totalInspecoes: inspecoes.length,
      inspecoes: [],
      auditoria: await db.auditoria.toArray()
    };
    for (const reg of inspecoes) {
      const item = JSON.parse(JSON.stringify(reg));
      const fotos = await listarFotos(reg.id);
      item.fotos = [];
      for (const f of fotos) {
        const meta = { id: f.id, nome: f.nome, legenda: f.legenda,
                       bytes: f.bytes, largura: f.largura, altura: f.altura };
        if (comFotos !== false) meta.base64 = await blobParaBase64(f.blob);
        item.fotos.push(meta);
      }
      saida.inspecoes.push(item);
    }
    return JSON.stringify(saida, null, 2);
  }

  /**
   * Planilha do usuário em CSV (separador ";" e BOM UTF-8: o Excel em
   * português abre com os acentos certos e as colunas separadas).
   * @param {object} filtros - { de, ate } opcionais
   */
  async function exportarCSV(filtros) {
    filtros = filtros || {};
    const lista = await listarInspecoes({
      de: filtros.de || null, ate: filtros.ate || null, incluirExcluidos: false
    });
    const cab = ['ID Local', 'Data Inspecao', 'Responsavel', 'Funcao', 'Lote', 'Canteiro',
                 'Construtora', 'O que foi inspecionado', 'Nao Conformidade',
                 'Quais', 'Observacoes', 'Latitude', 'Longitude', 'Qtd Fotos',
                 'Data Criacao', 'Ultima Edicao', 'Dispositivo'];

    // Checklist: uma coluna por pergunta (vazia quando o item não foi
    // inspecionado) + total de respostas NÃO — pronto para o Power BI.
    const colunasCk = [];
    Object.keys(CONFIG.checklists || {}).forEach(item => {
      CONFIG.perguntasDoItem(item).forEach((perg, k) => {
        colunasCk.push({ item: item, pergunta: perg,
          titulo: item + ' ' + String(k + 1).padStart(2, '0') + ' - ' + perg });
      });
    });
    colunasCk.forEach(c => cab.push(c.titulo));
    cab.push('Checklist Qtd NAO');

    const linhas = [cab.map(csvCampo).join(';')];
    for (const r of lista) {
      const qtd = await contarFotos(r.id);
      const cols = [
        r.id, r.dataInspecao, r.responsavel, r.funcaoResponsavel || '',
        r.lote, nomeCanteiro(r), nomeEmpresa(r),
        itensInspecionados(r).join(' | '), r.naoConformidade, r.quais, r.observacoes,
        r.latitude === null ? '' : String(r.latitude).replace('.', ','),
        r.longitude === null ? '' : String(r.longitude).replace('.', ','),
        qtd, r.criadoEm, r.atualizadoEm, r.dispositivo
      ];
      const ck = r.checklist || {};
      let qtdNao = 0;
      colunasCk.forEach(c => {
        const achou = (ck[c.item] || []).filter(q => q.pergunta === c.pergunta)[0];
        const resp = achou ? achou.resposta : '';
        if (resp === 'NÃO') qtdNao++;
        cols.push(resp);
      });
      // Respostas a perguntas que depois saíram do config.js também contam
      Object.keys(ck).forEach(item => (ck[item] || []).forEach(q => {
        const listada = colunasCk.some(c => c.item === item && c.pergunta === q.pergunta);
        if (!listada && q.resposta === 'NÃO') qtdNao++;
      }));
      cols.push(qtdNao);
      linhas.push(cols.map(csvCampo).join(';'));
    }
    return '﻿' + linhas.join('\r\n');
  }

  function csvCampo(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return /[;"]/.test(s) ? '"' + s + '"' : s;
  }

  /** Apaga a base local INTEIRA (manutenção; pede confirmação na tela). */
  async function limparTudo() {
    await db.transaction('rw', db.inspecoes, db.fotos, db.versoes, db.auditoria, db.syncLog,
      async () => {
        await db.inspecoes.clear();
        await db.fotos.clear();
        await db.versoes.clear();
        await db.auditoria.clear();
        await db.syncLog.clear();
      });
  }

  // ---------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------
  return {
    db: db,
    uuid: uuid,
    agora: agora,
    dispositivo: dispositivo,
    usuarioAtual: usuarioAtual,
    kvGet: kvGet,
    kvSet: kvSet,
    contarUsuariosLocais: contarUsuariosLocais,
    listarUsuariosLocais: listarUsuariosLocais,
    obterUsuarioLocalPorEmail: obterUsuarioLocalPorEmail,
    criarUsuarioLocal: criarUsuarioLocal,
    atualizarUsuarioLocal: atualizarUsuarioLocal,
    migrarRegistrosLocais: migrarRegistrosLocais,
    novaInspecao: novaInspecao,
    salvarInspecao: salvarInspecao,
    salvarRecebida: salvarRecebida,
    salvarFotoRecebida: salvarFotoRecebida,
    marcarFotoRemota: marcarFotoRemota,
    podeVer: podeVer,
    ehMeu: ehMeu,
    obterInspecao: obterInspecao,
    listarInspecoes: listarInspecoes,
    excluirInspecao: excluirInspecao,
    restaurarInspecao: restaurarInspecao,
    adicionarFoto: adicionarFoto,
    listarFotos: listarFotos,
    removerFoto: removerFoto,
    removerFotosDaInspecao: removerFotosDaInspecao,
    atualizarLegenda: atualizarLegenda,
    contarFotos: contarFotos,
    comprimirImagem: comprimirImagem,
    blobParaBase64: blobParaBase64,
    blobParaDataUrl: blobParaDataUrl,
    obterGeolocalizacao: obterGeolocalizacao,
    listarPendentes: listarPendentes,
    contarPorStatus: contarPorStatus,
    marcarStatus: marcarStatus,
    registrarLogSync: registrarLogSync,
    listarLogsSync: listarLogsSync,
    listarAuditoria: listarAuditoria,
    listarVersoes: listarVersoes,
    auditar: auditar,
    estimativaArmazenamento: estimativaArmazenamento,
    solicitarPersistencia: solicitarPersistencia,
    exportarJSON: exportarJSON,
    exportarCSV: exportarCSV,
    limparTudo: limparTudo,
    nomeCanteiro: nomeCanteiro,
    nomeEmpresa: nomeEmpresa,
    itensInspecionados: itensInspecionados
  };
})();

window.DB = DB;
