// ============================================================
// AGENDA OLHATTA — lógica do app
// ============================================================

// ---------- Firebase init ----------
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Persistência offline: se a internet cair no meio do trabalho, o app continua
// funcionando local e sincroniza sozinho assim que a conexão voltar.
db.enablePersistence({ synchronizeTabs: true }).catch(() => { /* navegador sem suporte ou várias abas — segue sem persistência offline */ });

const docRef = db.collection('olhatta').doc('agendamentos');
const entriesCol = docRef.collection('entries');
// Cada contato/agendamento é o SEU PRÓPRIO documento dentro de "entries".
// Isso evita que duas edições ao mesmo tempo (você e a Dra., por exemplo)
// apaguem uma a outra — cada gravação mexe só no contato dela mesma.

// Notas Fiscais: coleção TOTALMENTE separada da de agendamentos — mesmo app,
// mesma conta Google, mas os dados não se misturam (um lançamento de NF não
// vira contato de agendamento e vice-versa).
const nfDocRef = db.collection('olhatta').doc('notas-fiscais');
const nfEntriesCol = nfDocRef.collection('entries');

// ---------- Categorias padrão (usadas na 1ª criação do documento) ----------
const CATEGORIAS_PADRAO = {
  clinicas: ['Olhatta', 'Pet Center', 'Espaço Pet', 'Equibem', 'Domicílio', 'Volante'],
  cidades: ['Sinop', 'Lucas do Rio Verde'],
  tipos: ['Consulta', 'Acompanhamento', 'Cirurgia'],
  motivos: ['Sem Resposta', 'Sem Interesse', 'Sem Deslocamento', 'Sem Condições', 'Outro Profissional', 'Fora de Horário', 'Não Compareceu', 'Óbito']
};

const STATUS_AGENDADOS = ['Agendado', 'Realizado'];
const STATUS_NAO_AGENDADOS = ['Desmarcou', 'Não Agendou'];
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MESES_ABREV = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

// ---------- Estado local ----------
let state = {
  entries: [],
  categorias: JSON.parse(JSON.stringify(CATEGORIAS_PADRAO)),
  metas: {},
  nf: { servicosSalvos: [] },
  nfEntries: [],
  linksUteis: [],
  linksUteisNf: [],
  relatorioObs: {}
};
let carregouDoc = false;
let carregouEntries = false;
let carregouNfDoc = false;
let carregouNfEntries = false;
let currentDate = new Date();          // controla mês/ano da aba Agendamentos
let nfCurrentDate = new Date();        // controla mês/ano da aba Notas Fiscais
let anoAnual = new Date().getFullYear(); // controla ano da aba Comparativo Anual
let relatorioModo = 'mensal';            // 'mensal' ou 'semanal' — aba Relatórios
let relatorioMesData = new Date();       // mês mostrado no relatório mensal
let relatorioSemanaInicio = inicioSemanaDe(new Date()); // segunda-feira da semana mostrada no relatório semanal
let editingEntryId = null;
let editingNfId = null;
let nfNomeSincronizado = true; // enquanto true, "Nome completo (NF)" copia o que for digitado em "Cliente"
// lista de abas válidas pra endereço do site (#relatorios etc.) — mesmos
// valores dos data-aba dos botões da barra lateral; "relatorios" também
// aceita uma subaba depois da barra (#relatorios/semanal), pro endereço
// copiado levar direto pro Mensal ou Semanal certo, não só pra aba
const ABAS_VALIDAS = ['inicio', 'agendamentos', 'metas', 'anual', 'relatorios', 'notas'];
const SUBABAS_VALIDAS = { relatorios: ['mensal', 'semanal'] };

// lê a aba (e a subaba, se tiver) do endereço do site; se o link foi
// aberto com algo tipo ".../#relatorios/semanal", já abre direto lá — a
// subaba lida aqui já atualiza relatorioModo também
function abaDaUrl() {
  const partes = (location.hash || '').replace('#', '').split('/');
  const aba = ABAS_VALIDAS.includes(partes[0]) ? partes[0] : 'inicio';
  const sub = partes[1];
  if (SUBABAS_VALIDAS[aba] && SUBABAS_VALIDAS[aba].includes(sub)) relatorioModo = sub;
  return aba;
}
let abaAtiva = abaDaUrl();
let navegacaoInicialPronta = false; // garante que o endereço inicial só é normalizado uma vez
let filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '', motivo: '', iniciativa: '', periodo: '' };
let nfFiltros = { busca: '', cidade: '', querNf: '', periodo: '', dataInicio: '', dataFim: '' };
let inicioData = hojeStr(); // data escolhida na aba Início (padrão: hoje)
let ordemPendentes = 'asc'; // ordem de "Contatos pendentes": asc = mais próximos primeiro
try { ordemPendentes = localStorage.getItem('agendaOlhatta_ordem_pendentes') === 'desc' ? 'desc' : 'asc'; } catch (e) { /* sem acesso ao localStorage — segue com asc */ }
let ordenacao = { campo: null, asc: true }; // null = ordem padrão (por data)
let unsubDoc = null;
let unsubEntries = null;
let unsubNfDoc = null;
let unsubNfEntries = null;
let statusSincronizacao = 'ok'; // 'ok' | 'salvando' | 'erro'

// ============================================================
// AUTENTICAÇÃO
// ============================================================
document.getElementById('btn-login-google').addEventListener('click', () => {
  const provider = new firebase.auth.GoogleAuthProvider();
  document.getElementById('login-status').textContent = 'Abrindo login do Google...';
  document.getElementById('login-erro').style.display = 'none';
  auth.signInWithPopup(provider).catch(err => {
    document.getElementById('login-status').textContent = '';
    document.getElementById('login-erro').textContent = 'Não foi possível entrar: ' + err.message;
    document.getElementById('login-erro').style.display = 'block';
  });
});

document.getElementById('btn-logout').addEventListener('click', () => auth.signOut());

auth.onAuthStateChanged(user => {
  // esconde a tela de "carregando" assim que o Firebase termina de conferir
  // se já existe uma sessão salva — só depois disso decide o que mostrar,
  // pra login/app não aparecerem piscando por engano nesse meio-tempo.
  document.getElementById('tela-carregando').style.display = 'none';

  if (user) {
    const email = (user.email || '').toLowerCase();
    const permitido = EMAILS_PERMITIDOS.map(e => e.toLowerCase()).includes(email);
    if (!permitido) {
      document.getElementById('tela-login').classList.add('mostrar');
      document.getElementById('login-erro').style.display = 'block';
      document.getElementById('login-status').textContent = '';
      auth.signOut();
      return;
    }
    document.getElementById('tela-login').classList.remove('mostrar');
    document.getElementById('app').style.display = 'block';
    document.getElementById('user-email').textContent = user.email;
    // deixa o endereço do site já mostrando "#aba" desde a entrada (mesmo
    // quando abriu sem nenhum # na URL), pra copiar o link funcionar mesmo
    // sem ter trocado de aba ainda
    if (!navegacaoInicialPronta) {
      navegacaoInicialPronta = true;
      history.replaceState({ olhattaNav: true, tipo: 'aba', aba: abaAtiva }, '', urlDaAba(abaAtiva));
    }
    iniciarEscuta();
    iniciarEscutaNF();
  } else {
    document.getElementById('tela-login').classList.add('mostrar');
    document.getElementById('app').style.display = 'none';
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    if (unsubEntries) { unsubEntries(); unsubEntries = null; }
    if (unsubNfDoc) { unsubNfDoc(); unsubNfDoc = null; }
    if (unsubNfEntries) { unsubNfEntries(); unsubNfEntries = null; }
    carregouDoc = false;
    carregouEntries = false;
    carregouNfDoc = false;
    carregouNfEntries = false;
  }
});

// ============================================================
// FIRESTORE — carregar / salvar
// ============================================================
function iniciarEscuta() {
  if (!unsubDoc) {
    unsubDoc = docRef.onSnapshot(snap => {
      if (!snap.exists) {
        docRef.set({ categorias: CATEGORIAS_PADRAO, metas: {} });
        return;
      }
      const d = snap.data();
      state.categorias = d.categorias && Object.keys(d.categorias).length ? d.categorias : CATEGORIAS_PADRAO;
      ['clinicas','cidades','tipos','motivos'].forEach(k => { if (!Array.isArray(state.categorias[k])) state.categorias[k] = []; });
      state.metas = d.metas || {};
      state.linksUteis = Array.isArray(d.linksUteis) ? d.linksUteis : [];
      state.linksUteisNf = Array.isArray(d.linksUteisNf) ? d.linksUteisNf : [];
      state.relatorioObs = d.relatorioObs || {};
      carregouDoc = true;
      atualizarStatusSync(snap.metadata.hasPendingWrites);
      renderTudo();
    }, err => {
      mostrarToast('Erro ao carregar categorias/metas: ' + err.message);
      atualizarStatusSync(false, true);
    });
  }
  if (!unsubEntries) {
    unsubEntries = entriesCol.onSnapshot(snap => {
      state.entries = snap.docs.map(doc => doc.data());
      carregouEntries = true;
      atualizarStatusSync(snap.metadata.hasPendingWrites);
      renderTudo();
    }, err => {
      mostrarToast('Erro ao carregar contatos: ' + err.message);
      atualizarStatusSync(false, true);
    });
  }
}

function iniciarEscutaNF() {
  if (!unsubNfDoc) {
    unsubNfDoc = nfDocRef.onSnapshot(snap => {
      if (!snap.exists) {
        nfDocRef.set({ servicosSalvos: [] });
        return;
      }
      const d = snap.data();
      state.nf.servicosSalvos = Array.isArray(d.servicosSalvos) ? d.servicosSalvos : [];
      carregouNfDoc = true;
      atualizarStatusSync(snap.metadata.hasPendingWrites);
      renderTudo();
    }, err => {
      mostrarToast('Erro ao carregar serviços: ' + err.message);
      atualizarStatusSync(false, true);
    });
  }
  if (!unsubNfEntries) {
    unsubNfEntries = nfEntriesCol.onSnapshot(snap => {
      state.nfEntries = snap.docs.map(doc => doc.data());
      carregouNfEntries = true;
      atualizarStatusSync(snap.metadata.hasPendingWrites);
      renderTudo();
    }, err => {
      mostrarToast('Erro ao carregar notas fiscais: ' + err.message);
      atualizarStatusSync(false, true);
    });
  }
}

function atualizarStatusSync(pendente, erro) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  if (erro) { el.textContent = 'Erro ao sincronizar'; el.className = 'sync-status erro'; return; }
  if (pendente) { el.textContent = 'Sincronizando...'; el.className = 'sync-status pendente'; return; }
  el.textContent = 'Sincronizado'; el.className = 'sync-status ok';
}

// ---- Contatos/agendamentos: cada um é um documento na subcoleção "entries" ----
function criarContato(dados) {
  const ref = entriesCol.doc();
  dados.id = ref.id;
  return ref.set(dados);
}
function atualizarContato(id, dados) {
  dados.id = id;
  return entriesCol.doc(id).set(dados);
}
function excluirContato(id) {
  return entriesCol.doc(id).delete();
}

// ---- Notas Fiscais: cada lançamento é o SEU PRÓPRIO documento na subcoleção "entries" ----
function criarNf(dados) {
  const ref = nfEntriesCol.doc();
  dados.id = ref.id;
  return ref.set(dados);
}
function atualizarNf(id, dados) {
  dados.id = id;
  return nfEntriesCol.doc(id).set(dados);
}
function excluirNf(id) {
  return nfEntriesCol.doc(id).delete();
}
// Marca/desmarca "feito" com um clique só na tabela, sem abrir o formulário
// inteiro — pra ela só confirmar que a nota foi emitida rapidinho
function nfToggleFeito(entry) {
  if (!entry) return;
  const novoFeito = !entry.feito;
  const dados = Object.assign({}, entry, {
    feito: novoFeito,
    dataNF: novoFeito ? (entry.dataNF || hojeStr()) : ''
  });
  atualizarNf(entry.id, dados)
    .then(() => mostrarToast(novoFeito ? 'Nota marcada como feita' : 'Nota marcada como pendente'))
    .catch(err => mostrarToast('Não foi possível salvar: ' + err.message));
}
// Marca/desmarca "quer enviar a nota" com um clique só na tabela — a maioria
// dos clientes não pede nota, então isso fica desmarcado por padrão (ver
// criarNf/abrirModalNf) e ela só liga quando o cliente realmente pede
function nfToggleQuerNf(entry) {
  if (!entry) return;
  const novoQuerNf = !entry.querNf;
  const dados = Object.assign({}, entry, { querNf: novoQuerNf });
  atualizarNf(entry.id, dados)
    .then(() => mostrarToast(novoQuerNf ? 'Marcado pra enviar a nota' : 'Marcado pra não enviar a nota'))
    .catch(err => mostrarToast('Não foi possível salvar: ' + err.message));
}
// Acha outro lançamento AINDA PENDENTE do mesmo cliente (mesmo telefone ou CPF),
// pra sugerir unir os dois numa nota só. Nunca aponta pra um lançamento já feito —
// se um dos dois já foi emitido, não tem como unir (ela confirmou essa regra).
function nfDuplicataPendente(entry) {
  if (!entry || entry.feito) return null;
  const telNorm = normalizarTelefone(entry.telefone);
  const cpfNorm = (entry.cpf || '').replace(/\D/g, '');
  if (telNorm.length < 8 && cpfNorm.length !== 11) return null;
  return state.nfEntries.find(e => {
    if (e.id === entry.id || e.feito) return false;
    const eTel = normalizarTelefone(e.telefone);
    const eCpf = (e.cpf || '').replace(/\D/g, '');
    return (telNorm.length >= 8 && eTel === telNorm) || (cpfNorm.length === 11 && eCpf === cpfNorm);
  }) || null;
}
// Une dois lançamentos pendentes do mesmo cliente numa nota só, somando os
// valores — pra ela não ter que calcular na mão quando o cliente faz 2 compras
// separadas e ambas as notas ainda estão pendentes.
function unirNfsPendentes(a, b) {
  if (!a || !b || a.feito || b.feito) { mostrarToast('Só dá pra unir lançamentos que ainda estão pendentes'); return; }
  const cobradoSoma = (Number(a.cobrado)||0) + (Number(b.cobrado)||0);
  const splitsSoma = (Number(a.splits)||0) + (Number(b.splits)||0);
  const valorNotaSoma = Math.max(0, cobradoSoma - splitsSoma);
  const confirmado = confirm(
    `Unir os 2 lançamentos pendentes de ${a.cliente || 'cliente'}?\n\n` +
    `R$ ${formatarMoeda(a.cobrado)} + R$ ${formatarMoeda(b.cobrado)} = R$ ${formatarMoeda(cobradoSoma)} cobrado\n` +
    `Nota ficará em R$ ${formatarMoeda(valorNotaSoma)}\n\n` +
    `O outro lançamento (de ${formatarData(b.dataPagamento)}) será apagado e tudo somado neste.`
  );
  if (!confirmado) return;
  const servicosUnidos = Array.from(new Set([].concat(a.servicos||[], b.servicos||[])));
  const dados = Object.assign({}, a, {
    cobrado: cobradoSoma,
    splits: splitsSoma,
    valorNota: valorNotaSoma,
    servicos: servicosUnidos
  });
  atualizarNf(a.id, dados)
    .then(() => excluirNf(b.id))
    .then(() => mostrarToast('Lançamentos unidos numa nota só'))
    .catch(err => mostrarToast('Não foi possível unir: ' + err.message));
}
function adicionarServico(valor) {
  return nfDocRef.update({ servicosSalvos: firebase.firestore.FieldValue.arrayUnion(valor) });
}
function removerServico(valor) {
  return nfDocRef.update({ servicosSalvos: firebase.firestore.FieldValue.arrayRemove(valor) });
}
// Renomear = trocar o valor dentro do array inteiro (não dá pra usar
// arrayUnion/arrayRemove pra isso, por isso grava a lista completa)
function renomearServico(valorAntigo, valorNovo) {
  const lista = (state.nf.servicosSalvos || []).slice();
  const idx = lista.indexOf(valorAntigo);
  if (idx === -1) return Promise.reject(new Error('Serviço não encontrado'));
  if (lista.includes(valorNovo)) return Promise.reject(new Error('Já existe um serviço com esse nome'));
  lista[idx] = valorNovo;
  return nfDocRef.update({ servicosSalvos: lista });
}

// ---- Categorias: arrayUnion/arrayRemove são operações atômicas no Firestore —
// duas pessoas mexendo ao mesmo tempo não apagam a alteração uma da outra ----
function adicionarCategoria(chave, valor) {
  return docRef.update({ ['categorias.' + chave]: firebase.firestore.FieldValue.arrayUnion(valor) });
}
function removerCategoria(chave, valor) {
  return docRef.update({ ['categorias.' + chave]: firebase.firestore.FieldValue.arrayRemove(valor) });
}

// ---- Metas: grava só o campo alterado (não o mês inteiro), pra não sobrescrever
// outra alteração feita ao mesmo tempo em outro campo do mesmo mês ----
function salvarCampoMeta(mesKey, campo, valor) {
  return docRef.update({ ['metas.' + mesKey + '.' + campo]: valor });
}

// ---- Observação do relatório: uma por período (um texto pro mês de outubro,
// outro pra semana de 19/10 a 25/10 etc.), grava só a chave daquele período ----
function salvarObservacaoRelatorio(chave, valor) {
  return docRef.update({ ['relatorioObs.' + chave]: valor });
}

// ---- Links úteis: botões de atalho que ela mesma cadastra (ex: planilha,
// WhatsApp da clínica, site) — Agendamentos e Notas Fiscais têm cada um a
// SUA PRÓPRIA listinha agora (campos separados no Firestore), pra não misturar
// atalhos de um módulo com o outro
const LINKS_CONTEXTOS = {
  agendamentos: { campo: 'linksUteis', grid: 'links-uteis-grid', vazio: 'links-uteis-vazio' },
  nf: { campo: 'linksUteisNf', grid: 'links-uteis-grid-nf', vazio: 'links-uteis-vazio-nf' }
};
function salvarLinksUteis(campo, lista) {
  return docRef.update({ [campo]: lista });
}
function normalizarUrl(url) {
  url = (url || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

let editingLinkContexto = 'agendamentos';
let editingLinkIdx = null;
function renderLinksUteis() {
  Object.keys(LINKS_CONTEXTOS).forEach(ctx => {
    const { campo, grid, vazio } = LINKS_CONTEXTOS[ctx];
    const lista = state[campo] || [];
    const cont = document.getElementById(grid);
    const elVazio = document.getElementById(vazio);
    if (!cont) return;
    elVazio.hidden = lista.length !== 0;
    cont.innerHTML = lista.map((l, i) => `
      <div class="link-chip">
        <a href="${escapeHtml(normalizarUrl(l.url))}" target="_blank" rel="noopener">${escapeHtml(l.nome||'Link')}</a>
        <button type="button" class="link-acao link-editar" data-idx="${i}" title="Editar">&#9998;</button>
        <button type="button" class="link-acao link-excluir" data-idx="${i}" title="Excluir">&times;</button>
      </div>
    `).join('');
    cont.querySelectorAll('.link-editar').forEach(btn => {
      btn.addEventListener('click', () => abrirModalLink(ctx, Number(btn.dataset.idx)));
    });
    cont.querySelectorAll('.link-excluir').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        if (!confirm('Excluir este link?')) return;
        const nova = state[campo].slice();
        nova.splice(idx, 1);
        salvarLinksUteis(campo, nova).catch(err => mostrarToast('Não foi possível excluir: ' + err.message));
      });
    });
  });
}
function abrirModalLink(contexto, idx) {
  editingLinkContexto = contexto;
  editingLinkIdx = (idx === null || idx === undefined) ? null : idx;
  const campo = LINKS_CONTEXTOS[contexto].campo;
  const l = editingLinkIdx !== null ? state[campo][editingLinkIdx] : null;
  document.getElementById('link-titulo').textContent = l ? 'Editar link' : 'Novo link';
  document.getElementById('link-f-nome').value = l ? l.nome||'' : '';
  document.getElementById('link-f-url').value = l ? l.url||'' : '';
  document.getElementById('btn-excluir-link').hidden = !l;
  abrirOverlay('modal-link');
  document.getElementById('modal-link').scrollTop = 0;
}
function fecharModalLink() { fecharOverlay('modal-link'); }
document.getElementById('btn-add-link').addEventListener('click', () => abrirModalLink('agendamentos', null));
document.getElementById('btn-add-link-nf').addEventListener('click', () => abrirModalLink('nf', null));
document.getElementById('fechar-modal-link').addEventListener('click', fecharModalLink);
document.getElementById('btn-cancelar-link').addEventListener('click', fecharModalLink);
document.getElementById('form-link').addEventListener('submit', ev => {
  ev.preventDefault();
  const nome = document.getElementById('link-f-nome').value.trim();
  const url = normalizarUrl(document.getElementById('link-f-url').value);
  if (!nome || !url) return;
  const campo = LINKS_CONTEXTOS[editingLinkContexto].campo;
  const nova = (state[campo]||[]).slice();
  if (editingLinkIdx !== null) nova[editingLinkIdx] = { nome, url };
  else nova.push({ nome, url });
  salvarLinksUteis(campo, nova).then(() => { mostrarToast('Link salvo'); fecharModalLink(); })
    .catch(err => mostrarToast('Não foi possível salvar: ' + err.message));
});
document.getElementById('btn-excluir-link').addEventListener('click', () => {
  if (editingLinkIdx === null) return;
  if (!confirm('Excluir este link?')) return;
  const campo = LINKS_CONTEXTOS[editingLinkContexto].campo;
  const nova = state[campo].slice();
  nova.splice(editingLinkIdx, 1);
  salvarLinksUteis(campo, nova).then(() => { mostrarToast('Link excluído'); fecharModalLink(); })
    .catch(err => mostrarToast('Não foi possível excluir: ' + err.message));
});

// ---------- Pesquisa universal: acha em Agendamentos e Notas Fiscais juntos ----------
function buscaUniversal(query) {
  const q = normalizarTexto(query.trim());
  if (q.length < 2) return [];
  const qDigitos = q.replace(/\D/g, '');
  const bate = (e, campos) => campos.some(c => normalizarTexto(e[c]).includes(q)) ||
    (qDigitos.length >= 3 && normalizarTelefone(e.telefone).includes(qDigitos));

  const resAgendamentos = state.entries
    .filter(e => bate(e, ['nome','animal','telefone','clinica','cidade','motivo','obs']))
    .slice(0, 8)
    .map(e => ({ tipo: 'agendamento', entry: e, titulo: e.nome || '(sem nome)', det: [e.animal, e.clinica, formatarData(e.dataContato)].filter(Boolean).join(' · ') }));

  const resNf = state.nfEntries
    .filter(e => bate(e, ['cliente','animal','telefone','nomeNf','cpf','obs']))
    .slice(0, 8)
    .map(e => ({ tipo: 'nf', entry: e, titulo: e.cliente || '(sem nome)', det: ['NF', formatarData(e.dataPagamento), 'R$ ' + formatarMoeda(e.valorNota)].filter(Boolean).join(' · ') }));

  return resAgendamentos.concat(resNf).slice(0, 14);
}
function renderResultadosPesquisa(query) {
  const cont = document.getElementById('pesquisa-universal-resultados');
  const resultados = buscaUniversal(query);
  if (!query.trim()) { cont.innerHTML = '<div class="pesquisa-vazia">Digite pra buscar em agendamentos e notas fiscais.</div>'; return; }
  if (!resultados.length) { cont.innerHTML = '<div class="pesquisa-vazia">Nada encontrado.</div>'; return; }
  cont.innerHTML = resultados.map((r, i) => `
    <button type="button" class="resultado-pesquisa" data-idx="${i}">
      <span class="rp-tipo ${r.tipo}">${r.tipo === 'nf' ? 'NF' : 'Agenda'}</span>
      <span class="rp-corpo"><span class="rp-nome">${escapeHtml(r.titulo)}</span><br><span class="rp-det">${escapeHtml(r.det)}</span></span>
    </button>
  `).join('');
  cont.querySelectorAll('.resultado-pesquisa').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = resultados[Number(btn.dataset.idx)];
      // fecha só visualmente aqui (sem mexer no histórico) — já que na
      // sequência abrimos aba+modal novos, que empilham suas próprias
      // entradas; chamar history.back() bem antes disso entraria em
      // conflito com os pushState logo em seguida
      document.getElementById('modal-pesquisa').hidden = true;
      if (r.tipo === 'agendamento') {
        navegarParaAba('agendamentos');
        abrirModalEntry(r.entry);
      } else {
        navegarParaAba('notas');
        abrirModalNf(r.entry);
      }
    });
  });
}
function abrirModalPesquisa() {
  abrirOverlay('modal-pesquisa');
  document.getElementById('modal-pesquisa').scrollTop = 0;
  const input = document.getElementById('pesquisa-universal-input');
  input.value = '';
  renderResultadosPesquisa('');
  setTimeout(() => input.focus(), 50);
}
function fecharModalPesquisa() { fecharOverlay('modal-pesquisa'); }
document.getElementById('btn-pesquisa-universal').addEventListener('click', abrirModalPesquisa);
document.getElementById('fechar-modal-pesquisa').addEventListener('click', fecharModalPesquisa);
document.getElementById('pesquisa-universal-input').addEventListener('input', ev => renderResultadosPesquisa(ev.target.value));
// Limpa sozinho ao clicar fora do campo — com um pequeno atraso pra dar tempo
// de um clique num resultado (que também tira o foco do campo) terminar antes
document.getElementById('pesquisa-universal-input').addEventListener('blur', () => {
  setTimeout(() => {
    const input = document.getElementById('pesquisa-universal-input');
    if (input.value) { input.value = ''; renderResultadosPesquisa(''); }
  }, 200);
});
document.addEventListener('keydown', ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    abrirModalPesquisa();
  }
  if (ev.key === 'Escape' && !document.getElementById('modal-pesquisa').hidden) fecharModalPesquisa();
});

function mostrarToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

// ============================================================
// HELPERS DE DATA
// ============================================================
function pad2(n) { return String(n).padStart(2, '0'); }
function hojeStr() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()); }
function mesKeyDe(date) { return date.getFullYear() + '-' + pad2(date.getMonth()+1); }
function strDeDate(date) { return date.getFullYear() + '-' + pad2(date.getMonth()+1) + '-' + pad2(date.getDate()); }
// Semana cheia (segunda a domingo) que contém a data informada — usada no
// relatório semanal, pra sempre mostrar uma semana completa
function inicioSemanaDe(date) {
  const d = new Date(date);
  const dia = d.getDay(); // 0 = domingo, 1 = segunda, ... 6 = sábado
  const deslocamento = dia === 0 ? -6 : 1 - dia;
  d.setDate(d.getDate() + deslocamento);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fimSemanaDe(inicioSemana) {
  const d = new Date(inicioSemana);
  d.setDate(d.getDate() + 6);
  return d;
}
function parseDataStr(str) {
  if (!str) return null;
  const partes = str.split('-');
  if (partes.length !== 3) return null;
  return new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]));
}
function formatarData(str) {
  const d = parseDataStr(str);
  if (!d) return '—';
  return pad2(d.getDate()) + '/' + pad2(d.getMonth()+1) + '/' + d.getFullYear();
}
function mesDe(str) { return str ? str.slice(0, 7) : null; }
function semanaDoMes(str) {
  const d = parseDataStr(str);
  if (!d) return null;
  return Math.min(5, Math.ceil(d.getDate() / 7));
}
function normalizarTelefone(t) { return (t || '').replace(/\D/g, ''); }
// Busca "inteligente": ignora acento e maiúscula/minúscula, então "joão" acha
// "joao" e vice-versa — usada em todas as buscas de texto do app
function normalizarTexto(t) {
  return (t || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ============================================================
// CÁLCULOS — resumo do mês
// ============================================================
// Regra combinada: um contato conta no mês em que foi FALADO (dataContato);
// um agendamento conta no mês em que a consulta/cirurgia vai ACONTECER (dataAgendamento).
// Os dois podem cair em meses diferentes (ex: contato em agosto, agendado pra setembro).
function contatosDoMes(mesKey) {
  return state.entries.filter(e => mesDe(e.dataContato) === mesKey);
}
// pra estatísticas de "quantos contatos" (não pra tabela, que continua mostrando
// todo mundo): quando o tutor liga uma vez só e agenda mais de um animal, o
// segundo (e os seguintes) podem ser marcados como "mesmo telefonema" pra não
// inflar a contagem de contatos — mas continuam contando normal em agendamentos.
function contatosUnicosDoMes(mesKey) {
  return contatosDoMes(mesKey).filter(e => !e.mesmoContatoOutroAnimal);
}
function agendadosDoMes(mesKey) {
  return state.entries.filter(e => STATUS_AGENDADOS.includes(e.status) && mesDe(e.dataAgendamento) === mesKey);
}
function naoAgendadosOuDesmarcadosDoMes(mesKey) {
  // usa a data do desmarque/decisão quando existe; senão cai pra data de contato
  return state.entries.filter(e => STATUS_NAO_AGENDADOS.includes(e.status) && mesDe(e.dataAgendamento || e.dataContato) === mesKey);
}
// usado pela tabela (não pelos números do resumo): além dos contatos do mês,
// traz também qualquer contato cuja data de agendamento/recontato/desmarque
// caia neste mês, mesmo que o contato original tenha sido feito em outro mês
// (ex: contato em agosto, consulta realizada em setembro) — assim ele aparece
// nos dois meses na tabela, mas os quadrinhos de resumo continuam contando
// cada coisa só uma vez (contato no mês do contato, agendamento no mês do
// agendamento), sem duplicar nada.
function entriesDoMes(mesKey) {
  const porContato = contatosDoMes(mesKey);
  const porOutraDataNesseMes = state.entries.filter(e =>
    e.dataAgendamento &&
    mesDe(e.dataAgendamento) === mesKey &&
    mesDe(e.dataContato) !== mesKey
  );
  return porContato.concat(porOutraDataNesseMes);
}

// Filtro rápido "Últimos 7 dias": ignora o mês selecionado e olha os últimos
// 7 dias corridos (hoje incluso) pela data mais relevante de cada contato
// (agendamento/desmarque, ou contato quando não tem a outra)
function entriesUltimos7Dias() {
  const hoje = new Date();
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() - 6);
  const hojeStrVal = hojeStr();
  const limiteStr = limite.getFullYear() + '-' + pad2(limite.getMonth()+1) + '-' + pad2(limite.getDate());
  return state.entries.filter(e => {
    const data = e.dataAgendamento || e.dataContato || '';
    return !!data && data >= limiteStr && data <= hojeStrVal;
  });
}

// Lista base da tabela/chips de Agendamentos: por mês normalmente, ou os
// últimos 7 dias quando esse filtro rápido está ativo
function listaBaseAgendamentos(mesKey) {
  return filtros.periodo === '7dias' ? entriesUltimos7Dias() : entriesDoMes(mesKey);
}

function statsDoMes(mesKey) {
  const contatos = contatosUnicosDoMes(mesKey);
  const agendados = agendadosDoMes(mesKey);
  const naoAgendadosLista = naoAgendadosOuDesmarcadosDoMes(mesKey);
  const tipos = state.categorias.tipos;
  const cidades = state.categorias.cidades;
  const clinicas = state.categorias.clinicas;
  const motivos = state.categorias.motivos;

  const porTipo = {};
  tipos.forEach(t => { porTipo[t] = { agendados: 0, naoAgendados: 0, desmarcados: 0 }; });
  agendados.forEach(e => { if (!porTipo[e.tipo]) porTipo[e.tipo] = { agendados: 0, naoAgendados: 0, desmarcados: 0 }; porTipo[e.tipo].agendados++; });
  naoAgendadosLista.forEach(e => {
    if (!porTipo[e.tipo]) porTipo[e.tipo] = { agendados: 0, naoAgendados: 0, desmarcados: 0 };
    if (e.status === 'Desmarcou') porTipo[e.tipo].desmarcados++;
    else porTipo[e.tipo].naoAgendados++;
  });

  const porCidade = {};
  cidades.forEach(c => { porCidade[c] = 0; });
  agendados.forEach(e => { if (e.cidade) porCidade[e.cidade] = (porCidade[e.cidade]||0) + 1; });

  const porClinica = {};
  clinicas.forEach(c => { porClinica[c] = 0; });
  contatos.forEach(e => { if (e.clinica) porClinica[e.clinica] = (porClinica[e.clinica]||0) + 1; });

  const porMotivo = {};
  motivos.forEach(m => { porMotivo[m] = 0; });
  naoAgendadosLista.forEach(e => { if (e.motivo) porMotivo[e.motivo] = (porMotivo[e.motivo]||0) + 1; });

  // observações escritas por ela em cada desmarque/não agendou (campo
  // "Detalhes do motivo") — o relatório mostra isso pra ela não precisar
  // caçar na tabela pra lembrar o que anotou
  const motivosDetalhados = naoAgendadosLista
    .filter(e => e.detalheMotivo)
    .map(e => ({ nome: e.nome, telefone: e.telefone, tipo: e.tipo, status: e.status, motivo: e.motivo, detalhe: e.detalheMotivo }));

  // quantos contatos do mês foram ela quem ligou vs o cliente quem procurou
  // (campo "Quem entrou em contato" do formulário, padrão é "cliente")
  const porIniciativa = { eu: 0, cliente: 0 };
  contatos.forEach(e => { if (e.iniciativa === 'eu') porIniciativa.eu++; else porIniciativa.cliente++; });

  const porSemana = [0,0,0,0,0];
  contatos.forEach(e => {
    const sem = semanaDoMes(e.dataContato);
    if (sem) porSemana[sem-1]++;
  });

  const consultasEAcompanhamentos = agendados.filter(e => e.tipo === 'Consulta' || e.tipo === 'Acompanhamento').length;
  const cirurgias = agendados.filter(e => e.tipo === 'Cirurgia').length;
  const desmarques = naoAgendadosLista.filter(e => e.status === 'Desmarcou').length;
  const naoAgendados = naoAgendadosLista.filter(e => e.status === 'Não Agendou').length;

  return {
    total: contatos.length, porTipo, porCidade, porClinica, porMotivo, motivosDetalhados, porIniciativa, porSemana,
    consultasEAcompanhamentos, cirurgias, desmarques, naoAgendados
  };
}

// Mesma ideia do statsDoMes, mas pra um intervalo de datas qualquer (usado no
// relatório semanal) — só os números que o relatório usa, sem o detalhamento
// por tipo/cidade/clínica/motivo que só a aba Agendamentos precisa
function statsDoPeriodo(inicioStr, fimStr) {
  const contatos = state.entries.filter(e => e.dataContato && e.dataContato >= inicioStr && e.dataContato <= fimStr && !e.mesmoContatoOutroAnimal);
  const agendados = state.entries.filter(e => STATUS_AGENDADOS.includes(e.status) && e.dataAgendamento && e.dataAgendamento >= inicioStr && e.dataAgendamento <= fimStr);
  const naoAgendadosLista = state.entries.filter(e => {
    const data = e.dataAgendamento || e.dataContato;
    return STATUS_NAO_AGENDADOS.includes(e.status) && data && data >= inicioStr && data <= fimStr;
  });

  const porIniciativa = { eu: 0, cliente: 0 };
  contatos.forEach(e => { if (e.iniciativa === 'eu') porIniciativa.eu++; else porIniciativa.cliente++; });

  const porMotivo = {};
  state.categorias.motivos.forEach(m => { porMotivo[m] = 0; });
  naoAgendadosLista.forEach(e => { if (e.motivo) porMotivo[e.motivo] = (porMotivo[e.motivo]||0) + 1; });

  const motivosDetalhados = naoAgendadosLista
    .filter(e => e.detalheMotivo)
    .map(e => ({ nome: e.nome, telefone: e.telefone, tipo: e.tipo, status: e.status, motivo: e.motivo, detalhe: e.detalheMotivo }));

  return {
    total: contatos.length,
    porIniciativa,
    porMotivo,
    motivosDetalhados,
    consultasEAcompanhamentos: agendados.filter(e => e.tipo === 'Consulta' || e.tipo === 'Acompanhamento').length,
    cirurgias: agendados.filter(e => e.tipo === 'Cirurgia').length,
    desmarques: naoAgendadosLista.filter(e => e.status === 'Desmarcou').length,
    naoAgendados: naoAgendadosLista.filter(e => e.status === 'Não Agendou').length
  };
}

// ============================================================
// RENDER GERAL
// ============================================================
function renderTudo() {
  if (!carregouDoc || !carregouEntries) return;
  popularSelects();
  renderAba();
  renderLinksUteis();
  atualizarBadgeAtrasados();
  if (!document.getElementById('modal-entry').hidden) atualizarPainelHistorico();
  if (!document.getElementById('modal-categorias').hidden) renderCategoriasPainel();
  if (carregouNfDoc && carregouNfEntries) {
    if (abaAtiva === 'notas') renderNotas();
    if (!document.getElementById('modal-nf').hidden) atualizarPainelHistoricoNf();
    if (!document.getElementById('modal-servicos').hidden) renderServicosLista();
  }
}

// Bolinha na aba "Agendamentos": quantos contatos estão "Aguardando" no mês
// que está selecionado ali — de propósito a MESMA contagem (e mesma lista
// base) do chip "Aguardando" logo abaixo, pra nunca aparecer um número
// diferente do outro. Por isso não tem dedup de "mesmo telefonema" aqui: o
// chip também conta cru, cada linha da tabela como uma.
function atualizarBadgeAtrasados() {
  const badge = document.getElementById('badge-atrasados');
  if (!badge) return;
  const aguardando = listaBaseAgendamentos(mesKeyDe(currentDate)).filter(e => e.status === 'Aguardando').length;
  badge.textContent = aguardando;
  badge.hidden = aguardando === 0;
}

function renderAba() {
  document.getElementById('aba-inicio').hidden = abaAtiva !== 'inicio';
  document.getElementById('aba-agendamentos').hidden = abaAtiva !== 'agendamentos';
  document.getElementById('aba-metas').hidden = abaAtiva !== 'metas';
  document.getElementById('aba-notas').hidden = abaAtiva !== 'notas';
  document.getElementById('aba-anual').hidden = abaAtiva !== 'anual';
  document.getElementById('aba-relatorios').hidden = abaAtiva !== 'relatorios';
  document.querySelectorAll('nav.abas button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === abaAtiva));
  if (abaAtiva === 'inicio') renderInicio();
  else if (abaAtiva === 'agendamentos' || abaAtiva === 'metas') renderAgendamentos();
  else if (abaAtiva === 'notas') { if (carregouNfDoc && carregouNfEntries) renderNotas(); }
  else if (abaAtiva === 'relatorios') renderRelatorios();
  else renderAnual();
}

// ============================================================
// NAVEGAÇÃO (botão "voltar" físico do celular / app instalado)
// ============================================================
// O app é uma SPA de página única — trocar de aba e abrir modal só mudam o
// que tá visível, nunca muda de página de verdade. Sem isso, o botão
// "voltar" do Android fecharia o app inteiro na primeira tentativa, mesmo
// com um modal aberto ou depois de ter trocado de aba. Cada troca de aba e
// cada modal aberto empilha uma entrada no histórico do navegador; o
// "voltar" desfaz uma de cada vez, na ordem em que ela foi navegando, só
// saindo do app de verdade quando não sobra mais nada pra desfazer.
const IDS_MODAIS = ['modal-entry', 'modal-texto', 'modal-categorias', 'modal-nf', 'modal-servicos', 'modal-link', 'modal-pesquisa'];

function modalAberto() {
  return IDS_MODAIS.find(id => { const el = document.getElementById(id); return el && !el.hidden; }) || null;
}

// url opcional: quando passada, o endereço do site muda junto (usado pra
// trocar de aba); quando omitida, mantém o endereço atual (usado pra abrir
// modal, que não deve mexer no "#aba" que já tava no endereço)
function pushEstadoNavegacao(estado, url) {
  history.pushState(Object.assign({ olhattaNav: true }, estado), '', url || location.href);
}

// endereço (".../#aba" ou ".../#aba/subaba") de uma aba, pra copiar/colar e
// abrir direto nela — já inclui a subaba atual (Mensal/Semanal) quando a
// aba tiver uma, pra o link levar pro lugar exato
function urlDaAba(aba) {
  const sufixo = (SUBABAS_VALIDAS[aba] && aba === 'relatorios') ? '/' + relatorioModo : '';
  return location.pathname + location.search + '#' + aba + sufixo;
}

function navegarParaAba(novaAba) {
  if (novaAba === abaAtiva) return;
  abaAtiva = novaAba;
  pushEstadoNavegacao({ tipo: 'aba', aba: novaAba }, urlDaAba(novaAba));
  renderAba();
}

// troca de subaba (hoje só existe em Relatórios: Mensal/Semanal) — segue o
// mesmo esquema da troca de aba: empilha no histórico e muda o endereço
// junto, pra funcionar com o botão voltar e com copiar/colar o link
function navegarParaSubaba(aba, novaSubaba) {
  if (aba === 'relatorios' && novaSubaba === relatorioModo) return;
  if (aba === 'relatorios') relatorioModo = novaSubaba;
  pushEstadoNavegacao({ tipo: 'aba', aba: aba, subaba: novaSubaba }, urlDaAba(aba));
  renderAba();
}

// Toda abertura/fechamento de modal passa por essas duas funções (em vez de
// mexer direto no .hidden) pra ficar empilhado certinho no histórico
function abrirOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  pushEstadoNavegacao({ tipo: 'modal', modal: id });
}

function fecharOverlay(id) {
  const el = document.getElementById(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  // se a entrada atual do histórico é a desse modal, volta uma posição pra
  // não deixar "entrada fantasma" (botão voltar não devia reabrir ele do
  // nada depois de já ter sido fechado pelo X/Cancelar)
  const estado = history.state;
  if (estado && estado.olhattaNav && estado.tipo === 'modal' && estado.modal === id) {
    history.back();
  }
}

window.addEventListener('popstate', ev => {
  // se tinha algum modal aberto na tela, o "voltar" fecha ele primeiro —
  // sem mexer na aba, já que abrir modal não troca de aba
  const aberto = modalAberto();
  if (aberto) { document.getElementById(aberto).hidden = true; return; }

  const estado = ev.state;
  if (estado && estado.olhattaNav && estado.tipo === 'aba' && estado.aba) {
    // relê o endereço restaurado (location.hash já tá atualizado nesse
    // ponto) pra pegar a aba E a subaba certas de uma vez só
    abaAtiva = abaDaUrl();
    renderAba();
  } else if (!estado || !estado.olhattaNav) {
    // chegou na entrada de antes de qualquer navegação nossa (o "fundo" da
    // pilha) — volta pra Início, que é a aba padrão do app
    abaAtiva = 'inicio';
    renderAba();
  }
  // outros estados (ex: entrada de um modal que já tinha sido fechado por
  // outro caminho) não mexem na aba — o importante (fechar modal) já foi
  // garantido acima
});

document.querySelectorAll('nav.abas button').forEach(btn => {
  btn.addEventListener('click', () => navegarParaAba(btn.dataset.aba));
});

// Contexto "Hoje é ..." no topo da barra lateral
(function () {
  const hoje = new Date();
  const el = document.getElementById('abas-data-hoje');
  if (el) el.textContent = hoje.getDate() + ' de ' + MESES[hoje.getMonth()].toLowerCase();
})();

// Segurar o mouse e arrastar pra ver as colunas que não cabem na tela, sem
// precisar descer até a barra de rolagem embaixo da tabela
function ativarArrastarScroll(el) {
  if (!el || el.dataset.arrastarPronto) return;
  el.dataset.arrastarPronto = '1';
  let arrastando = false, inicioX = 0, scrollInicial = 0, moveu = false;
  el.addEventListener('mousedown', ev => {
    arrastando = true; moveu = false;
    inicioX = ev.pageX;
    scrollInicial = el.scrollLeft;
  });
  function parar() {
    if (!arrastando) return;
    arrastando = false;
    el.classList.remove('arrastando');
  }
  el.addEventListener('mouseleave', parar);
  el.addEventListener('mouseup', parar);
  el.addEventListener('mousemove', ev => {
    if (!arrastando) return;
    const deslocamento = ev.pageX - inicioX;
    if (Math.abs(deslocamento) > 4) { moveu = true; el.classList.add('arrastando'); }
    if (moveu) { ev.preventDefault(); el.scrollLeft = scrollInicial - deslocamento; }
  });
  // evita que o "clique" no final de um arrasto acione botões/links por baixo
  el.addEventListener('click', ev => { if (moveu) { ev.preventDefault(); ev.stopPropagation(); moveu = false; } }, true);
}
document.querySelectorAll('.tabela-wrap').forEach(ativarArrastarScroll);

// ---------- popular <select> de filtros e formulário ----------
function popularSelects() {
  const cat = state.categorias;
  function preencher(id, valores, comTodos, valorAtual) {
    const el = document.getElementById(id);
    const atual = valorAtual !== undefined ? valorAtual : el.value;
    el.innerHTML = '';
    if (comTodos) {
      const op = document.createElement('option'); op.value=''; op.textContent = comTodos;
      el.appendChild(op);
    }
    valores.forEach(v => {
      const op = document.createElement('option'); op.value = v; op.textContent = v;
      el.appendChild(op);
    });
    if (valores.includes(atual) || atual === '') el.value = atual;
  }
  preencher('filtro-status', ['Agendado','Realizado','Desmarcou','Não Agendou','Aguardando'], 'Status (todos)');
  preencher('filtro-tipo', cat.tipos, 'Tipo (todos)');
  preencher('filtro-cidade', cat.cidades, 'Cidade (todas)');
  preencher('filtro-clinica', cat.clinicas, 'Clínica (todas)');
  preencher('filtro-motivo', cat.motivos, 'Motivo (todos)');
  preencher('nf-filtro-cidade', cat.cidades, 'Cidade (todas)');

  preencher('f-clinica', cat.clinicas, null);
  preencher('f-cidade', cat.cidades, null);
  preencher('f-tipo', cat.tipos, null);
  preencher('f-motivo', cat.motivos, null);
  preencher('nf-f-cidade', cat.cidades, null);
  const optNovoMotivo = document.createElement('option');
  optNovoMotivo.value = '__novo__';
  optNovoMotivo.textContent = '+ Adicionar novo motivo...';
  document.getElementById('f-motivo').appendChild(optNovoMotivo);

  // "+ Adicionar nova cidade..." direto no formulário — igual ao de motivo,
  // pra ela não precisar ir no ícone de engrenagem só pra cadastrar uma cidade nova
  ['f-cidade', 'nf-f-cidade'].forEach(id => {
    const optNovaCidade = document.createElement('option');
    optNovaCidade.value = '__novo__';
    optNovaCidade.textContent = '+ Adicionar nova cidade...';
    document.getElementById(id).appendChild(optNovaCidade);
  });
}

// Adiciona uma categoria nova direto de um <select> do formulário (sem abrir o
// painel de Categorias) — mesmo mecanismo usado em Motivo, generalizado pra
// poder ser reaproveitado em Cidade (e outros, se precisar no futuro)
function configurarAdicaoInline(idSelect, chaveCategoria, rotulo) {
  const sel = document.getElementById(idSelect);
  if (!sel) return;
  sel.addEventListener('change', () => {
    if (sel.value !== '__novo__') return;
    const valorAnterior = (state.categorias[chaveCategoria] || [])[0] || '';
    const novo = (prompt('Digite a nova ' + rotulo + ':') || '').trim();
    if (!novo) { sel.value = valorAnterior; return; }
    if (state.categorias[chaveCategoria].includes(novo)) { sel.value = novo; return; }
    sel.disabled = true;
    adicionarCategoria(chaveCategoria, novo).then(() => {
      sel.disabled = false;
      if (!state.categorias[chaveCategoria].includes(novo)) state.categorias[chaveCategoria].push(novo);
      popularSelects();
      sel.value = novo;
    }).catch(err => {
      sel.disabled = false;
      sel.value = valorAnterior;
      mostrarToast('Não foi possível adicionar a cidade: ' + err.message);
    });
  });
}
configurarAdicaoInline('f-cidade', 'cidades', 'cidade');
configurarAdicaoInline('nf-f-cidade', 'cidades', 'cidade');

// Clínica define a cidade automaticamente (quando a clínica tem cidade fixa)
const CLINICA_CIDADE_AUTO = {
  'Olhatta': 'Sinop',
  'Equibem': 'Sinop',
  'Volante': 'Sinop',
  'Pet Center': 'Lucas do Rio Verde',
  'Espaço Pet': 'Lucas do Rio Verde'
};
document.getElementById('f-clinica').addEventListener('change', () => {
  const clinica = document.getElementById('f-clinica').value;
  const cidadeAuto = CLINICA_CIDADE_AUTO[clinica];
  if (cidadeAuto && state.categorias.cidades.includes(cidadeAuto)) {
    document.getElementById('f-cidade').value = cidadeAuto;
  }
});

// ============================================================
// HISTÓRICO INTELIGENTE DE CONTATO REPETIDO
// ============================================================
// Um contato pode ter um segundo responsável (outro tutor do mesmo animal,
// cada um com seu telefone) — então "bater o telefone" significa bater com
// QUALQUER um dos dois, não só o principal.
function entryBatesComTelefone(e, telNorm) {
  return normalizarTelefone(e.telefone) === telNorm || normalizarTelefone(e.telefone2) === telNorm;
}

function buscarHistorico(telefone, nome) {
  const tel = normalizarTelefone(telefone);
  const nomeNorm = (nome || '').trim().toLowerCase();
  if (tel.length < 8 && !nomeNorm) return [];
  return state.entries.filter(e => {
    if (editingEntryId && e.id === editingEntryId) return false;
    if (tel.length >= 8) return entryBatesComTelefone(e, tel);
    return (e.nome || '').trim().toLowerCase() === nomeNorm;
  });
}

function ordenarPorDataRecente(lista) {
  return lista.slice().sort((a, b) => {
    const da = a.dataAgendamento || a.dataContato || '';
    const db_ = b.dataAgendamento || b.dataContato || '';
    return da < db_ ? 1 : da > db_ ? -1 : 0;
  });
}

// ---------- Histórico cruzado (Agendamentos + Notas Fiscais) por telefone ----------
// Usado nos dois modais (contato e NF): quando o telefone digitado já apareceu
// antes em QUALQUER um dos dois lados do app, mostra um mini cadastro com o
// que já se sabe desse cliente, pra ela conferir antes de confirmar.
function historicoCompletoPorTelefone(telefone) {
  const tel = normalizarTelefone(telefone);
  if (tel.length < 8) return { agendamentos: [], notas: [] };
  const agendamentos = ordenarPorDataRecente(
    state.entries.filter(e => !(editingEntryId && e.id === editingEntryId) && entryBatesComTelefone(e, tel))
  );
  const notas = state.nfEntries
    .filter(e => !(editingNfId && e.id === editingNfId) && normalizarTelefone(e.telefone) === tel)
    .slice()
    .sort((a, b) => (b.dataPagamento || '').localeCompare(a.dataPagamento || ''));
  return { agendamentos, notas };
}

function montarHistoricoHtml(telefone) {
  const { agendamentos, notas } = historicoCompletoPorTelefone(telefone);
  const total = agendamentos.length + notas.length;
  if (!total) return '';

  const itens = agendamentos.map(e => ({
    tipo: 'Contato',
    data: e.dataAgendamento || e.dataContato || '',
    desc: `${e.animal || e.nome || 'sem nome'}${e.tipo ? ' · ' + e.tipo : ''}`,
    statusTxt: e.status || '',
    statusClasse: pillClasse(e.status)
  })).concat(notas.map(e => ({
    tipo: 'Nota',
    data: e.dataPagamento || '',
    desc: `${e.animal || 'sem animal'} · R$ ${formatarMoeda(e.valorNota)}`,
    statusTxt: e.feito ? '✓ Feita' : 'Pendente',
    statusClasse: e.feito ? 'feito' : 'pendente'
  }))).sort((a, b) => (b.data || '').localeCompare(a.data || '')).slice(0, 5);

  const linhas = itens.map(it => `
    <li>
      <span class="historico-tipo">${escapeHtml(it.tipo)}</span>
      <span class="historico-data">${formatarData(it.data)}</span>
      <span class="historico-desc">${escapeHtml(it.desc)}</span>
      <span class="pill ${it.statusClasse}">${escapeHtml(it.statusTxt)}</span>
    </li>`).join('');

  return `
    <div class="historico-cabeca">Histórico deste telefone — ${total} registro${total > 1 ? 's' : ''}</div>
    <ul class="historico-lista">${linhas}</ul>
  `;
}

function atualizarPainelHistorico() {
  const painel = document.getElementById('historico-contato');
  if (!painel) return;

  // marcando Desmarcou/Não Agendou, ela só quer marcar rápido — sem o painel
  // de histórico aparecendo no meio do caminho
  if (STATUS_NAO_AGENDADOS.includes(document.getElementById('f-status').value)) {
    painel.hidden = true;
    painel.innerHTML = '';
    return;
  }

  const telefone = document.getElementById('f-telefone').value;
  const nome = document.getElementById('f-nome').value;

  // telefone com tamanho suficiente pra cruzar com notas fiscais também
  if (normalizarTelefone(telefone).length >= 8) {
    const html = montarHistoricoHtml(telefone);
    painel.innerHTML = html;
    painel.hidden = !html;
    return;
  }

  // telefone ainda curto demais — mantém a checagem simples só por nome,
  // só do lado de agendamentos (notas fiscais não têm esse campo "nome")
  const historico = buscarHistorico(telefone, nome);
  if (!historico.length) { painel.hidden = true; painel.innerHTML = ''; return; }

  const ordenado = ordenarPorDataRecente(historico);
  const ultimo = ordenado[0];
  const agendados = historico.filter(e => STATUS_AGENDADOS.includes(e.status)).length;
  const desmarcou = historico.filter(e => e.status === 'Desmarcou').length;
  const naoAgendou = historico.filter(e => e.status === 'Não Agendou').length;

  painel.hidden = false;
  painel.innerHTML = `
    <b>${historico.length} contato${historico.length>1?'s':''} anterior${historico.length>1?'es':''}</b> encontrado${historico.length>1?'s':''} —
    ${agendados} agendado(s)/realizado(s), ${desmarcou} desmarcou(aram), ${naoAgendou} não agendou(aram).
    Último: ${formatarData(ultimo.dataAgendamento || ultimo.dataContato)} · ${escapeHtml(ultimo.status||'')}${ultimo.clinica ? ' · ' + escapeHtml(ultimo.clinica) : ''}
  `;
}

// Mesma ideia do painel acima, só que do lado da Nota Fiscal — mostra tanto
// outras notas desse telefone quanto os agendamentos dele, pro mini cadastro
// aparecer nos dois lugares do app.
function atualizarPainelHistoricoNf() {
  const painel = document.getElementById('historico-nf');
  if (!painel) return;
  const telefone = document.getElementById('nf-f-telefone').value;
  const html = montarHistoricoHtml(telefone);
  painel.innerHTML = html;
  painel.hidden = !html;
}

// Sugestões de telefone conforme digita (mesmo com só o DDD ou parte do número) —
// ajuda a reconhecer quem já contatou antes sem precisar digitar o número inteiro.
function buscarSugestoesTelefone(digitado) {
  const alvo = normalizarTelefone(digitado);
  if (alvo.length < 2) return [];
  const vistos = new Set();
  const lista = [];
  ordenarPorDataRecente(state.entries).forEach(e => {
    if (editingEntryId && e.id === editingEntryId) return;
    const tel = (e.telefone || '').trim();
    const telNorm = normalizarTelefone(tel);
    if (tel && !vistos.has(telNorm) && telNorm.includes(alvo)) { vistos.add(telNorm); lista.push({ tel, nome: e.nome || '(sem nome)' }); }
    // o segundo responsável (outro tutor do mesmo animal) também entra nas sugestões
    const tel2 = (e.telefone2 || '').trim();
    const tel2Norm = normalizarTelefone(tel2);
    if (tel2 && !vistos.has(tel2Norm) && tel2Norm.includes(alvo)) { vistos.add(tel2Norm); lista.push({ tel: tel2, nome: e.nome2 || e.nome || '(sem nome)' }); }
  });
  return lista.slice(0, 6);
}

function renderSugestoesTelefone() {
  const caixa = document.getElementById('sugestoes-tel');
  const valor = document.getElementById('f-telefone').value;
  const sugestoes = buscarSugestoesTelefone(valor);
  if (!sugestoes.length) { caixa.hidden = true; caixa.innerHTML = ''; return; }
  caixa.innerHTML = sugestoes.map(s => `<button type="button" data-tel="${escapeHtml(s.tel)}"><b>${escapeHtml(s.tel)}</b><span>${escapeHtml(s.nome)}</span></button>`).join('');
  caixa.hidden = false;
}

document.getElementById('sugestoes-tel').addEventListener('mousedown', ev => {
  const btn = ev.target.closest('button[data-tel]');
  if (!btn) return;
  ev.preventDefault();
  document.getElementById('f-telefone').value = btn.dataset.tel;
  document.getElementById('sugestoes-tel').hidden = true;
  autopreencherPorTelefone();
});
document.getElementById('f-telefone').addEventListener('input', renderSugestoesTelefone);
document.getElementById('f-telefone').addEventListener('blur', () => {
  setTimeout(() => { document.getElementById('sugestoes-tel').hidden = true; }, 150);
});

function autopreencherPorTelefone() {
  if (editingEntryId) return; // só ajuda em contato novo, não mexe em edição
  const telefone = document.getElementById('f-telefone').value;
  const historico = buscarHistorico(telefone, '');
  if (!historico.length) return;
  const ultimo = ordenarPorDataRecente(historico)[0];
  if (!document.getElementById('f-nome').value.trim()) document.getElementById('f-nome').value = ultimo.nome || '';
  if (!document.getElementById('f-animal').value.trim()) document.getElementById('f-animal').value = ultimo.animal || '';
  if (ultimo.clinica) document.getElementById('f-clinica').value = ultimo.clinica;
  if (ultimo.cidade) document.getElementById('f-cidade').value = ultimo.cidade;
  atualizarPainelHistorico();
}

// ============================================================
// ABA AGENDAMENTOS
// ============================================================
function rotuloMes(date) { return MESES[date.getMonth()] + ' ' + date.getFullYear(); }

document.getElementById('mes-anterior').addEventListener('click', () => { currentDate.setMonth(currentDate.getMonth()-1); renderAgendamentos(); });
document.getElementById('mes-proximo').addEventListener('click', () => { currentDate.setMonth(currentDate.getMonth()+1); renderAgendamentos(); });
document.getElementById('mes-hoje').addEventListener('click', () => { currentDate = new Date(); renderAgendamentos(); });
document.getElementById('metas-mes-anterior').addEventListener('click', () => { currentDate.setMonth(currentDate.getMonth()-1); renderAgendamentos(); });
document.getElementById('metas-mes-proximo').addEventListener('click', () => { currentDate.setMonth(currentDate.getMonth()+1); renderAgendamentos(); });
document.getElementById('metas-mes-hoje').addEventListener('click', () => { currentDate = new Date(); renderAgendamentos(); });

function renderAgendamentos() {
  document.getElementById('mes-rotulo').textContent = rotuloMes(currentDate);
  const rotuloMetas = document.getElementById('metas-mes-rotulo');
  if (rotuloMetas) rotuloMetas.textContent = rotuloMes(currentDate);
  const mesKey = mesKeyDe(currentDate);
  const stats = statsDoMes(mesKey);

  renderCards(stats);
  renderSemanas(stats, mesKey);
  renderMetas(mesKey, stats);
  renderChipsStatus(mesKey);
  renderTabela(mesKey);
  atualizarBadgeAtrasados();
}

// Atalho de filtro por status: um clique já filtra a tabela (em vez de abrir
// o <select>), mostrando quantos contatos do mês tem em cada status. Por baixo
// dos panos continua usando o mesmo <select id="filtro-status"> de sempre (só
// fica escondido visualmente), pra não duplicar a lógica de filtro.
function renderChipsStatus(mesKey) {
  const cont = document.getElementById('chips-status');
  if (!cont) return;
  const lista = listaBaseAgendamentos(mesKey);
  const contagem = {};
  lista.forEach(e => { contagem[e.status] = (contagem[e.status]||0) + 1; });
  const ordem = ['Aguardando','Agendado','Realizado','Desmarcou','Não Agendou'];
  const chipTodos = `<button type="button" class="chip-status ${filtros.status === '' ? 'selecionado' : ''}" data-status="">Todos <b>${lista.length}</b></button>`;
  const chipsStatus = ordem.map(s => `<button type="button" class="chip-status ${pillClasse(s)} ${filtros.status === s ? 'selecionado' : ''}" data-status="${escapeHtml(s)}">${escapeHtml(s)} <b>${contagem[s]||0}</b></button>`).join('');
  cont.innerHTML = chipTodos + chipsStatus;
  cont.querySelectorAll('.chip-status').forEach(chip => {
    chip.addEventListener('click', () => {
      const sel = document.getElementById('filtro-status');
      sel.value = chip.dataset.status;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
}

// ============================================================
// ABA INÍCIO — painel inicial: agendados hoje, consultas hoje, pendentes
// ============================================================
function renderInicio() {
  renderAgendadosHoje();
  renderConsultasHoje();
  renderPainelPendentes();
  const vazio = document.getElementById('inicio-vazio');
  if (vazio) {
    // consultas-hoje e pendentes agora nunca ficam ocultos de verdade (mostram
    // estado vazio em vez de desaparecer); então o aviso geral de "tudo em
    // dia" olha os DADOS de cada um, não o atributo hidden do painel
    const semNada = entriesAgendadosHoje().length === 0
      && entriesConsultasHoje().length === 0
      && entriesPendentes().length === 0;
    vazio.hidden = !semNada;
  }
}

// Rótulo pro título dos painéis: "hoje" quando a data escolhida é a de hoje,
// senão a data por extenso (dd/mm)
function rotuloDataInicio() {
  return inicioData === hojeStr() ? 'hoje' : ('em ' + formatarData(inicioData));
}

// Quem ELA agendou (ligou/foi procurada) NO DIA escolhido — painel "Agendei
// hoje" —, não importa pra quando ficou marcado o atendimento em si; é só
// informativo, com atalho pra editar caso precise ajustar algo
function entriesAgendadosHoje() {
  return state.entries
    .filter(e => e.status === 'Agendado' && e.dataContato === inicioData)
    .sort((a, b) => (a.dataAgendamento || '').localeCompare(b.dataAgendamento || '') || (a.horario || '').localeCompare(b.horario || ''));
}

function renderAgendadosHoje() {
  const painel = document.getElementById('painel-agendados-hoje');
  const contagem = document.getElementById('agendados-hoje-contagem');
  const lista = document.getElementById('lista-agendados-hoje');
  const titulo = document.getElementById('agendados-hoje-titulo');
  if (titulo) titulo.textContent = 'Agendei ' + rotuloDataInicio();
  const hoje = hojeStr();
  const agendadosHoje = entriesAgendadosHoje();

  if (agendadosHoje.length === 0) { painel.hidden = true; return; }

  painel.hidden = false;
  contagem.textContent = agendadosHoje.length;
  lista.innerHTML = agendadosHoje.map(e => {
    const atendimentoHoje = e.dataAgendamento === hoje;
    const quando = e.dataAgendamento
      ? (atendimentoHoje ? 'Atendimento hoje' : 'Atendimento em ' + formatarData(e.dataAgendamento)) + (e.horario ? ' às ' + escapeHtml(e.horario) : '')
      : 'Sem data de atendimento definida';
    return `
    <div class="pendente-item pendente-clicavel" data-id="${e.id}" title="Ver na tela de Agendamentos">
      <div class="pendente-info">
        <b>${escapeHtml(e.nome || '(sem nome)')}</b> — ${telefoneClicavel(e.telefone)}${e.animal ? ' · ' + escapeHtml(e.animal) : ''}
        <span>${e.tipo ? escapeHtml(e.tipo) + ' · ' : ''}${quando}${e.clinica ? ' · ' + escapeHtml(e.clinica) : ''}</span>
      </div>
      <button type="button" class="btn-editar-pendente" data-id="${e.id}">Editar</button>
    </div>
  `;
  }).join('');

  // clicar no item (fora do botão/telefone) leva pra tela de Agendamentos,
  // já no mês do atendimento e filtrado por esse contato
  lista.querySelectorAll('.pendente-clicavel').forEach(item => {
    item.addEventListener('click', () => {
      const entry = state.entries.find(e => e.id === item.dataset.id);
      if (entry) irParaContatoNaTabela(entry);
    });
  });

  lista.querySelectorAll('.btn-editar-pendente').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const entry = state.entries.find(e => e.id === btn.dataset.id);
      if (entry) abrirModalEntry(entry);
    });
  });
}

// Clicar num contato no painel "Agendei hoje" (Início) leva direto pra tela
// de Agendamentos, já no mês do atendimento (pode ser diferente do mês de
// hoje) e com a busca preenchida com o telefone dele, pra aparecer só essa
// linha na tabela sem precisar procurar
function irParaContatoNaTabela(entry) {
  const dataRef = entry.dataAgendamento || entry.dataContato || hojeStr();
  const [ano, mes] = dataRef.split('-').map(Number);
  currentDate = new Date(ano, mes - 1, 1);
  filtros = { busca: normalizarTexto(entry.telefone || ''), status: '', tipo: '', cidade: '', clinica: '', motivo: '', iniciativa: '', periodo: '' };

  const busca = document.getElementById('filtro-busca'); if (busca) busca.value = entry.telefone || '';
  const selStatus = document.getElementById('filtro-status'); if (selStatus) selStatus.value = '';
  const selTipo = document.getElementById('filtro-tipo'); if (selTipo) selTipo.value = '';
  const selCidade = document.getElementById('filtro-cidade'); if (selCidade) selCidade.value = '';
  const selClinica = document.getElementById('filtro-clinica'); if (selClinica) selClinica.value = '';
  const selMotivo = document.getElementById('filtro-motivo'); if (selMotivo) selMotivo.value = '';
  const selIniciativa = document.getElementById('filtro-iniciativa'); if (selIniciativa) selIniciativa.value = '';
  const btn7 = document.getElementById('btn-filtro-7dias'); if (btn7) btn7.classList.remove('ativo');

  navegarParaAba('agendamentos');
  atualizarBotaoLimparFiltros();
}

// Quem TEM atendimento marcado pro DIA escolhido (não importa quando foi
// agendado nem o tipo — consulta, cirurgia, acompanhamento, todos entram
// aqui) — painel "Agendados para hoje"; ela confirma aqui se o cliente
// realmente veio; confirmando, já marca Realizado
function entriesConsultasHoje() {
  return state.entries
    .filter(e => e.status === 'Agendado' && e.dataAgendamento === inicioData)
    .sort((a, b) => (a.horario || '').localeCompare(b.horario || ''));
}

function renderConsultasHoje() {
  const painel = document.getElementById('painel-consultas-hoje');
  const contagem = document.getElementById('consultas-hoje-contagem');
  const lista = document.getElementById('lista-consultas-hoje');
  const vazio = document.getElementById('consultas-hoje-vazio');
  const titulo = document.getElementById('consultas-hoje-titulo');
  const ehHoje = inicioData === hojeStr();
  if (titulo) titulo.textContent = 'Agendados para ' + rotuloDataInicio();
  const consultasHoje = entriesConsultasHoje();

  painel.hidden = false;
  contagem.textContent = consultasHoje.length;

  if (consultasHoje.length === 0) {
    lista.innerHTML = '';
    if (vazio) vazio.hidden = false;
    vazio.textContent = ehHoje ? 'Ninguém tem atendimento marcado pra hoje.' : 'Ninguém tem atendimento marcado pra ' + formatarData(inicioData) + '.';
    return;
  }
  if (vazio) vazio.hidden = true;

  lista.innerHTML = consultasHoje.map(e => `
    <div class="pendente-item">
      <div class="pendente-info">
        <b>${escapeHtml(e.nome || '(sem nome)')}</b> — ${telefoneClicavel(e.telefone)}${e.animal ? ' · ' + escapeHtml(e.animal) : ''}
        <span>${e.horario ? (ehHoje ? 'Hoje às ' : formatarData(inicioData) + ' às ') + escapeHtml(e.horario) : (ehHoje ? 'Hoje' : formatarData(inicioData))}${e.clinica ? ' · ' + escapeHtml(e.clinica) : ''}</span>
      </div>
      <button type="button" class="btn marrom sm btn-confirmar-hoje" data-id="${e.id}">Confirmou?</button>
    </div>
  `).join('');

  lista.querySelectorAll('.btn-confirmar-hoje').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = state.entries.find(e => e.id === btn.dataset.id);
      if (!entry) return;
      if (!confirm('"' + (entry.nome || 'esse contato') + '" confirmou e compareceu? Vai marcar como Realizado.')) return;
      const atualizado = Object.assign({}, entry, { status: 'Realizado' });
      btn.disabled = true;
      atualizarContato(entry.id, atualizado)
        .then(() => mostrarToast('Marcado como Realizado'))
        .catch(err => { mostrarToast('Não foi possível marcar: ' + err.message); btn.disabled = false; });
    });
  });
}

// Contatos com status "Aguardando" (a recontatar depois) — agora é um painel
// só (aba Início), sem depender do mês selecionado em Agendamentos: mostra
// todo mundo que está esperando contato, ordenado pela data programada de
// recontato (dataAgendamento), na ordem escolhida (asc/desc, lembrada no
// aparelho); contatos antigos sem essa data caem no fim, pela data de contato
function entriesPendentes() {
  const dir = ordemPendentes === 'desc' ? -1 : 1;
  return state.entries
    .filter(e => e.status === 'Aguardando')
    .sort((a, b) => {
      const da = a.dataAgendamento || '9999-99-99';
      const db_ = b.dataAgendamento || '9999-99-99';
      if (da !== db_) return (da < db_ ? -1 : 1) * dir;
      return (a.dataContato || '').localeCompare(b.dataContato || '') * dir;
    });
}

function renderPainelPendentes() {
  const painel = document.getElementById('painel-pendentes');
  const contagem = document.getElementById('pendentes-contagem');
  const lista = document.getElementById('lista-pendentes');
  const vazio = document.getElementById('pendentes-vazio');
  const btnOrdem = document.getElementById('btn-ordem-pendentes');
  const hoje = hojeStr();
  const pendentes = entriesPendentes();

  if (btnOrdem) btnOrdem.textContent = (ordemPendentes === 'desc' ? 'Mais distantes ▾' : 'Mais próximos ▾');

  painel.hidden = false;
  // a bolinha conta pessoas/ligações pendentes, não bichos — um "mesmo
  // telefonema" (2º+ animal da mesma ligação) não soma de novo aqui, mesmo
  // continuando listado embaixo pra dar pra editar cada um
  contagem.textContent = pendentes.filter(e => !e.mesmoContatoOutroAnimal).length;

  if (pendentes.length === 0) {
    lista.innerHTML = '';
    if (vazio) vazio.hidden = false;
    return;
  }
  if (vazio) vazio.hidden = true;

  lista.innerHTML = pendentes.map(e => {
    const dataLembrete = e.dataAgendamento || '';
    const atrasado = dataLembrete && dataLembrete < hoje;
    const ehHoje = dataLembrete === hoje;
    const tagLembrete = dataLembrete
      ? `Contatar em ${formatarData(dataLembrete)}${ehHoje ? ' · hoje' : atrasado ? ' · atrasado' : ''}`
      : `Contato em ${formatarData(e.dataContato)}`;
    const classeLembrete = ehHoje ? 'lembrete-hoje' : atrasado ? 'lembrete-atrasado' : '';
    return `
    <div class="pendente-item">
      <div class="pendente-info">
        <b>${escapeHtml(e.nome || '(sem nome)')}</b> — ${telefoneClicavel(e.telefone)}${e.animal ? ' · ' + escapeHtml(e.animal) : ''}
        <span><span class="${classeLembrete}">${tagLembrete}</span>${e.detalheMotivo ? ' · ' + escapeHtml(e.detalheMotivo) : ''}</span>
      </div>
      <button type="button" class="btn-editar-pendente" data-id="${e.id}">Contatar / editar</button>
    </div>
  `;
  }).join('');

  lista.querySelectorAll('.btn-editar-pendente').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = state.entries.find(e => e.id === btn.dataset.id);
      if (entry) abrirModalEntry(entry);
    });
  });
}

function renderCards(stats) {
  const cont = document.getElementById('cards-resumo');
  const cat = state.categorias;

  let htmlTipos = cat.tipos.map(t => {
    const s = stats.porTipo[t] || {agendados:0,naoAgendados:0,desmarcados:0};
    return `<div class="linha"><span>${escapeHtml(t)}</span><b class="num-clicavel" data-campo="tipo" data-valor="${escapeHtml(t)}">${s.agendados}</b></div>`;
  }).join('');

  let htmlCidades = cat.cidades.map(c => `<div class="linha"><span>${escapeHtml(c)}</span><b class="num-clicavel" data-campo="cidade" data-valor="${escapeHtml(c)}">${stats.porCidade[c]||0}</b></div>`).join('');
  let htmlClinicas = cat.clinicas.map(c => `<div class="linha"><span>${escapeHtml(c)}</span><b class="num-clicavel" data-campo="clinica" data-valor="${escapeHtml(c)}">${stats.porClinica[c]||0}</b></div>`).join('');

  const motivosComValor = Object.entries(stats.porMotivo).filter(([,v]) => v > 0);
  let htmlMotivos = motivosComValor.length
    ? motivosComValor.map(([m,v]) => `<div class="linha"><span>${escapeHtml(m)}</span><b class="num-clicavel" data-campo="motivo" data-valor="${escapeHtml(m)}">${v}</b></div>`).join('')
    : '<div class="sub">Nenhum registro</div>';

  cont.innerHTML = `
    <div class="card">
      <h3>Contatos no mês</h3>
      <div class="num num-clicavel" data-campo="total" data-valor="">${stats.total}</div>
      <div class="sub">${stats.desmarques} desmarque(s) · ${stats.naoAgendados} não agendou(aram)</div>
    </div>
    <div class="card">
      <h3>Quem entrou em contato</h3>
      <div class="linhas">
        <div class="linha"><span>Cliente entrou em contato</span><b class="num-clicavel" data-campo="iniciativa" data-valor="cliente">${stats.porIniciativa.cliente}</b></div>
        <div class="linha"><span>Eu entrei em contato</span><b class="num-clicavel" data-campo="iniciativa" data-valor="eu">${stats.porIniciativa.eu}</b></div>
      </div>
    </div>
    <div class="card">
      <h3>Agendados por tipo</h3>
      <div class="linhas">${htmlTipos || '<div class="sub">Sem categorias</div>'}</div>
    </div>
    <div class="card">
      <h3>Agendados por cidade</h3>
      <div class="linhas">${htmlCidades || '<div class="sub">Sem cidades cadastradas</div>'}</div>
    </div>
    <div class="card">
      <h3>Contatos por clínica</h3>
      <div class="linhas">${htmlClinicas || '<div class="sub">Sem clínicas cadastradas</div>'}</div>
    </div>
    <div class="card">
      <h3>Motivos</h3>
      <div class="linhas">${htmlMotivos}</div>
    </div>
  `;

  cont.querySelectorAll('.num-clicavel').forEach(el => {
    el.addEventListener('click', () => irParaTabelaComFiltro(el.dataset.campo, el.dataset.valor));
  });
}

// Clicar num número de resumo ("Agendados por tipo", "Contatos por clínica"
// etc.) leva direto pra tabela de Agendamentos já filtrada por aquele
// critério, sem precisar de outra aba — ela já existe na mesma tela
function irParaTabelaComFiltro(campo, valor) {
  filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '', motivo: '', iniciativa: '', periodo: '' };
  if (campo === 'tipo') { filtros.tipo = valor; filtros.status = 'Agendado'; }
  else if (campo === 'cidade') { filtros.cidade = valor; filtros.status = 'Agendado'; }
  else if (campo === 'clinica') { filtros.clinica = valor; }
  else if (campo === 'motivo') { filtros.motivo = valor; }
  else if (campo === 'iniciativa') { filtros.iniciativa = valor; }
  // campo === 'total': só limpa os filtros mesmo, mostra o mês inteiro

  const busca = document.getElementById('filtro-busca');
  if (busca) busca.value = '';
  const selStatus = document.getElementById('filtro-status'); if (selStatus) selStatus.value = filtros.status;
  const selTipo = document.getElementById('filtro-tipo'); if (selTipo) selTipo.value = filtros.tipo;
  const selCidade = document.getElementById('filtro-cidade'); if (selCidade) selCidade.value = filtros.cidade;
  const selClinica = document.getElementById('filtro-clinica'); if (selClinica) selClinica.value = filtros.clinica;
  const selMotivo = document.getElementById('filtro-motivo'); if (selMotivo) selMotivo.value = filtros.motivo;
  const selIniciativa = document.getElementById('filtro-iniciativa'); if (selIniciativa) selIniciativa.value = filtros.iniciativa;
  document.getElementById('btn-filtro-7dias').classList.remove('ativo');

  const mesKey = mesKeyDe(currentDate);
  renderTabela(mesKey);
  renderChipsStatus(mesKey);
  atualizarBotaoLimparFiltros();

  const painel = document.getElementById('painel-tabela');
  if (painel) painel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Clicar num quadro de destaque do Comparativo Anual ("Mês com mais/menos X")
// leva direto pro mês correspondente na aba Agendamentos, já sem filtro nenhum
function irParaMesAnual(mesKey) {
  const [ano, mes] = mesKey.split('-').map(Number);
  currentDate = new Date(ano, mes - 1, 1);
  filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '', motivo: '', iniciativa: '', periodo: '' };
  const busca = document.getElementById('filtro-busca'); if (busca) busca.value = '';
  const selStatus = document.getElementById('filtro-status'); if (selStatus) selStatus.value = '';
  const selTipo = document.getElementById('filtro-tipo'); if (selTipo) selTipo.value = '';
  const selCidade = document.getElementById('filtro-cidade'); if (selCidade) selCidade.value = '';
  const selClinica = document.getElementById('filtro-clinica'); if (selClinica) selClinica.value = '';
  const selMotivo = document.getElementById('filtro-motivo'); if (selMotivo) selMotivo.value = '';
  const selIniciativa = document.getElementById('filtro-iniciativa'); if (selIniciativa) selIniciativa.value = '';
  const btn7 = document.getElementById('btn-filtro-7dias'); if (btn7) btn7.classList.remove('ativo');
  navegarParaAba('agendamentos');
  atualizarBotaoLimparFiltros();
}

function renderSemanas(stats, mesKey) {
  // destaca a semana em que estamos HOJE (não a de mais contatos) — só faz
  // sentido marcar isso quando o mês exibido é o mês atual
  const ehMesAtual = mesKey === mesKeyDe(new Date());
  const semanaAtual = ehMesAtual ? semanaDoMes(hojeStr()) : null;
  const cont = document.getElementById('grafico-semanas');
  cont.innerHTML = stats.porSemana.map((v, i) => `
    <tr class="${(i+1) === semanaAtual ? 'semana-linha-atual' : ''}">
      <td>Semana ${i+1}</td>
      <td class="semana-num">${v}</td>
    </tr>
  `).join('');
}

// ---------- Metas ----------
const CAMPOS_META = [
  { key: 'CA', titulo: 'Consultas e Acompanhamentos', getAtual: s => s.consultasEAcompanhamentos },
  { key: 'Cirurgias', titulo: 'Cirurgias', getAtual: s => s.cirurgias },
  { key: 'Exames', titulo: 'Exames (R$)', manual: true, moeda: true },
  { key: 'Produtos', titulo: 'Produtos (R$)', manual: true, moeda: true }
];

function renderMetas(mesKey, stats) {
  const cont = document.getElementById('metas-grid');
  const metasDoMes = state.metas[mesKey] || {};

  cont.innerHTML = CAMPOS_META.map(campo => {
    const meta = Number(metasDoMes['meta'+campo.key]) || 0;
    const super_ = Number(metasDoMes['super'+campo.key]) || 0;
    let atual;
    if (campo.manual) atual = Number(metasDoMes['atual'+campo.key]) || 0;
    else atual = campo.getAtual(stats);

    const pctMeta = meta > 0 ? Math.min(100, (atual/meta)*100) : 0;
    const pctSuper = (super_ > 0 && super_ >= meta) ? Math.min(100, (meta/super_)*100) : null;

    // mês encerrado = já virou o mês (mesKey é "YYYY-MM", dá pra comparar como texto)
    const mesEncerrado = mesKey < mesKeyDe(new Date());

    let statusTxt = 'Defina a meta', statusClasse = 'andamento';
    if (meta > 0) {
      if (super_ > 0 && atual >= super_) { statusTxt = 'Supermeta batida!'; statusClasse = 'super'; }
      else if (atual >= meta) { statusTxt = 'Meta batida!'; statusClasse = 'ok'; }
      else if (mesEncerrado) { statusTxt = 'Meta não batida'; statusClasse = 'falhou'; }
      else { statusTxt = `Em andamento · ${Math.round(pctMeta)}%`; statusClasse = 'andamento'; }
    }

    const formatar = v => campo.moeda ? 'R$ ' + formatarMoeda(v) : v;

    const campoAtualManual = campo.manual
      ? (campo.moeda
          ? `<label style="flex:1">Atual (R$)<input type="text" inputmode="decimal" placeholder="0,00" data-mkey="${mesKey}" data-campo="atual${campo.key}" value="${atual ? formatarMoedaInput(atual) : ''}" class="input-meta input-moeda"></label>`
          : `<label style="flex:1">Atual<input type="number" min="0" step="1" data-mkey="${mesKey}" data-campo="atual${campo.key}" value="${atual||''}" class="input-meta"></label>`)
      : '';

    return `
      <div class="meta-linha">
        <div class="meta-cabeca">
          <span class="meta-titulo">${campo.titulo}</span>
          <span class="meta-valor">${formatar(atual)}${meta?`<span class="meta-de"> / ${formatar(meta)}</span>`:''}</span>
        </div>
        <div class="barra-progresso">
          <div class="preenchido" style="width:${pctMeta}%"></div>
          ${pctSuper !== null ? `<div class="marcador-super" style="left:${pctSuper}%"></div>` : ''}
        </div>
        <div class="meta-rodape">
          ${campo.moeda
            ? `<label>Meta (R$)<input type="text" inputmode="decimal" placeholder="0,00" data-mkey="${mesKey}" data-campo="meta${campo.key}" value="${meta ? formatarMoedaInput(meta) : ''}" class="input-meta input-moeda"></label>
          <label>Supermeta (R$)<input type="text" inputmode="decimal" placeholder="0,00" data-mkey="${mesKey}" data-campo="super${campo.key}" value="${super_ ? formatarMoedaInput(super_) : ''}" class="input-meta input-moeda"></label>`
            : `<label>Meta<input type="number" min="0" step="1" data-mkey="${mesKey}" data-campo="meta${campo.key}" value="${meta||''}" class="input-meta"></label>
          <label>Supermeta<input type="number" min="0" step="1" data-mkey="${mesKey}" data-campo="super${campo.key}" value="${super_||''}" class="input-meta"></label>`}
          ${campoAtualManual}
          <span class="meta-status ${statusClasse}">${statusTxt}</span>
        </div>
      </div>
    `;
  }).join('');

  cont.querySelectorAll('.input-moeda').forEach(inp => {
    inp.addEventListener('input', () => { inp.value = maskMoeda(inp.value); });
  });
  cont.querySelectorAll('.input-meta').forEach(inp => {
    inp.addEventListener('change', onMetaInputChange);
  });
}

function onMetaInputChange(ev) {
  const el = ev.target;
  const mkey = el.dataset.mkey;
  const campo = el.dataset.campo;
  const valor = el.classList.contains('input-moeda') ? moedaParaNumero(el.value) : (el.value === '' ? 0 : Number(el.value));
  state.metas[mkey] = Object.assign({}, state.metas[mkey] || {}, { [campo]: valor }); // atualização otimista local
  salvarCampoMeta(mkey, campo, valor).then(() => mostrarToast('Meta salva')).catch(err => mostrarToast('Erro ao salvar meta: ' + err.message));
}

// ---------- Filtros ----------
function atualizarBotaoLimparFiltros() {
  const algumAtivo = !!(filtros.busca || filtros.status || filtros.tipo || filtros.cidade || filtros.clinica || filtros.motivo || filtros.iniciativa || filtros.periodo);
  document.getElementById('btn-limpar-filtros').hidden = !algumAtivo;
}

['filtro-busca','filtro-status','filtro-tipo','filtro-cidade','filtro-clinica','filtro-motivo','filtro-iniciativa'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    filtros.busca = normalizarTexto(document.getElementById('filtro-busca').value.trim());
    filtros.status = document.getElementById('filtro-status').value;
    filtros.tipo = document.getElementById('filtro-tipo').value;
    filtros.cidade = document.getElementById('filtro-cidade').value;
    filtros.clinica = document.getElementById('filtro-clinica').value;
    filtros.motivo = document.getElementById('filtro-motivo').value;
    filtros.iniciativa = document.getElementById('filtro-iniciativa').value;
    renderTabela(mesKeyDe(currentDate));
    renderChipsStatus(mesKeyDe(currentDate));
    atualizarBotaoLimparFiltros();
  });
});

// Campo de busca se limpa sozinho ao clicar fora (sem atrapalhar um clique em
// Editar na linha filtrada: o atraso dá tempo desse clique acontecer primeiro
// com o botão original, antes da tabela ser redesenhada sem o filtro)
document.getElementById('filtro-busca').addEventListener('blur', () => {
  setTimeout(() => {
    const el = document.getElementById('filtro-busca');
    if (!el.value) return;
    el.value = '';
    filtros.busca = '';
    renderTabela(mesKeyDe(currentDate));
    renderChipsStatus(mesKeyDe(currentDate));
    atualizarBotaoLimparFiltros();
  }, 200);
});

// Atalho "Últimos 7 dias": ignora o mês selecionado e olha só os últimos 7
// dias corridos, combinando normalmente com os outros filtros (status, etc.)
document.getElementById('btn-filtro-7dias').addEventListener('click', () => {
  filtros.periodo = filtros.periodo === '7dias' ? '' : '7dias';
  document.getElementById('btn-filtro-7dias').classList.toggle('ativo', filtros.periodo === '7dias');
  renderTabela(mesKeyDe(currentDate));
  renderChipsStatus(mesKeyDe(currentDate));
  atualizarBotaoLimparFiltros();
});

document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
  document.getElementById('filtro-busca').value = '';
  document.getElementById('filtro-status').value = '';
  document.getElementById('filtro-tipo').value = '';
  document.getElementById('filtro-cidade').value = '';
  document.getElementById('filtro-clinica').value = '';
  document.getElementById('filtro-motivo').value = '';
  document.getElementById('filtro-iniciativa').value = '';
  document.getElementById('btn-filtro-7dias').classList.remove('ativo');
  filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '', motivo: '', iniciativa: '', periodo: '' };
  renderTabela(mesKeyDe(currentDate));
  renderChipsStatus(mesKeyDe(currentDate));
  atualizarBotaoLimparFiltros();
});

// ---------- Painéis recolhíveis (Metas do mês / Contatos por semana) ----------
// Lembra a preferência no aparelho dela (localStorage) — se recolher uma vez,
// continua recolhido da próxima vez que abrir o app nesse mesmo aparelho.
function configurarPainelRecolhivel(idBotao, idConteudo, chave) {
  const btn = document.getElementById(idBotao);
  const conteudo = document.getElementById(idConteudo);
  if (!btn || !conteudo) return;
  let colapsado = false;
  try { colapsado = localStorage.getItem(chave) === '1'; } catch (e) { /* sem acesso ao localStorage — segue sempre expandido */ }
  function aplicar() {
    conteudo.hidden = colapsado;
    btn.textContent = colapsado ? 'Expandir ▸' : 'Recolher ▾';
  }
  aplicar();
  btn.addEventListener('click', () => {
    colapsado = !colapsado;
    try { localStorage.setItem(chave, colapsado ? '1' : '0'); } catch (e) { /* segue sem lembrar a preferência */ }
    aplicar();
  });
}
configurarPainelRecolhivel('toggle-semanas', 'semanas-wrap', 'agendaOlhatta_colapsar_semanas');
configurarPainelRecolhivel('btn-recolher-pendentes', 'pendentes-conteudo', 'agendaOlhatta_colapsar_pendentes');

// Trocar a ordem de "Contatos pendentes" (mais próximos primeiro / mais
// distantes primeiro), lembrando a escolha no aparelho
document.getElementById('btn-ordem-pendentes').addEventListener('click', () => {
  ordemPendentes = ordemPendentes === 'desc' ? 'asc' : 'desc';
  try { localStorage.setItem('agendaOlhatta_ordem_pendentes', ordemPendentes); } catch (e) { /* segue sem lembrar a preferência */ }
  renderPainelPendentes();
});

document.querySelectorAll('#painel-tabela th.th-ordenavel').forEach(th => {
  th.addEventListener('click', () => {
    const campo = th.dataset.sort;
    if (ordenacao.campo === campo) {
      ordenacao.asc = !ordenacao.asc;
    } else {
      ordenacao.campo = campo;
      ordenacao.asc = true;
    }
    renderTabela(mesKeyDe(currentDate));
  });
});

function pillClasse(status) {
  if (status === 'Agendado') return 'agendado';
  if (status === 'Realizado') return 'realizado';
  if (status === 'Desmarcou') return 'desmarcou';
  if (status === 'Aguardando') return 'aguardando';
  return 'naoagendou';
}

// clientes que já desmarcaram 2+ vezes recebem um alerta discreto na tabela
function contarDesmarquesPorTelefone(telefone) {
  const tel = normalizarTelefone(telefone);
  if (tel.length < 8) return 0;
  return state.entries.filter(e => normalizarTelefone(e.telefone) === tel && e.status === 'Desmarcou').length;
}

function renderTabela(mesKey) {
  let lista = listaBaseAgendamentos(mesKey);
  if (filtros.status) lista = lista.filter(e => e.status === filtros.status);
  if (filtros.tipo) lista = lista.filter(e => e.tipo === filtros.tipo);
  if (filtros.cidade) lista = lista.filter(e => e.cidade === filtros.cidade);
  if (filtros.clinica) lista = lista.filter(e => e.clinica === filtros.clinica);
  if (filtros.motivo) lista = lista.filter(e => e.motivo === filtros.motivo);
  if (filtros.iniciativa) lista = lista.filter(e => (e.iniciativa || 'cliente') === filtros.iniciativa);
  if (filtros.busca) {
    const q = filtros.busca;
    const qDigitos = q.replace(/\D/g, '');
    lista = lista.filter(e =>
      normalizarTexto(e.nome).includes(q) ||
      normalizarTexto(e.animal).includes(q) ||
      normalizarTexto(e.telefone).includes(q) ||
      (qDigitos.length >= 3 && normalizarTelefone(e.telefone).includes(qDigitos)) ||
      normalizarTexto(e.clinica).includes(q) ||
      normalizarTexto(e.cidade).includes(q) ||
      normalizarTexto(e.tipo).includes(q) ||
      normalizarTexto(e.status).includes(q) ||
      normalizarTexto(e.indicacao).includes(q) ||
      normalizarTexto(e.motivo).includes(q) ||
      normalizarTexto(e.detalheMotivo).includes(q) ||
      normalizarTexto(e.obs).includes(q) ||
      formatarData(e.dataContato).includes(q) ||
      formatarData(e.dataAgendamento).includes(q)
    );
  }
  // dentro do mesmo dia, sempre do horário mais cedo pro mais tarde (quem não
  // tem horário definido fica por último naquele dia) — vale tanto na ordem
  // padrão quanto ao clicar pra ordenar pela coluna de agendamento/desmarque
  function compararHorario(a, b) {
    const ha = a.horario || '', hb = b.horario || '';
    if (ha === '' && hb === '') return 0;
    if (ha === '') return 1;
    if (hb === '') return -1;
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  }

  if (ordenacao.campo) {
    const campo = ordenacao.campo;
    lista = lista.slice().sort((a,b) => {
      const va = (a[campo] || '').toString().toLowerCase();
      const vb = (b[campo] || '').toString().toLowerCase();
      let cmp;
      if (va === '' && vb === '') cmp = 0;
      else if (va === '') cmp = 1;
      else if (vb === '') cmp = -1;
      else cmp = va < vb ? -1 : va > vb ? 1 : 0;
      if (campo === 'dataAgendamento' && cmp === 0) return compararHorario(a, b);
      return ordenacao.asc ? cmp : -cmp;
    });
  } else {
    // ordem padrão (nenhuma coluna clicada): o último contato registrado aparece
    // primeiro, pra ela sempre ver na hora o que acabou de cadastrar
    lista = lista.slice().sort((a,b) => {
      const ca = a.criadoEm || '', cb = b.criadoEm || '';
      if (ca !== cb) return ca < cb ? 1 : -1;
      return compararHorario(a, b);
    });
  }

  document.querySelectorAll('#painel-tabela th.th-ordenavel').forEach(th => {
    const ativo = ordenacao.campo === th.dataset.sort;
    th.classList.toggle('ordem-ativa', ativo);
    th.querySelector('.seta-ordem').textContent = ativo ? (ordenacao.asc ? '▲' : '▼') : '⇅';
  });

  const hoje = hojeStr();
  const corpo = document.getElementById('tabela-corpo');
  document.getElementById('tabela-vazia').hidden = lista.length !== 0;
  corpo.innerHTML = lista.map(e => {
    const ehHoje = !!e.dataAgendamento && e.dataAgendamento === hoje;
    const desmarques = contarDesmarquesPorTelefone(e.telefone);
    const jaAgendado = STATUS_AGENDADOS.includes(e.status);
    return `
    <tr data-id="${e.id}" class="${ehHoje ? 'linha-hoje' : ''}">
      <td><span class="avatar-mini">${escapeHtml(iniciais(e.nome))}</span>${escapeHtml(e.nome||'')}${desmarques >= 2 ? `<span class="badge-alerta">já desmarcou ${desmarques}x</span>` : ''}${e.mesmoContatoOutroAnimal ? `<span class="badge-mesmo-contato">mesmo telefonema</span>` : ''}${e.iniciativa === 'eu' ? `<span class="badge-iniciativa-eu">Eu entrei em contato</span>` : ''}</td>
      <td>${telefoneClicavel(e.telefone)}</td>
      <td>${escapeHtml(e.animal||'')}</td>
      <td>${escapeHtml(e.clinica||'')}</td>
      <td>${escapeHtml(e.cidade||'')}</td>
      <td>${escapeHtml(e.tipo||'')}</td>
      <td>${formatarData(e.dataContato)}</td>
      <td><span class="pill ${pillClasse(e.status)}">${e.status||''}</span></td>
      <td style="text-align:center"><input type="checkbox" class="chk-agendado" data-id="${e.id}" ${jaAgendado ? 'checked' : ''} title="${jaAgendado ? 'Já agendado' : 'Marcar como agendado'}"></td>
      <td>${formatarData(e.dataAgendamento)}${e.horario ? `<span class="hora-agend">${escapeHtml(e.horario)}</span>` : ''}${ehHoje ? '<span class="tag-hoje">Hoje</span>' : ''}</td>
      ${celObsClicavel(e.motivo, e.detalheMotivo, 'Motivo')}
      ${celObsClicavel(e.obs, '', 'Observação')}
      <td class="acoes">
        <button class="btn outline sm btn-editar">Editar</button>
        ${e.status === 'Agendado' ? '<button class="btn vermelho sm btn-desmarcar" title="Marcar como Desmarcou rapidinho">✕ Desmarcar</button>' : ''}
      </td>
    </tr>
  `;
  }).join('');

  corpo.querySelectorAll('.btn-editar').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      abrirModalEntry(state.entries.find(e => e.id === id));
    });
  });

  // Atalho rápido: marca como Desmarcou direto na tabela, sem abrir o
  // formulário inteiro (o motivo/detalhe, se ela quiser, continua dando pra
  // completar depois clicando em Editar)
  corpo.querySelectorAll('.btn-desmarcar').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      const entry = state.entries.find(e => e.id === id);
      if (!entry) return;
      if (!confirm('Marcar "' + (entry.nome || 'esse contato') + '" como Desmarcou?')) return;
      const atualizado = Object.assign({}, entry, {
        status: 'Desmarcou',
        dataAgendamento: hojeStr(),
        motivo: entry.motivo || '',
        detalheMotivo: entry.detalheMotivo || ''
      });
      btn.disabled = true;
      atualizarContato(id, atualizado)
        .then(() => mostrarToast('Marcado como Desmarcou'))
        .catch(err => { mostrarToast('Não foi possível marcar: ' + err.message); btn.disabled = false; });
    });
  });

  corpo.querySelectorAll('.chk-agendado').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.id;
      const entry = state.entries.find(e => e.id === id);
      if (!entry) return;
      if (STATUS_AGENDADOS.includes(entry.status)) {
        // já estava agendado — não dá pra "desmarcar" com um clique só (precisa de motivo), abre o formulário
        chk.checked = true;
        abrirModalEntry(entry);
        return;
      }
      const atualizado = Object.assign({}, entry, {
        status: 'Agendado',
        dataAgendamento: entry.dataAgendamento || hojeStr(),
        motivo: '',
        detalheMotivo: ''
      });
      chk.disabled = true;
      atualizarContato(id, atualizado).then(() => {
        mostrarToast('Marcado como agendado');
      }).catch(err => {
        chk.checked = false;
        mostrarToast('Não foi possível marcar: ' + err.message);
      }).finally(() => { chk.disabled = false; });
    });
  });

  corpo.querySelectorAll('.obs-cel.clicavel').forEach(cel => {
    cel.addEventListener('click', () => abrirModalTexto(cel.dataset.titulo, cel.dataset.completo));
  });
}

// Monta a célula de Motivo/Obs.: texto curto some direto na tabela; se houver
// texto, a célula fica clicável e abre um modalzinho com o texto inteiro —
// em vez de esticar a linha da tabela pra caber tudo.
function celObsClicavel(principal, extra, titulo) {
  const completo = (principal || '') + (extra ? ' — ' + extra : '');
  if (!completo) return `<td class="obs-cel"><span>—</span></td>`;
  // tudo numa linha só (trunca com reticências) — nunca deixa a linha da
  // tabela crescer; o texto inteiro (motivo + detalhe) só aparece no modal
  return `<td class="obs-cel clicavel" data-titulo="${escapeHtml(titulo)}" data-completo="${escapeHtml(completo)}" title="Toque para ver o texto completo">
    <span>${escapeHtml(completo)}</span>
  </td>`;
}

function abrirModalTexto(titulo, texto) {
  document.getElementById('modal-texto-titulo').textContent = titulo || '';
  document.getElementById('modal-texto-corpo').textContent = texto || '';
  abrirOverlay('modal-texto');
  document.getElementById('modal-texto').scrollTop = 0;
}
document.getElementById('fechar-modal-texto').addEventListener('click', () => {
  fecharOverlay('modal-texto');
});
document.getElementById('modal-texto').addEventListener('click', ev => {
  if (ev.target.id === 'modal-texto') fecharOverlay('modal-texto');
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Iniciais pro circulinho colorido do nome na tabela (ex: "Maria Tutora" -> "MT")
function iniciais(nome) {
  const partes = (nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

// Telefone clicável: abre o WhatsApp já na conversa com esse número, sem
// precisar copiar/colar. Assume Brasil (DDI 55) quando o número não já tem DDI.
function linkWhatsapp(telefone) {
  const digitos = normalizarTelefone(telefone);
  if (digitos.length < 10) return null; // sem DDD não dá pra confiar
  const comDDI = digitos.length <= 11 ? '55' + digitos : digitos;
  return `https://wa.me/${comDDI}`;
}
function telefoneClicavel(telefone) {
  const texto = escapeHtml(telefone || '');
  if (!telefone) return '—';
  const link = linkWhatsapp(telefone);
  if (!link) return texto;
  return `<a href="${link}" target="_blank" rel="noopener" class="tel-link" title="Chamar no WhatsApp" onclick="event.stopPropagation()">${texto}</a>`;
}

// ============================================================
// MODAL — NOVO / EDITAR CONTATO
// ============================================================
document.getElementById('btn-novo').addEventListener('click', () => abrirModalEntry(null));
document.getElementById('btn-novo-inicio').addEventListener('click', () => abrirModalEntry(null));

// ============================================================
// ABA INÍCIO — seletor de data (padrão: hoje, mas dá pra escolher outro dia)
// ============================================================
(function () {
  const inputData = document.getElementById('inicio-data');
  const btnHoje = document.getElementById('inicio-data-hoje');
  if (inputData) {
    inputData.value = inicioData;
    inputData.addEventListener('change', () => {
      inicioData = inputData.value || hojeStr();
      renderInicio();
    });
  }
  if (btnHoje) {
    btnHoje.addEventListener('click', () => {
      inicioData = hojeStr();
      if (inputData) inputData.value = inicioData;
      renderInicio();
    });
  }
})();
document.getElementById('fechar-modal-entry').addEventListener('click', fecharModalEntry);
document.getElementById('btn-cancelar-entry').addEventListener('click', fecharModalEntry);

document.getElementById('f-status').addEventListener('change', atualizarVisibilidadeMotivo);
function atualizarVisibilidadeMotivo() {
  const status = document.getElementById('f-status').value;
  const precisaMotivo = STATUS_NAO_AGENDADOS.includes(status);
  const ehAguardando = status === 'Aguardando';
  document.getElementById('campo-motivo').hidden = !(precisaMotivo || ehAguardando);
  document.getElementById('campo-motivo-select').hidden = !precisaMotivo;
  document.getElementById('label-detalhe-motivo').textContent = ehAguardando ? 'Observação (opcional)' : 'Detalhes do motivo';
  document.getElementById('f-data2-label').textContent = precisaMotivo ? 'Data do desmarque/contato' : (ehAguardando ? 'Contatar novamente em' : 'Data de agendamento');

  // ao marcar como Agendado/Realizado, a data já nasce no dia de hoje (então
  // ano e mês já ficam certos) — ela só precisa trocar o dia (ou o mês/ano,
  // se o agendamento for em outro período), sem digitar tudo do zero toda vez
  const campoData2 = document.getElementById('f-data2');
  if (STATUS_AGENDADOS.includes(status) && !campoData2.value) {
    campoData2.value = hojeStr();
  }

  // ao marcar Desmarcou/Não Agendou, esconde o campo de data — ela não quer
  // ficar vendo/preenchendo isso nesses casos; a gravação continua registrando
  // hoje automaticamente (ver o submit do formulário), só não aparece na tela
  document.getElementById('campo-data2').hidden = precisaMotivo;

  // horário só faz sentido quando realmente existe um agendamento (marcado ou já realizado);
  // só esconde o campo (não apaga o valor, caso ela troque o status e volte)
  document.getElementById('campo-horario').hidden = !STATUS_AGENDADOS.includes(status);

  // Desmarcou/Não Agendou também não deve mostrar o histórico de "contato
  // repetido" — ela só quer marcar rápido, sem esse painel aparecendo
  atualizarPainelHistorico();
}

document.getElementById('f-motivo').addEventListener('change', ev => {
  const sel = ev.target;
  if (sel.value !== '__novo__') return;
  const novo = (prompt('Digite o novo motivo:') || '').trim();
  if (!novo) { sel.value = state.categorias.motivos[0] || ''; return; }
  if (state.categorias.motivos.includes(novo)) { sel.value = novo; return; }
  sel.disabled = true;
  adicionarCategoria('motivos', novo).then(() => {
    sel.disabled = false;
    if (!state.categorias.motivos.includes(novo)) state.categorias.motivos.push(novo);
    popularSelects();
    sel.value = novo;
  }).catch(err => {
    sel.disabled = false;
    sel.value = state.categorias.motivos[0] || '';
    mostrarToast('Não foi possível adicionar o motivo: ' + err.message);
  });
});

document.getElementById('f-nome').addEventListener('input', atualizarPainelHistorico);
document.getElementById('f-telefone').addEventListener('input', atualizarPainelHistorico);
document.getElementById('f-telefone').addEventListener('blur', autopreencherPorTelefone);

document.getElementById('btn-mostrar-tutor2').addEventListener('click', () => {
  const bloco = document.getElementById('bloco-tutor2');
  bloco.hidden = !bloco.hidden;
  document.getElementById('btn-mostrar-tutor2').textContent = bloco.hidden ? '+ Tem outro responsável por este animal?' : '− Outro responsável';
  if (!bloco.hidden) document.getElementById('f-nome2').focus();
});

function abrirModalEntry(entry) {
  popularSelects();
  editingEntryId = entry ? entry.id : null;
  document.getElementById('entry-titulo').textContent = entry ? 'Editar contato' : 'Novo contato';
  document.getElementById('btn-excluir-entry').hidden = !entry;

  document.getElementById('f-nome').value = entry ? entry.nome||'' : '';
  document.getElementById('f-telefone').value = entry ? entry.telefone||'' : '';
  document.getElementById('f-animal').value = entry ? entry.animal||'' : '';
  document.getElementById('f-mesmo-contato').checked = entry ? !!entry.mesmoContatoOutroAnimal : false;
  document.getElementById('f-nome2').value = entry ? entry.nome2||'' : '';
  document.getElementById('f-telefone2').value = entry ? entry.telefone2||'' : '';
  // se já tinha um segundo responsável salvo, mostra o bloco já aberto;
  // num contato novo (ou sem isso preenchido), começa recolhido
  const temTutor2 = !!(entry && (entry.nome2 || entry.telefone2));
  document.getElementById('bloco-tutor2').hidden = !temTutor2;
  document.getElementById('btn-mostrar-tutor2').textContent = temTutor2 ? '− Outro responsável' : '+ Tem outro responsável por este animal?';
  document.getElementById('f-indicacao').value = entry ? entry.indicacao||'' : '';
  document.getElementById('f-clinica').value = entry ? entry.clinica||'' : (state.categorias.clinicas[0]||'');
  document.getElementById('f-cidade').value = entry ? entry.cidade||'' : (state.categorias.cidades[0]||'');
  document.getElementById('f-tipo').value = entry ? entry.tipo||'' : (state.categorias.tipos[0]||'');
  document.getElementById('f-datacontato').value = entry ? entry.dataContato||'' : hojeStr();
  // padrão é o cliente entrar em contato com a clínica — é o caso mais comum;
  // só muda pra "Eu entrei em contato" quando ela mesma ligou pro cliente
  document.getElementById('f-iniciativa').value = entry ? entry.iniciativa || 'cliente' : 'cliente';
  // contato novo começa como "Aguardando" — só vira Agendado/Realizado/etc quando
  // ela de fato decidir o que aconteceu com esse contato
  document.getElementById('f-status').value = entry ? entry.status||'Agendado' : 'Aguardando';
  document.getElementById('f-data2').value = entry ? entry.dataAgendamento||'' : '';
  document.getElementById('f-horario').value = entry ? entry.horario||'' : '';
  document.getElementById('f-motivo').value = entry ? entry.motivo||'' : (state.categorias.motivos[0]||'');
  document.getElementById('f-detalhe-motivo').value = entry ? entry.detalheMotivo||'' : '';
  document.getElementById('f-obs').value = entry ? entry.obs||'' : '';
  atualizarVisibilidadeMotivo(); // também atualiza o painel de histórico

  abrirOverlay('modal-entry');
  document.getElementById('modal-entry').scrollTop = 0;
}
function fecharModalEntry() {
  fecharOverlay('modal-entry');
  document.getElementById('historico-contato').hidden = true;
}

// Abre o formulário como um NOVO contato, já com nome/telefone/clínica/cidade
// preenchidos a partir de outro registro — pra quando o mesmo tutor liga e
// agenda outro animal, sem precisar redigitar os dados dele. Já marca "mesmo
// telefonema" (não conta como contato novo nas estatísticas) e deixa o campo
// Animal em foco pra ela só completar o que muda.
function duplicarContato(entry) {
  abrirModalEntry(null);
  document.getElementById('f-nome').value = entry.nome || '';
  document.getElementById('f-telefone').value = entry.telefone || '';
  document.getElementById('f-indicacao').value = entry.indicacao || '';
  document.getElementById('f-clinica').value = entry.clinica || (state.categorias.clinicas[0]||'');
  document.getElementById('f-cidade').value = entry.cidade || (state.categorias.cidades[0]||'');
  document.getElementById('f-datacontato').value = entry.dataContato || hojeStr();
  document.getElementById('f-iniciativa').value = entry.iniciativa || 'cliente';
  document.getElementById('f-mesmo-contato').checked = true;
  atualizarPainelHistorico();
  document.getElementById('f-animal').focus();
}

document.getElementById('form-entry').addEventListener('submit', ev => {
  ev.preventDefault();
  const status = document.getElementById('f-status').value;
  const precisaMotivo = STATUS_NAO_AGENDADOS.includes(status);
  const mostrarDetalhe = precisaMotivo || status === 'Aguardando';
  const btnSalvar = ev.target.querySelector('button[type=submit]');
  // nenhum campo é obrigatório; quando a data do desmarque/não agendamento fica
  // em branco, assume o dia de hoje (é quando ela está registrando isso)
  const data2Digitada = document.getElementById('f-data2').value;
  const dataAgendamentoFinal = (!data2Digitada && precisaMotivo) ? hojeStr() : data2Digitada;
  const dados = {
    nome: document.getElementById('f-nome').value.trim(),
    telefone: document.getElementById('f-telefone').value.trim(),
    animal: document.getElementById('f-animal').value.trim(),
    nome2: document.getElementById('f-nome2').value.trim(),
    telefone2: document.getElementById('f-telefone2').value.trim(),
    indicacao: document.getElementById('f-indicacao').value.trim(),
    clinica: document.getElementById('f-clinica').value,
    cidade: document.getElementById('f-cidade').value,
    tipo: document.getElementById('f-tipo').value,
    iniciativa: document.getElementById('f-iniciativa').value || 'cliente',
    dataContato: document.getElementById('f-datacontato').value || hojeStr(),
    mesmoContatoOutroAnimal: document.getElementById('f-mesmo-contato').checked,
    status: status,
    dataAgendamento: dataAgendamentoFinal,
    horario: STATUS_AGENDADOS.includes(status) ? document.getElementById('f-horario').value : '',
    motivo: precisaMotivo ? document.getElementById('f-motivo').value : '',
    detalheMotivo: mostrarDetalhe ? document.getElementById('f-detalhe-motivo').value.trim() : '',
    obs: document.getElementById('f-obs').value.trim(),
    criadoEm: (editingEntryId && state.entries.find(e=>e.id===editingEntryId)?.criadoEm) || new Date().toISOString()
  };

  btnSalvar.disabled = true;
  btnSalvar.textContent = 'Salvando...';
  const promessa = editingEntryId ? atualizarContato(editingEntryId, dados) : criarContato(dados);
  promessa.then(() => {
    mostrarToast('Contato salvo');
    fecharModalEntry();
  }).catch(err => {
    mostrarToast('Não foi possível salvar: ' + err.message);
  }).finally(() => {
    btnSalvar.disabled = false;
    btnSalvar.textContent = 'Salvar';
  });
});

document.getElementById('btn-excluir-entry').addEventListener('click', () => {
  if (!editingEntryId) return;
  if (!confirm('Excluir este contato? Essa ação não pode ser desfeita.')) return;
  excluirContato(editingEntryId).then(() => {
    mostrarToast('Contato excluído');
    fecharModalEntry();
  }).catch(err => mostrarToast('Não foi possível excluir: ' + err.message));
});

// ============================================================
// CATEGORIAS
// ============================================================
const CAT_LABELS = { clinicas: 'Clínicas', cidades: 'Cidades', tipos: 'Tipos', motivos: 'Motivos' };

document.getElementById('btn-categorias').addEventListener('click', () => {
  renderCategoriasPainel();
  abrirOverlay('modal-categorias');
  document.getElementById('modal-categorias').scrollTop = 0;
});
document.getElementById('fechar-modal-categorias').addEventListener('click', () => {
  fecharOverlay('modal-categorias');
});

let limparCampoCategoriaAoRenderizar = new Set();

function renderCategoriasPainel() {
  const cont = document.getElementById('cat-grid');
  // preserva o que a pessoa já tinha digitado nos campos "Adicionar..." antes de redesenhar
  // (exceto o campo que acabou de ser usado pra adicionar, que deve ficar vazio)
  const valoresDigitados = {};
  cont.querySelectorAll('[data-chave-input]').forEach(inp => {
    const k = inp.dataset.chaveInput;
    valoresDigitados[k] = limparCampoCategoriaAoRenderizar.has(k) ? '' : inp.value;
  });
  limparCampoCategoriaAoRenderizar.clear();

  cont.innerHTML = Object.keys(CAT_LABELS).map(chave => `
    <div class="cat-bloco">
      <h4>${CAT_LABELS[chave]}</h4>
      <div class="chips" data-chave="${chave}">
        ${(state.categorias[chave]||[]).map(v => `<span class="chip">${escapeHtml(v)}<button data-chave="${chave}" data-valor="${escapeHtml(v)}" class="btn-remover-cat">&times;</button></span>`).join('')}
      </div>
      <div class="cat-add">
        <input type="text" placeholder="Adicionar..." data-chave-input="${chave}">
        <button class="btn sm marrom" data-chave-btn="${chave}">Add</button>
      </div>
    </div>
  `).join('');

  cont.querySelectorAll('.btn-remover-cat').forEach(btn => {
    btn.addEventListener('click', () => {
      const chave = btn.dataset.chave, valor = btn.dataset.valor;
      removerCategoria(chave, valor).then(() => mostrarToast('Categoria removida')).catch(err => mostrarToast('Erro ao remover: ' + err.message));
    });
  });
  cont.querySelectorAll('[data-chave-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const chave = btn.dataset.chaveBtn;
      const input = cont.querySelector(`[data-chave-input="${chave}"]`);
      const valor = input.value.trim();
      if (!valor) return;
      if ((state.categorias[chave]||[]).includes(valor)) { mostrarToast('Já existe'); return; }
      limparCampoCategoriaAoRenderizar.add(chave);
      input.value = '';
      adicionarCategoria(chave, valor).then(() => mostrarToast('Categoria adicionada')).catch(err => mostrarToast('Erro ao adicionar: ' + err.message));
    });
  });

  // devolve o que a pessoa estava digitando em outros campos, já que o painel acabou de ser redesenhado
  Object.keys(valoresDigitados).forEach(chave => {
    const inp = cont.querySelector(`[data-chave-input="${chave}"]`);
    if (inp && valoresDigitados[chave]) inp.value = valoresDigitados[chave];
  });
}

// ============================================================
// ABA COMPARATIVO ANUAL
// ============================================================
document.getElementById('ano-anterior').addEventListener('click', () => { anoAnual--; renderAnual(); });
document.getElementById('ano-proximo').addEventListener('click', () => { anoAnual++; renderAnual(); });
document.getElementById('ano-atual').addEventListener('click', () => { anoAnual = new Date().getFullYear(); renderAnual(); });

function statsDoAno(ano) {
  const meses = [];
  for (let m = 0; m < 12; m++) {
    const mesKey = ano + '-' + pad2(m+1);
    const s = statsDoMes(mesKey);
    meses.push({ mesKey, contatos: s.total, consultas: s.consultasEAcompanhamentos, cirurgias: s.cirurgias });
  }
  return meses;
}

function destaque(meses, campo, tipo) {
  const comDados = meses.filter(m => m[campo] > 0);
  if (!comDados.length) return null;
  const ordenado = comDados.slice().sort((a,b) => tipo === 'max' ? b[campo]-a[campo] : a[campo]-b[campo]);
  return ordenado[0];
}

function renderAnual() {
  document.getElementById('ano-rotulo').textContent = anoAnual;
  const meses = statsDoAno(anoAnual);

  const defs = [
    { campo: 'contatos', label: 'Contatos' },
    { campo: 'consultas', label: 'Consultas/Acomp.' },
    { campo: 'cirurgias', label: 'Cirurgias' }
  ];

  const destaquesHtml = defs.map(d => {
    const maisD = destaque(meses, d.campo, 'max');
    const menosD = destaque(meses, d.campo, 'min');
    return `
      <div class="stat-tile${maisD ? ' stat-tile-clicavel' : ''}"${maisD ? ` data-mes="${maisD.mesKey}" title="Ver ${MESES[Number(maisD.mesKey.slice(5,7))-1].toLowerCase()} em Agendamentos"` : ''}>
        <div class="rot">Mês com mais ${d.label}</div>
        <div class="val">${maisD ? MESES_ABREV[Number(maisD.mesKey.slice(5,7))-1].toLowerCase() + ' (' + maisD[d.campo] + ')' : '—'}</div>
      </div>
      <div class="stat-tile${menosD ? ' stat-tile-clicavel' : ''}"${menosD ? ` data-mes="${menosD.mesKey}" title="Ver ${MESES[Number(menosD.mesKey.slice(5,7))-1].toLowerCase()} em Agendamentos"` : ''}>
        <div class="rot">Mês com menos ${d.label}</div>
        <div class="val">${menosD ? MESES_ABREV[Number(menosD.mesKey.slice(5,7))-1].toLowerCase() + ' (' + menosD[d.campo] + ')' : '—'}</div>
      </div>
    `;
  }).join('');
  const contDestaques = document.getElementById('anual-destaques');
  contDestaques.innerHTML = destaquesHtml;
  contDestaques.querySelectorAll('.stat-tile-clicavel').forEach(el => {
    el.addEventListener('click', () => irParaMesAnual(el.dataset.mes));
  });

  const maxPorCampo = {};
  defs.forEach(d => { maxPorCampo[d.campo] = Math.max(0, ...meses.map(m => m[d.campo])); });

  const hoje = new Date();
  const mesAtualIdx = anoAnual === hoje.getFullYear() ? hoje.getMonth() : -1;

  // valor em destaque (maior do mês) fica num <span> próprio — ver comentário
  // da classe .valor-destaque no CSS: assim a bolinha não empurra o número e
  // ele continua centralizado igual aos outros da mesma coluna
  const celulaAnual = (valor, ehMaior) => ehMaior ? `<span class="valor-destaque">${valor}</span>` : valor;

  const linhasHtml = meses.map((m,i) => `
    <tr class="${i === mesAtualIdx ? 'mes-linha-atual' : ''}">
      <td class="mes-nome">${MESES_ABREV[i]}</td>
      <td>${celulaAnual(m.contatos, m.contatos === maxPorCampo.contatos && m.contatos > 0)}</td>
      <td>${celulaAnual(m.consultas, m.consultas === maxPorCampo.consultas && m.consultas > 0)}</td>
      <td>${celulaAnual(m.cirurgias, m.cirurgias === maxPorCampo.cirurgias && m.cirurgias > 0)}</td>
    </tr>
  `).join('');
  document.getElementById('tabela-anual-corpo').innerHTML = linhasHtml;

  renderResumoAnual(meses, defs);
}

// ---- Resumo do Comparativo Anual: pizza + tabela, lado a lado ----
// Cores escolhidas e validadas pra quem tem daltonismo conseguir diferenciar
// os 3 indicadores mesmo sem olhar a legenda (não são as cores do tema do app).
const CORES_ANUAL = { contatos: '#2a78d6', consultas: '#eb6834', cirurgias: '#1baf7a' };

// Antes era um gráfico de linhas (uma por indicador, mês a mês) — trocado por
// pedido dela: ocupava altura demais, e o "Comparativo por mês" logo abaixo
// já mostra o detalhe mês a mês. Agora é só o total do ano: uma pizza
// (proporção entre os 3 indicadores) + uma tabela com os números exatos.
function renderResumoAnual(meses, defs) {
  const pizza = document.getElementById('anual-pizza');
  const legenda = document.getElementById('anual-legenda');
  const corpoTabela = document.getElementById('anual-resumo-corpo');
  if (!pizza || !legenda || !corpoTabela) return;

  legenda.innerHTML = defs.map(d => `<span class="legenda-item"><span class="legenda-linha" style="background:${CORES_ANUAL[d.campo]}"></span>${escapeHtml(d.label)}</span>`).join('');

  const totais = {};
  defs.forEach(d => { totais[d.campo] = meses.reduce((s, m) => s + (m[d.campo] || 0), 0); });
  const somaTotal = defs.reduce((s, d) => s + totais[d.campo], 0);

  if (somaTotal === 0) {
    pizza.style.background = 'var(--creme-escuro)';
    pizza.title = 'Sem dados neste ano';
  } else {
    let acc = 0;
    const fatias = defs.map(d => {
      const de = acc;
      const ate = acc + (totais[d.campo] / somaTotal) * 360;
      acc = ate;
      return `${CORES_ANUAL[d.campo]} ${de.toFixed(2)}deg ${ate.toFixed(2)}deg`;
    });
    pizza.style.background = `conic-gradient(${fatias.join(', ')})`;
    pizza.title = defs.map(d => `${d.label}: ${totais[d.campo]}`).join(' · ');
  }

  corpoTabela.innerHTML = defs.map(d => {
    const total = totais[d.campo];
    const pct = somaTotal ? Math.round((total / somaTotal) * 100) : 0;
    return `<tr><td><span class="legenda-linha" style="background:${CORES_ANUAL[d.campo]}"></span>${escapeHtml(d.label)}</td><td>${total}</td><td>${pct}%</td></tr>`;
  }).join('');
}

// ============================================================
// ABA RELATÓRIOS
// ============================================================
document.getElementById('relatorio-modo-mensal').addEventListener('click', () => navegarParaSubaba('relatorios', 'mensal'));
document.getElementById('relatorio-modo-semanal').addEventListener('click', () => navegarParaSubaba('relatorios', 'semanal'));

document.getElementById('relatorio-mes-anterior').addEventListener('click', () => { relatorioMesData.setMonth(relatorioMesData.getMonth()-1); renderRelatorios(); });
document.getElementById('relatorio-mes-proximo').addEventListener('click', () => { relatorioMesData.setMonth(relatorioMesData.getMonth()+1); renderRelatorios(); });
document.getElementById('relatorio-mes-hoje').addEventListener('click', () => { relatorioMesData = new Date(); renderRelatorios(); });

document.getElementById('relatorio-semana-anterior').addEventListener('click', () => { relatorioSemanaInicio.setDate(relatorioSemanaInicio.getDate()-7); renderRelatorios(); });
document.getElementById('relatorio-semana-proximo').addEventListener('click', () => { relatorioSemanaInicio.setDate(relatorioSemanaInicio.getDate()+7); renderRelatorios(); });
document.getElementById('relatorio-semana-hoje').addEventListener('click', () => { relatorioSemanaInicio = inicioSemanaDe(new Date()); renderRelatorios(); });

document.getElementById('btn-exportar-pdf').addEventListener('click', () => window.print());

// ---- Filtro por tipo na lista de observações de desmarque/não agendamento ----
// "Todos" por padrão; guarda o período atual junto pra o filtro resetar
// sozinho pra "Todos" quando ela troca de mês/semana (senão ia parecer que
// sumiu gente da lista sem motivo ao navegar)
let relatorioMotivoFiltroTipo = 'todos';
let relatorioMotivoFiltroPeriodoKey = null;
let relatorioStatsAtual = null;

document.getElementById('relatorio-motivos').addEventListener('click', ev => {
  const chip = ev.target.closest('.motivo-filtro-chip');
  if (!chip || !relatorioStatsAtual) return;
  relatorioMotivoFiltroTipo = chip.dataset.tipo;
  renderMotivosRelatorio(relatorioStatsAtual);
});

// ---- Observação do relatório: texto livre por período, com controles de
// aumentar/diminuir/normalizar o tamanho da letra e negrito/sublinhado ----
const OBS_PADRAO = { texto: '', tamanho: 14, negrito: false, sublinhado: false };
const OBS_FONTE_MIN = 12, OBS_FONTE_MAX = 22, OBS_FONTE_PASSO = 2, OBS_FONTE_NORMAL = 14;

function obsDoPeriodo(chave) {
  return Object.assign({}, OBS_PADRAO, state.relatorioObs[chave] || {});
}

function aplicarEstiloObs(cfg) {
  const campo = document.getElementById('relatorio-obs');
  campo.style.fontSize = cfg.tamanho + 'px';
  campo.style.fontWeight = cfg.negrito ? '700' : '400';
  campo.style.textDecoration = cfg.sublinhado ? 'underline' : 'none';
  document.getElementById('obs-negrito').classList.toggle('ativo', cfg.negrito);
  document.getElementById('obs-sublinhado').classList.toggle('ativo', cfg.sublinhado);
  document.getElementById('obs-fonte-menos').disabled = cfg.tamanho <= OBS_FONTE_MIN;
  document.getElementById('obs-fonte-mais').disabled = cfg.tamanho >= OBS_FONTE_MAX;
}

// Salva sozinho (mesmo padrão de autosave já usado em Metas), sempre na chave
// do período que está na tela no momento — guardada no próprio campo via
// dataset, pra não salvar no período errado se ela trocar de mês/semana rápido
function salvarEstadoObs(chave, cfg) {
  state.relatorioObs[chave] = cfg; // atualização otimista local
  document.getElementById('relatorio-obs-status').textContent = 'Salvando...';
  salvarObservacaoRelatorio(chave, cfg)
    .then(() => { document.getElementById('relatorio-obs-status').textContent = 'Salvo'; })
    .catch(err => { document.getElementById('relatorio-obs-status').textContent = ''; mostrarToast('Não foi possível salvar a observação: ' + err.message); });
}

document.getElementById('relatorio-obs').addEventListener('blur', ev => {
  const chave = ev.target.dataset.chave;
  if (!chave) return;
  const atual = obsDoPeriodo(chave);
  if (ev.target.value === atual.texto) return; // nada mudou, não grava à toa
  salvarEstadoObs(chave, Object.assign({}, atual, { texto: ev.target.value }));
});

function botaoObsClicado(mudar) {
  const campo = document.getElementById('relatorio-obs');
  const chave = campo.dataset.chave;
  if (!chave) return;
  const cfg = Object.assign({}, obsDoPeriodo(chave), { texto: campo.value }, mudar(obsDoPeriodo(chave)));
  aplicarEstiloObs(cfg);
  salvarEstadoObs(chave, cfg);
}

document.getElementById('obs-fonte-menos').addEventListener('click', () => botaoObsClicado(cfg => ({ tamanho: Math.max(OBS_FONTE_MIN, cfg.tamanho - OBS_FONTE_PASSO) })));
document.getElementById('obs-fonte-mais').addEventListener('click', () => botaoObsClicado(cfg => ({ tamanho: Math.min(OBS_FONTE_MAX, cfg.tamanho + OBS_FONTE_PASSO) })));
document.getElementById('obs-fonte-normal').addEventListener('click', () => botaoObsClicado(() => ({ tamanho: OBS_FONTE_NORMAL })));
document.getElementById('obs-negrito').addEventListener('click', () => botaoObsClicado(cfg => ({ negrito: !cfg.negrito })));
document.getElementById('obs-sublinhado').addEventListener('click', () => botaoObsClicado(cfg => ({ sublinhado: !cfg.sublinhado })));

// Diferença entre o período atual e o anterior — vira tanto o "selinho" dos
// cartões quanto a frase automática do texto do relatório
// A porcentagem fica travada em no máximo 100% (pediu pra não aparecer tipo
// "aumento de 167%", que confunde — acima de 100% já é "dobrou ou mais",
// então trava em 100% pra ficar sempre fácil de entender de cabeça
function variacaoRelatorio(atual, anterior) {
  if (anterior === 0) return { tipo: atual === 0 ? 'igual' : 'novo', pct: 0 };
  if (atual === anterior) return { tipo: 'igual', pct: 0 };
  const pct = Math.min(100, Math.round(Math.abs(atual - anterior) / anterior * 100));
  return { tipo: atual > anterior ? 'alta' : 'queda', pct };
}

function selinhoVariacao(atual, anterior) {
  const v = variacaoRelatorio(atual, anterior);
  if (v.tipo === 'novo') return `<span class="delta delta-alta">novo</span>`;
  if (v.tipo === 'igual') return `<span class="delta delta-igual">= período anterior</span>`;
  return `<span class="delta ${v.tipo === 'alta' ? 'delta-alta' : 'delta-queda'}">${v.tipo === 'alta' ? '▲' : '▼'} ${v.pct}%</span>`;
}

// emAnterior: "em setembro" / "na semana anterior" — pro caso "não tinha nada pra comparar"
// aAnterior: "a setembro" / "à semana anterior" — pro "igual a..." e "comparado a..."
//
// Fala corrida, sem parêntese nem travessão — ela não gostou do jeito mais
// "técnico" de antes. "fraseBase" é o pedaço que já diz o número (tipo
// "foram agendados 3"); quando dá pra continuar a mesma frase (aumento ou
// queda), a comparação emenda com vírgula, do jeito que alguém falaria
// normalmente; quando não encaixa numa oração só (período novo ou igual),
// vira uma frase curta à parte começando com "Isso"
function comVariacao(fraseBase, atual, anterior, emAnterior, aAnterior) {
  const v = variacaoRelatorio(atual, anterior);
  if (v.tipo === 'alta' || v.tipo === 'queda') {
    return `${fraseBase}, ${v.tipo === 'alta' ? 'um aumento' : 'uma queda'} de ${v.pct}% comparado ${aAnterior}, que teve ${anterior}.`;
  }
  if (v.tipo === 'igual') return `${fraseBase}. Isso ficou igual ${aAnterior}.`;
  return `${fraseBase}. Isso não tinha acontecido ${emAnterior}, então não dá pra comparar.`;
}

function renderCardsRelatorio(stats, statsAnt) {
  const linhas = [
    { titulo: 'Contatos no período', atual: stats.total, ant: statsAnt.total },
    { titulo: 'Cliente entrou em contato', atual: stats.porIniciativa.cliente, ant: statsAnt.porIniciativa.cliente },
    { titulo: 'Eu entrei em contato', atual: stats.porIniciativa.eu, ant: statsAnt.porIniciativa.eu },
    { titulo: 'Consultas/Acompa­nhamentos agendados', atual: stats.consultasEAcompanhamentos, ant: statsAnt.consultasEAcompanhamentos },
    { titulo: 'Cirurgias agendadas', atual: stats.cirurgias, ant: statsAnt.cirurgias },
    { titulo: 'Não agendaram', atual: stats.naoAgendados, ant: statsAnt.naoAgendados },
    { titulo: 'Desmarcaram', atual: stats.desmarques, ant: statsAnt.desmarques }
  ];
  document.getElementById('relatorio-cards').innerHTML = linhas.map(l => `
    <div class="card">
      <h3>${l.titulo}</h3>
      <div class="num">${l.atual}</div>
      ${selinhoVariacao(l.atual, l.ant)}
    </div>
  `).join('');
}

// Mostra o resumo por motivo (Sem Deslocamento, Sem Interesse etc.) e, abaixo,
// as observações que ela escreveu em cada desmarque/não agendou — pra não
// precisar caçar na tabela de Agendamentos pra lembrar o que anotou
function renderMotivosRelatorio(stats) {
  relatorioStatsAtual = stats;
  const cont = document.getElementById('relatorio-motivos');
  if (stats.desmarques + stats.naoAgendados === 0) {
    cont.innerHTML = '<div class="sub">Nenhum desmarque ou não agendamento neste período.</div>';
    return;
  }

  const motivosComValor = Object.entries(stats.porMotivo).filter(([,v]) => v > 0);
  const htmlResumo = motivosComValor.length
    ? `<div class="relatorio-motivos-resumo">${motivosComValor.map(([m,v]) => `<div class="linha"><span>${escapeHtml(m)}</span><b>${v}</b></div>`).join('')}</div>`
    : '';

  // filtro por tipo (Consulta/Acompanhamento/Cirurgia...) só na lista de
  // observações escritas, pra ela achar rápido "o que foi desmarcado" sem
  // precisar ler item por item quando tem muita gente no período
  const tiposComValor = state.categorias.tipos.filter(t => stats.motivosDetalhados.some(d => d.tipo === t));
  const htmlFiltro = tiposComValor.length > 1
    ? `<div class="relatorio-motivos-filtro no-imprimir">
        <button type="button" class="motivo-filtro-chip${relatorioMotivoFiltroTipo === 'todos' ? ' ativo' : ''}" data-tipo="todos">Todos</button>
        ${tiposComValor.map(t => `<button type="button" class="motivo-filtro-chip${relatorioMotivoFiltroTipo === t ? ' ativo' : ''}" data-tipo="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>`
    : '';

  const listaFiltrada = relatorioMotivoFiltroTipo === 'todos'
    ? stats.motivosDetalhados
    : stats.motivosDetalhados.filter(d => d.tipo === relatorioMotivoFiltroTipo);

  const htmlDetalhes = listaFiltrada.length
    ? `<div class="relatorio-motivos-lista">${listaFiltrada.map(d => `
        <div class="relatorio-motivo-item">
          <div class="relatorio-motivo-cabeca">
            <b>${escapeHtml(d.nome || '(sem nome)')}</b>
            <span>${telefoneClicavel(d.telefone)}</span>
            <span class="delta ${d.status === 'Desmarcou' ? 'delta-queda' : 'delta-igual'}">${d.tipo ? escapeHtml(d.tipo) + ' · ' : ''}${escapeHtml(d.status)}${d.motivo ? ' · ' + escapeHtml(d.motivo) : ''}</span>
          </div>
          <p>${escapeHtml(d.detalhe)}</p>
        </div>
      `).join('')}</div>`
    : (stats.motivosDetalhados.length
        ? '<div class="sub">Nenhuma observação escrita neste período para esse tipo.</div>'
        : '<div class="sub">Nenhuma observação escrita neste período.</div>');

  cont.innerHTML = htmlResumo + htmlFiltro + htmlDetalhes;
}

// monta uma lista natural tipo "Sem Deslocamento e Sem Interesse" ou
// "Sem Deslocamento, Sem Interesse e Sem Resposta" com os motivos mais
// frequentes do período (até 3, do maior pro menor) — pro resumo também
// falar o "porquê" dos desmarques/não agendamentos, não só o número
function listaMotivosNatural(porMotivo) {
  const ordenados = Object.entries(porMotivo).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!ordenados.length) return '';
  const nomes = ordenados.slice(0, 3).map(([m]) => m);
  if (nomes.length === 1) return nomes[0];
  if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]}`;
  return `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
}

function montarTextoRelatorio(stats, statsAnt, emAnterior, aAnterior) {
  const paragrafos = [];

  paragrafos.push(comVariacao(
    `Teve ${stats.total} ${stats.total === 1 ? 'contato' : 'contatos'} no total, sendo ${stats.porIniciativa.cliente} que vieram do próprio cliente e ${stats.porIniciativa.eu} que partiram de nós`,
    stats.total, statsAnt.total, emAnterior, aAnterior
  ));

  if (stats.consultasEAcompanhamentos + stats.cirurgias + statsAnt.consultasEAcompanhamentos + statsAnt.cirurgias > 0) {
    const fraseConsultas = comVariacao(`Entre consultas e acompanhamentos, foram agendados ${stats.consultasEAcompanhamentos}`, stats.consultasEAcompanhamentos, statsAnt.consultasEAcompanhamentos, emAnterior, aAnterior);
    const fraseCirurgias = comVariacao(`Já as cirurgias somaram ${stats.cirurgias}`, stats.cirurgias, statsAnt.cirurgias, emAnterior, aAnterior);
    paragrafos.push(`${fraseConsultas} ${fraseCirurgias}`);
  } else {
    paragrafos.push('Nenhuma consulta, acompanhamento ou cirurgia foi agendada neste período.');
  }

  if (stats.naoAgendados > 0 || stats.desmarques > 0) {
    const fraseNaoAgendou = comVariacao(
      stats.naoAgendados === 1 ? 'Já 1 contato não agendou' : `Já ${stats.naoAgendados} contatos não agendaram`,
      stats.naoAgendados, statsAnt.naoAgendados, emAnterior, aAnterior
    );
    const fraseDesmarcou = comVariacao(
      stats.desmarques === 1 ? '1 contato desmarcou o atendimento' : `${stats.desmarques} contatos desmarcaram o atendimento`,
      stats.desmarques, statsAnt.desmarques, emAnterior, aAnterior
    );
    let texto = `${fraseNaoAgendou} ${fraseDesmarcou}`;

    const motivos = listaMotivosNatural(stats.porMotivo);
    if (motivos) texto += ` Os principais motivos foram ${motivos}.`;

    paragrafos.push(texto);
  } else {
    paragrafos.push('Ninguém deixou de agendar nem desmarcou atendimento neste período.');
  }

  return paragrafos;
}

// Quantos meses entram lado a lado na tabela de exportação do PDF
const MESES_TABELA_EXPORTAR = 6;

// Tabela resumida só de números, usada exclusivamente no PDF exportado (fica
// escondida na tela normal, ver CSS) — mostra os últimos 6 meses lado a lado
// em vez de comparar só com o mês anterior, pra dar pra ver a evolução de
// cada número com o tempo numa folha só, sem cartão nem texto corrido
function renderTabelaExportar(mesReferencia) {
  const cont = document.getElementById('relatorio-tabela-exportar');
  if (!cont) return;

  const meses = [];
  for (let i = MESES_TABELA_EXPORTAR - 1; i >= 0; i--) {
    const d = new Date(mesReferencia.getFullYear(), mesReferencia.getMonth() - i, 1);
    meses.push(d);
  }
  const statsPorMes = meses.map(d => statsDoMes(mesKeyDe(d)));

  const motivosComValor = state.categorias.motivos.filter(m => statsPorMes.some(s => (s.porMotivo[m] || 0) > 0));

  const linhasPrincipais = [
    { titulo: 'Total de contatos', valor: s => s.total },
    { titulo: 'Total de agendamentos', valor: s => s.consultasEAcompanhamentos + s.cirurgias },
    { titulo: 'Consultas e acompanhamentos', valor: s => s.consultasEAcompanhamentos },
    { titulo: 'Cirurgias', valor: s => s.cirurgias },
    { titulo: 'Desmarques', valor: s => s.desmarques },
    { titulo: 'Não agendamentos', valor: s => s.naoAgendados }
  ];

  const cabecalho = `<tr><th>Indicador</th>${meses.map(d => `<th>${MESES_ABREV[d.getMonth()]}/${String(d.getFullYear()).slice(2)}</th>`).join('')}</tr>`;

  const linhaHtml = l => `<tr><td>${escapeHtml(l.titulo)}</td>${statsPorMes.map(s => `<td>${l.valor(s)}</td>`).join('')}</tr>`;

  const corpoPrincipal = linhasPrincipais.map(linhaHtml).join('');
  const corpoMotivos = motivosComValor.length
    ? `<tr class="linha-grupo"><td colspan="${meses.length + 1}">Motivos de desmarque/não agendamento</td></tr>` +
      motivosComValor.map(m => linhaHtml({ titulo: m, valor: s => s.porMotivo[m] || 0 })).join('')
    : '';

  cont.innerHTML = `<table class="tabela-exportar-pdf"><thead>${cabecalho}</thead><tbody>${corpoPrincipal}${corpoMotivos}</tbody></table>`;
}

function renderRelatorios() {
  document.getElementById('relatorio-modo-mensal').classList.toggle('ativo', relatorioModo === 'mensal');
  document.getElementById('relatorio-modo-semanal').classList.toggle('ativo', relatorioModo === 'semanal');
  document.getElementById('relatorio-nav-mensal').hidden = relatorioModo !== 'mensal';
  document.getElementById('relatorio-nav-semanal').hidden = relatorioModo !== 'semanal';

  let stats, statsAnt, tituloRelatorio, emAnterior, aAnterior, chaveObs, mesReferenciaExportar;

  if (relatorioModo === 'mensal') {
    const mesKey = mesKeyDe(relatorioMesData);
    const dataMesAnterior = new Date(relatorioMesData);
    dataMesAnterior.setMonth(dataMesAnterior.getMonth() - 1);
    stats = statsDoMes(mesKey);
    statsAnt = statsDoMes(mesKeyDe(dataMesAnterior));
    tituloRelatorio = 'Relatório mensal — ' + rotuloMes(relatorioMesData);
    const nomeMesAnterior = MESES[dataMesAnterior.getMonth()].toLowerCase();
    emAnterior = 'em ' + nomeMesAnterior;
    aAnterior = 'a ' + nomeMesAnterior;
    chaveObs = 'm-' + mesKey;
    mesReferenciaExportar = relatorioMesData;
    document.getElementById('relatorio-mes-rotulo').textContent = rotuloMes(relatorioMesData);
  } else {
    const inicio = relatorioSemanaInicio;
    const fim = fimSemanaDe(inicio);
    const inicioAnt = new Date(inicio); inicioAnt.setDate(inicioAnt.getDate() - 7);
    const fimAnt = new Date(fim); fimAnt.setDate(fimAnt.getDate() - 7);
    stats = statsDoPeriodo(strDeDate(inicio), strDeDate(fim));
    statsAnt = statsDoPeriodo(strDeDate(inicioAnt), strDeDate(fimAnt));
    const rotuloSemana = formatarData(strDeDate(inicio)) + ' a ' + formatarData(strDeDate(fim));
    tituloRelatorio = 'Relatório semanal — ' + rotuloSemana;
    emAnterior = 'na semana anterior';
    aAnterior = 'à semana anterior';
    chaveObs = 's-' + strDeDate(inicio);
    mesReferenciaExportar = inicio;
    document.getElementById('relatorio-semana-rotulo').textContent = rotuloSemana;
  }

  document.getElementById('relatorio-titulo').textContent = tituloRelatorio;
  renderCardsRelatorio(stats, statsAnt);
  document.getElementById('relatorio-texto').innerHTML = montarTextoRelatorio(stats, statsAnt, emAnterior, aAnterior).map(p => `<p>${escapeHtml(p)}</p>`).join('');
  // o filtro por tipo da lista de motivos volta pra "Todos" sozinho só quando
  // o período realmente muda (não a cada atualização do Firestore) — senão
  // ela ia ver o filtro sumir do nada enquanto só tava olhando a lista
  if (chaveObs !== relatorioMotivoFiltroPeriodoKey) {
    relatorioMotivoFiltroTipo = 'todos';
    relatorioMotivoFiltroPeriodoKey = chaveObs;
  }
  renderMotivosRelatorio(stats);
  renderTabelaExportar(mesReferenciaExportar);

  const obsCfg = obsDoPeriodo(chaveObs);
  const campoObs = document.getElementById('relatorio-obs');
  campoObs.value = obsCfg.texto;
  campoObs.dataset.chave = chaveObs;
  aplicarEstiloObs(obsCfg);
  document.getElementById('relatorio-obs-status').textContent = '';
}

// ============================================================
// ABA NOTAS FISCAIS
// ============================================================
document.getElementById('nf-mes-anterior').addEventListener('click', () => { nfCurrentDate.setMonth(nfCurrentDate.getMonth()-1); renderNotas(); });
document.getElementById('nf-mes-proximo').addEventListener('click', () => { nfCurrentDate.setMonth(nfCurrentDate.getMonth()+1); renderNotas(); });
document.getElementById('nf-mes-hoje').addEventListener('click', () => { nfCurrentDate = new Date(); renderNotas(); });

function entriesNfDoMes(mesKey) {
  return state.nfEntries.filter(e => mesDe(e.dataPagamento) === mesKey);
}

// Filtro rápido "Últimos 7 dias" pra Notas Fiscais, mesma ideia do atalho
// equivalente em Agendamentos: ignora o mês selecionado e olha os últimos
// 7 dias corridos (hoje incluso) pela data de pagamento
function entriesNfUltimos7Dias() {
  const hoje = new Date();
  const limite = new Date(hoje);
  limite.setDate(limite.getDate() - 6);
  const hojeStrVal = hojeStr();
  const limiteStr = limite.getFullYear() + '-' + pad2(limite.getMonth()+1) + '-' + pad2(limite.getDate());
  return state.nfEntries.filter(e => {
    const data = e.dataPagamento || '';
    return !!data && data >= limiteStr && data <= hojeStrVal;
  });
}

// Período customizado "do dia tal até dia tal" — qualquer uma das duas
// pontas pode ficar em aberto (só "a partir de" ou só "até")
function entriesNfPeriodoCustom(dataInicio, dataFim) {
  if (!dataInicio && !dataFim) return [];
  return state.nfEntries.filter(e => {
    const data = e.dataPagamento || '';
    if (!data) return false;
    if (dataInicio && data < dataInicio) return false;
    if (dataFim && data > dataFim) return false;
    return true;
  });
}

// Lista base da tabela de Notas Fiscais: por mês normalmente, ou um dos
// atalhos de período (últimos 7 dias / intervalo customizado) quando ativos
function listaBaseNf(mesKey) {
  if (nfFiltros.periodo === '7dias') return entriesNfUltimos7Dias();
  if (nfFiltros.periodo === 'custom') return entriesNfPeriodoCustom(nfFiltros.dataInicio, nfFiltros.dataFim);
  return entriesNfDoMes(mesKey);
}

function formatarMoeda(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- Máscara de valor em reais: digita só números, o campo já mostra
// "20.800,60" sozinho (igual digitar numa calculadora) — sem precisar digitar
// vírgula nem ponto na mão ----
function maskMoeda(v) {
  let digitos = (v || '').toString().replace(/\D/g, '');
  digitos = digitos.replace(/^0+(?=\d)/, '');
  if (!digitos) return '';
  while (digitos.length < 3) digitos = '0' + digitos;
  const inteiro = digitos.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const centavos = digitos.slice(-2);
  return inteiro + ',' + centavos;
}
function moedaParaNumero(str) {
  if (!str) return 0;
  const limpo = str.toString().replace(/\./g, '').replace(',', '.');
  return Number(limpo) || 0;
}
// pra preencher um campo com máscara a partir de um número já salvo (ex: 150.5 -> "150,50")
function formatarMoedaInput(numero) {
  const n = Number(numero) || 0;
  return maskMoeda(Math.round(n * 100).toString());
}
function ativarMascaraMoeda(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => { el.value = maskMoeda(el.value); });
}

function renderNotas() {
  document.getElementById('nf-mes-rotulo').textContent = rotuloMes(nfCurrentDate);
  const mesKey = mesKeyDe(nfCurrentDate);
  renderNfCards(mesKey);
  renderTabelaNf(mesKey);
}

function renderNfCards(mesKey) {
  const cont = document.getElementById('nf-cards-resumo');
  const lista = entriesNfDoMes(mesKey);
  const totalNaNota = lista.reduce((s,e) => s + (Number(e.valorNota)||0), 0);
  const pendentes = lista.filter(e => !e.feito).length;
  const feitos = lista.filter(e => e.feito).length;
  cont.innerHTML = `
    <div class="card">
      <h3>Lançamentos no mês</h3>
      <div class="num">${lista.length}</div>
    </div>
    <div class="card">
      <h3>Total cobrado menos splits</h3>
      <div class="num">R$ ${formatarMoeda(totalNaNota)}</div>
      <div class="sub">valor que vai na nota fiscal</div>
    </div>
    <div class="card">
      <h3>Notas pendentes</h3>
      <div class="num">${pendentes}</div>
      <div class="sub">ainda não emitidas</div>
    </div>
    <div class="card">
      <h3>Notas feitas</h3>
      <div class="num">${feitos}</div>
      <div class="sub">já emitidas neste mês</div>
    </div>
  `;
}

// ---------- Filtros da tabela de NF ----------
['nf-filtro-busca','nf-filtro-cidade','nf-filtro-nota'].forEach(id => {
  ['input','change'].forEach(evento => {
    document.getElementById(id).addEventListener(evento, () => {
      nfFiltros.busca = normalizarTexto(document.getElementById('nf-filtro-busca').value.trim());
      nfFiltros.cidade = document.getElementById('nf-filtro-cidade').value;
      nfFiltros.querNf = document.getElementById('nf-filtro-nota').value;
      renderTabelaNf(mesKeyDe(nfCurrentDate));
    });
  });
});
// Campo de busca se limpa sozinho ao clicar fora (mesmo atraso usado nos
// outros campos de busca, pra não atrapalhar um clique em Editar na linha filtrada)
document.getElementById('nf-filtro-busca').addEventListener('blur', () => {
  setTimeout(() => {
    const el = document.getElementById('nf-filtro-busca');
    if (!el.value) return;
    el.value = '';
    nfFiltros.busca = '';
    renderTabelaNf(mesKeyDe(nfCurrentDate));
  }, 200);
});

// Atalho "Últimos 7 dias" e período customizado (do dia tal até dia tal)
// pra Notas Fiscais — os dois são mutuamente exclusivos entre si e com o mês
// selecionado; escolher um limpa o outro
function atualizarUiPeriodoNf() {
  document.getElementById('nf-btn-filtro-7dias').classList.toggle('ativo', nfFiltros.periodo === '7dias');
  document.getElementById('nf-btn-limpar-periodo').hidden = !nfFiltros.periodo;
}
document.getElementById('nf-btn-filtro-7dias').addEventListener('click', () => {
  nfFiltros.periodo = nfFiltros.periodo === '7dias' ? '' : '7dias';
  nfFiltros.dataInicio = '';
  nfFiltros.dataFim = '';
  document.getElementById('nf-filtro-data-inicio').value = '';
  document.getElementById('nf-filtro-data-fim').value = '';
  atualizarUiPeriodoNf();
  renderTabelaNf(mesKeyDe(nfCurrentDate));
});
['nf-filtro-data-inicio', 'nf-filtro-data-fim'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    nfFiltros.dataInicio = document.getElementById('nf-filtro-data-inicio').value;
    nfFiltros.dataFim = document.getElementById('nf-filtro-data-fim').value;
    nfFiltros.periodo = (nfFiltros.dataInicio || nfFiltros.dataFim) ? 'custom' : '';
    atualizarUiPeriodoNf();
    renderTabelaNf(mesKeyDe(nfCurrentDate));
  });
});
document.getElementById('nf-btn-limpar-periodo').addEventListener('click', () => {
  nfFiltros.periodo = '';
  nfFiltros.dataInicio = '';
  nfFiltros.dataFim = '';
  document.getElementById('nf-filtro-data-inicio').value = '';
  document.getElementById('nf-filtro-data-fim').value = '';
  atualizarUiPeriodoNf();
  renderTabelaNf(mesKeyDe(nfCurrentDate));
});

// Monta a linha de um lançamento — usada nas duas tabelonas (feitas/pendentes)
function linhaNf(e) {
  const servicosTxt = (e.servicos||[]).join(', ');
  const duplicata = nfDuplicataPendente(e);
  return `
    <tr data-id="${e.id}" class="${duplicata ? 'linha-duplicada-nf' : ''}">
      <td><span class="avatar-mini">${escapeHtml(iniciais(e.cliente))}</span>${escapeHtml(e.cliente||'')}${duplicata ? '<span class="aviso-duplicada-nf" title="Este cliente tem outro lançamento pendente">⚠ outra nota pendente</span>' : ''}</td>
      <td>${escapeHtml(e.animal||'')}</td>
      <td>${telefoneClicavel(e.telefone)}</td>
      <td>${escapeHtml(e.cidade||'')}</td>
      <td>${escapeHtml(servicosTxt || '—')}</td>
      <td>${formatarData(e.dataPagamento)}</td>
      <td>${escapeHtml(e.pagamento||'')}</td>
      <td>R$ ${formatarMoeda(e.cobrado)}</td>
      <td>R$ ${formatarMoeda(e.valorNota)}</td>
      <td><button type="button" class="pill-toggle pill ${e.querNf ? 'enviar' : 'naoenviar'} btn-toggle-quernf" title="Clique pra marcar ${e.querNf ? 'pra não enviar' : 'pra enviar'}">${e.querNf ? 'Enviar' : 'Não enviar'}</button></td>
      <td><button type="button" class="pill-toggle pill ${e.feito ? 'feito' : 'pendente'} btn-toggle-feito" title="Clique pra marcar ${e.feito ? 'como pendente' : 'como feito'}">${e.feito ? '✓ Feito' : 'Pendente'}</button></td>
      <td class="acoes">${duplicata ? `<button type="button" class="btn marrom sm btn-unir-nf" data-duplicata="${duplicata.id}" title="Somar este lançamento com o outro pendente deste cliente">🔗 Unir notas</button>` : ''}<button class="btn outline sm btn-editar-nf">Editar</button></td>
    </tr>
  `;
}

function renderGrupoNf(idCorpo, idVazio, lista) {
  const corpo = document.getElementById(idCorpo);
  if (!corpo) return;
  document.getElementById(idVazio).hidden = lista.length !== 0;
  corpo.innerHTML = lista.map(linhaNf).join('');
  corpo.querySelectorAll('.btn-toggle-feito').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      nfToggleFeito(state.nfEntries.find(e => e.id === id));
    });
  });
  corpo.querySelectorAll('.btn-toggle-quernf').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      nfToggleQuerNf(state.nfEntries.find(e => e.id === id));
    });
  });
  corpo.querySelectorAll('.btn-editar-nf').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      abrirModalNf(state.nfEntries.find(e => e.id === id));
    });
  });
  corpo.querySelectorAll('.btn-unir-nf').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      const outroId = btn.dataset.duplicata;
      unirNfsPendentes(state.nfEntries.find(e => e.id === id), state.nfEntries.find(e => e.id === outroId));
    });
  });
}

// Duas tabelonas separadas (feitas / pendentes) pra não misturar visualmente —
// o mesmo lançamento aparece numa ou noutra dependendo só do campo "feito"
function renderTabelaNf(mesKey) {
  let lista = listaBaseNf(mesKey);
  if (nfFiltros.cidade) lista = lista.filter(e => e.cidade === nfFiltros.cidade);
  if (nfFiltros.querNf === 'sim') lista = lista.filter(e => !!e.querNf);
  if (nfFiltros.querNf === 'nao') lista = lista.filter(e => !e.querNf);
  if (nfFiltros.busca) {
    const q = nfFiltros.busca;
    const qDigitos = q.replace(/\D/g, '');
    lista = lista.filter(e =>
      normalizarTexto(e.cliente).includes(q) ||
      normalizarTexto(e.animal).includes(q) ||
      normalizarTexto(e.telefone).includes(q) ||
      normalizarTexto(e.nomeNf).includes(q) ||
      normalizarTexto(e.cpf).includes(q) ||
      (qDigitos.length >= 3 && normalizarTelefone(e.telefone).includes(qDigitos))
    );
  }
  lista = lista.slice().sort((a,b) => {
    const da = a.dataPagamento || '', db_ = b.dataPagamento || '';
    if (da !== db_) return da < db_ ? 1 : -1;
    return (b.criadoEm||'').localeCompare(a.criadoEm||'');
  });

  const pendentes = lista.filter(e => !e.feito);
  const feitas = lista.filter(e => e.feito);
  renderGrupoNf('nf-tabela-pendentes-corpo', 'nf-tabela-pendentes-vazia', pendentes);
  renderGrupoNf('nf-tabela-feitas-corpo', 'nf-tabela-feitas-vazia', feitas);
  document.getElementById('nf-contagem-pendentes').textContent = pendentes.length;
  document.getElementById('nf-contagem-feitas').textContent = feitas.length;
}

// ---------- Modal: novo/editar lançamento de NF ----------
let nfServicosSelecionados = [];

document.getElementById('nf-btn-novo').addEventListener('click', () => abrirModalNf(null));
document.getElementById('fechar-modal-nf').addEventListener('click', fecharModalNf);
document.getElementById('btn-cancelar-nf').addEventListener('click', fecharModalNf);

function abrirModalNf(entry) {
  popularSelects();
  editingNfId = entry ? entry.id : null;
  cepUltimaBusca = '';
  document.getElementById('nf-titulo').textContent = entry ? 'Editar lançamento' : 'Novo lançamento';
  document.getElementById('btn-excluir-nf').hidden = !entry;

  document.getElementById('nf-f-telefone').value = entry ? entry.telefone||'' : '';
  document.getElementById('nf-f-animal').value = entry ? entry.animal||'' : '';
  document.getElementById('nf-f-cliente').value = entry ? entry.cliente||'' : '';
  document.getElementById('nf-f-cidade').value = entry ? entry.cidade||'' : (state.categorias.cidades[0]||'');
  document.getElementById('nf-f-datapagamento').value = entry ? entry.dataPagamento||'' : hojeStr();
  document.getElementById('nf-f-cobrado').value = entry && entry.cobrado ? formatarMoedaInput(entry.cobrado) : '';
  document.getElementById('nf-f-splits').value = entry && entry.splits ? formatarMoedaInput(entry.splits) : '';
  document.getElementById('nf-f-pagamento').value = entry ? entry.pagamento||'PIX' : 'PIX';
  // a maioria dos clientes não pede nota — então por padrão vem desmarcado,
  // ela só liga quando o cliente realmente pedir
  document.getElementById('nf-f-quer-nf').checked = entry ? !!entry.querNf : false;
  document.getElementById('nf-f-nome').value = entry ? entry.nomeNf||'' : '';
  document.getElementById('nf-f-cpf').value = entry ? entry.cpf||'' : '';
  document.getElementById('nf-f-cep').value = entry ? entry.cep||'' : '';
  document.getElementById('nf-f-numero').value = entry ? entry.numero||'' : '';
  document.getElementById('nf-f-rua').value = entry ? entry.rua||'' : '';
  document.getElementById('nf-f-bairro').value = entry ? entry.bairro||'' : '';
  document.getElementById('nf-f-complemento').value = entry ? entry.complemento||'' : '';
  document.getElementById('nf-f-cidade-end').value = entry ? entry.cidadeEndereco||'' : '';
  document.getElementById('nf-f-estado').value = entry ? entry.estado||'' : '';
  document.getElementById('nf-f-email').value = entry ? entry.email||'' : '';
  document.getElementById('nf-f-obs').value = entry ? entry.obs||'' : '';
  document.getElementById('nf-f-feito').checked = entry ? !!entry.feito : false;
  document.getElementById('nf-campo-dataemissao').hidden = !(entry && entry.dataNF);
  document.getElementById('nf-f-dataemissao').value = entry && entry.dataNF ? formatarData(entry.dataNF) : '';

  nfServicosSelecionados = entry && Array.isArray(entry.servicos) ? entry.servicos.slice() : [];
  // em edição, o nome já foi definido/conferido antes — não sobrescreve mais
  // o que ela digitar em "Cliente"; num lançamento novo, continua copiando
  nfNomeSincronizado = !entry;
  nfChipsRender();
  nfAtualizarValorNota();
  nfAtualizarVisibilidadeDadosNf();
  atualizarPainelHistoricoNf();

  abrirOverlay('modal-nf');
  document.getElementById('modal-nf').scrollTop = 0;
}
function fecharModalNf() {
  fecharOverlay('modal-nf');
  document.getElementById('historico-nf').hidden = true;
}

function nfChipsRender() {
  const cont = document.getElementById('nf-chips-servico');
  const salvos = state.nf.servicosSalvos || [];
  cont.innerHTML = salvos.length
    ? salvos.map(s => `<button type="button" class="chip-servico ${nfServicosSelecionados.includes(s) ? 'selecionado' : ''}" data-servico="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')
    : '<span class="sub">Nenhum serviço salvo ainda — adicione um abaixo</span>';
  cont.querySelectorAll('.chip-servico').forEach(chip => {
    chip.addEventListener('click', () => {
      const s = chip.dataset.servico;
      const i = nfServicosSelecionados.indexOf(s);
      if (i === -1) nfServicosSelecionados.push(s); else nfServicosSelecionados.splice(i,1);
      nfChipsRender();
    });
  });
}

document.getElementById('nf-btn-add-servico').addEventListener('click', () => {
  const input = document.getElementById('nf-novo-servico');
  const valor = input.value.trim();
  if (!valor) return;
  if ((state.nf.servicosSalvos||[]).includes(valor)) {
    if (!nfServicosSelecionados.includes(valor)) nfServicosSelecionados.push(valor);
    input.value = '';
    nfChipsRender();
    return;
  }
  input.disabled = true;
  adicionarServico(valor).then(() => {
    if (!state.nf.servicosSalvos.includes(valor)) state.nf.servicosSalvos.push(valor);
    if (!nfServicosSelecionados.includes(valor)) nfServicosSelecionados.push(valor);
    input.value = '';
    nfChipsRender();
  }).catch(err => mostrarToast('Não foi possível adicionar o serviço: ' + err.message))
    .finally(() => { input.disabled = false; });
});

function nfAtualizarValorNota() {
  const cobrado = moedaParaNumero(document.getElementById('nf-f-cobrado').value);
  const splits = moedaParaNumero(document.getElementById('nf-f-splits').value);
  const valor = Math.max(0, cobrado - splits);
  document.getElementById('nf-f-valornota').value = formatarMoeda(valor);
}
ativarMascaraMoeda('nf-f-cobrado');
ativarMascaraMoeda('nf-f-splits');
document.getElementById('nf-f-cobrado').addEventListener('input', nfAtualizarValorNota);
document.getElementById('nf-f-splits').addEventListener('input', nfAtualizarValorNota);

// Os dados da nota são sempre coletados (a clínica emite nota mesmo quando o
// cliente não pede) — "Enviar nota ao cliente" só controla se ela marca pra
// mandar ou não, sem esconder nenhum campo. "Feito" só aparece quando o
// lançamento já existe (não faz sentido perguntar isso ao criar um lançamento
// novo, ainda nem foi emitida).
function nfAtualizarVisibilidadeDadosNf() {
  document.getElementById('nf-campo-feito').hidden = !editingNfId;
}

// Enquanto ela não mexer manualmente no "Nome completo (NF)", ele acompanha o
// que for digitado em "Cliente" — pra não ter que escrever o nome duas vezes
document.getElementById('nf-f-cliente').addEventListener('input', () => {
  if (nfNomeSincronizado) document.getElementById('nf-f-nome').value = document.getElementById('nf-f-cliente').value;
});
document.getElementById('nf-f-nome').addEventListener('input', () => { nfNomeSincronizado = false; });

// ---- Máscaras simples de CPF/CEP (só formata, não valida dígito verificador) ----
function maskCpf(v) {
  v = v.replace(/\D/g, '').slice(0, 11);
  v = v.replace(/(\d{3})(\d)/, '$1.$2');
  v = v.replace(/(\d{3})(\d)/, '$1.$2');
  v = v.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  return v;
}
document.getElementById('nf-f-cpf').addEventListener('input', ev => { ev.target.value = maskCpf(ev.target.value); });

function maskCep(v) {
  v = v.replace(/\D/g, '').slice(0, 8);
  v = v.replace(/(\d{5})(\d)/, '$1-$2');
  return v;
}
document.getElementById('nf-f-estado').addEventListener('input', ev => { ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2); });

// Busca o endereço automaticamente pelo CEP (ViaCEP) — se não tiver internet ou
// o CEP for inválido, simplesmente não preenche nada; ela completa na mão.
// Dispara assim que completar os 8 dígitos (sem precisar sair do campo) e
// também ao sair do campo, caso ela cole o CEP já completo.
let cepUltimaBusca = '';
function buscarEnderecoPorCep(cep) {
  if (cep.length !== 8 || cep === cepUltimaBusca) return;
  cepUltimaBusca = cep;
  fetch(`https://viacep.com.br/ws/${cep}/json/`)
    .then(r => r.json())
    .then(d => {
      if (d.erro) { mostrarToast('CEP não encontrado'); return; }
      if (d.logradouro && !document.getElementById('nf-f-rua').value.trim()) document.getElementById('nf-f-rua').value = d.logradouro;
      if (d.bairro && !document.getElementById('nf-f-bairro').value.trim()) document.getElementById('nf-f-bairro').value = d.bairro;
      if (d.localidade && !document.getElementById('nf-f-cidade-end').value.trim()) document.getElementById('nf-f-cidade-end').value = d.localidade;
      if (d.uf && !document.getElementById('nf-f-estado').value.trim()) document.getElementById('nf-f-estado').value = d.uf;
    })
    .catch(() => { /* sem internet — segue sem preencher automaticamente */ });
}
document.getElementById('nf-f-cep').addEventListener('input', ev => {
  ev.target.value = maskCep(ev.target.value);
  const cep = ev.target.value.replace(/\D/g, '');
  if (cep.length < 8) cepUltimaBusca = '';
  buscarEnderecoPorCep(cep);
});
document.getElementById('nf-f-cep').addEventListener('blur', () => {
  buscarEnderecoPorCep(document.getElementById('nf-f-cep').value.replace(/\D/g, ''));
});

// Puxa os dados de um lançamento anterior da mesma pessoa, pelo telefone ou
// CPF, pra ela não precisar redigitar os dados de quem já lançou nota antes
function buscarNfPorContato(telefone, cpf) {
  const telNorm = normalizarTelefone(telefone);
  const cpfNorm = (cpf || '').replace(/\D/g, '');
  const candidatos = state.nfEntries.filter(e => {
    if (editingNfId && e.id === editingNfId) return false;
    const eTel = normalizarTelefone(e.telefone);
    const eCpf = (e.cpf || '').replace(/\D/g, '');
    return (telNorm.length >= 8 && eTel === telNorm) || (cpfNorm.length === 11 && eCpf === cpfNorm);
  });
  if (!candidatos.length) return null;
  return candidatos.slice().sort((a,b) => (b.criadoEm||'').localeCompare(a.criadoEm||''))[0];
}

function autopreencherNf() {
  if (editingNfId) return; // só ajuda em lançamento novo, não mexe em edição
  const telefone = document.getElementById('nf-f-telefone').value;
  const cpf = document.getElementById('nf-f-cpf').value;
  const achado = buscarNfPorContato(telefone, cpf);

  // A maioria dos clientes já existe em Agendamentos antes de nunca ter
  // lançado uma nota fiscal (ela marca a consulta primeiro, a nota vem
  // depois) — então só olhar lançamentos de NF anteriores (achado acima)
  // deixa a 1ª nota de cada cliente sem preencher nada. Complementa com o
  // cadastro de Agendamentos pra pelo menos nome/animal/cidade virem
  // prontos (endereço/CPF/e-mail só existem mesmo em notas já lançadas).
  const historicoAgendamento = buscarHistorico(telefone, '');
  const ultimoAgendamento = historicoAgendamento.length ? ordenarPorDataRecente(historicoAgendamento)[0] : null;

  if (!achado && !ultimoAgendamento) return;

  if (!document.getElementById('nf-f-cliente').value.trim()) {
    document.getElementById('nf-f-cliente').value = (achado && achado.cliente) || (ultimoAgendamento && ultimoAgendamento.nome) || '';
  }
  if (!document.getElementById('nf-f-cidade').value) {
    document.getElementById('nf-f-cidade').value = (achado && achado.cidade) || (ultimoAgendamento && ultimoAgendamento.cidade) || '';
  }
  if (!document.getElementById('nf-f-animal').value.trim()) {
    document.getElementById('nf-f-animal').value = (achado && achado.animal) || (ultimoAgendamento && ultimoAgendamento.animal) || '';
  }
  if (!document.getElementById('nf-f-nome').value.trim() && achado) { document.getElementById('nf-f-nome').value = achado.nomeNf || ''; nfNomeSincronizado = false; }
  if (!document.getElementById('nf-f-cpf').value.trim() && achado) document.getElementById('nf-f-cpf').value = achado.cpf || '';
  if (!document.getElementById('nf-f-cep').value.trim() && achado) document.getElementById('nf-f-cep').value = achado.cep || '';
  if (!document.getElementById('nf-f-numero').value.trim() && achado) document.getElementById('nf-f-numero').value = achado.numero || '';
  if (!document.getElementById('nf-f-rua').value.trim() && achado) document.getElementById('nf-f-rua').value = achado.rua || '';
  if (!document.getElementById('nf-f-complemento').value.trim() && achado) document.getElementById('nf-f-complemento').value = achado.complemento || '';
  if (!document.getElementById('nf-f-bairro').value.trim() && achado) document.getElementById('nf-f-bairro').value = achado.bairro || '';
  if (!document.getElementById('nf-f-cidade-end').value.trim() && achado) document.getElementById('nf-f-cidade-end').value = achado.cidadeEndereco || '';
  if (!document.getElementById('nf-f-estado').value.trim() && achado) document.getElementById('nf-f-estado').value = achado.estado || '';
  if (!document.getElementById('nf-f-email').value.trim() && achado) document.getElementById('nf-f-email').value = achado.email || '';

  mostrarToast(achado ? 'Dados preenchidos a partir de um lançamento anterior' : 'Nome, animal e cidade preenchidos a partir de Agendamentos — falta só o endereço');
}
document.getElementById('nf-f-telefone').addEventListener('blur', autopreencherNf);
document.getElementById('nf-f-cpf').addEventListener('blur', autopreencherNf);
document.getElementById('nf-f-telefone').addEventListener('input', atualizarPainelHistoricoNf);

// Botões "copiar" ao lado dos campos de dados da nota fiscal
document.querySelectorAll('.btn-copiar').forEach(btn => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.campo);
    if (!el) return;
    const texto = el.value || '';
    if (!texto) { mostrarToast('Nada para copiar'); return; }
    navigator.clipboard.writeText(texto).then(() => mostrarToast('Copiado')).catch(() => mostrarToast('Não foi possível copiar'));
  });
});

document.getElementById('form-nf').addEventListener('submit', ev => {
  ev.preventDefault();
  const btnSalvar = ev.target.querySelector('button[type=submit]');
  const cobrado = moedaParaNumero(document.getElementById('nf-f-cobrado').value);
  const splits = moedaParaNumero(document.getElementById('nf-f-splits').value);
  const valorNota = Math.max(0, cobrado - splits);
  const querNf = document.getElementById('nf-f-quer-nf').checked;
  const anterior = editingNfId ? state.nfEntries.find(e => e.id === editingNfId) : null;
  const feito = document.getElementById('nf-f-feito').checked;
  // registra a data em que a nota foi marcada como feita; se desmarcar, limpa
  const dataNF = feito ? ((anterior && anterior.feito && anterior.dataNF) || hojeStr()) : '';

  const dados = {
    telefone: document.getElementById('nf-f-telefone').value.trim(),
    animal: document.getElementById('nf-f-animal').value.trim(),
    cliente: document.getElementById('nf-f-cliente').value.trim(),
    cidade: document.getElementById('nf-f-cidade').value,
    dataPagamento: document.getElementById('nf-f-datapagamento').value || hojeStr(),
    servicos: nfServicosSelecionados.slice(),
    cobrado, splits, valorNota,
    pagamento: document.getElementById('nf-f-pagamento').value,
    querNf,
    nomeNf: document.getElementById('nf-f-nome').value.trim(),
    cpf: document.getElementById('nf-f-cpf').value.trim(),
    cep: document.getElementById('nf-f-cep').value.trim(),
    numero: document.getElementById('nf-f-numero').value.trim(),
    rua: document.getElementById('nf-f-rua').value.trim(),
    complemento: document.getElementById('nf-f-complemento').value.trim(),
    bairro: document.getElementById('nf-f-bairro').value.trim(),
    cidadeEndereco: document.getElementById('nf-f-cidade-end').value.trim(),
    estado: document.getElementById('nf-f-estado').value.trim().toUpperCase(),
    email: document.getElementById('nf-f-email').value.trim(),
    obs: document.getElementById('nf-f-obs').value.trim(),
    feito,
    dataNF,
    criadoEm: (anterior && anterior.criadoEm) || new Date().toISOString()
  };

  btnSalvar.disabled = true;
  btnSalvar.textContent = 'Salvando...';
  const promessa = editingNfId ? atualizarNf(editingNfId, dados) : criarNf(dados);
  promessa.then(() => {
    mostrarToast('Lançamento salvo');
    fecharModalNf();
  }).catch(err => {
    mostrarToast('Não foi possível salvar: ' + err.message);
  }).finally(() => {
    btnSalvar.disabled = false;
    btnSalvar.textContent = 'Salvar';
  });
});

document.getElementById('btn-excluir-nf').addEventListener('click', () => {
  if (!editingNfId) return;
  if (!confirm('Excluir este lançamento? Essa ação não pode ser desfeita.')) return;
  excluirNf(editingNfId).then(() => {
    mostrarToast('Lançamento excluído');
    fecharModalNf();
  }).catch(err => mostrarToast('Não foi possível excluir: ' + err.message));
});

// ---------- Modal: gerenciar serviços salvos ----------
document.getElementById('nf-btn-servicos').addEventListener('click', () => {
  renderServicosLista();
  abrirOverlay('modal-servicos');
  document.getElementById('modal-servicos').scrollTop = 0;
});
document.getElementById('fechar-modal-servicos').addEventListener('click', () => {
  fecharOverlay('modal-servicos');
});

function renderServicosLista() {
  const cont = document.getElementById('servicos-lista');
  const lista = state.nf.servicosSalvos || [];
  cont.innerHTML = lista.length
    ? lista.map(v => `<span class="chip">${escapeHtml(v)}<button data-valor="${escapeHtml(v)}" class="btn-editar-servico" title="Renomear">&#9998;</button><button data-valor="${escapeHtml(v)}" class="btn-remover-servico" title="Excluir">&times;</button></span>`).join('')
    : '<span class="sub">Nenhum serviço salvo ainda</span>';
  cont.querySelectorAll('.btn-remover-servico').forEach(btn => {
    btn.addEventListener('click', () => {
      const valor = btn.dataset.valor;
      if (!confirm('Excluir o serviço "' + valor + '"?')) return;
      removerServico(valor).then(() => mostrarToast('Serviço removido')).catch(err => mostrarToast('Erro ao remover: ' + err.message));
    });
  });
  cont.querySelectorAll('.btn-editar-servico').forEach(btn => {
    btn.addEventListener('click', () => {
      const atual = btn.dataset.valor;
      const novo = (prompt('Renomear serviço:', atual) || '').trim();
      if (!novo || novo === atual) return;
      renomearServico(atual, novo).then(() => mostrarToast('Serviço renomeado')).catch(err => mostrarToast('Não foi possível renomear: ' + err.message));
    });
  });
}
document.getElementById('servicos-novo-btn').addEventListener('click', () => {
  const input = document.getElementById('servicos-novo-input');
  const valor = input.value.trim();
  if (!valor) return;
  if ((state.nf.servicosSalvos||[]).includes(valor)) { mostrarToast('Já existe'); return; }
  input.value = '';
  adicionarServico(valor).then(() => mostrarToast('Serviço adicionado')).catch(err => mostrarToast('Erro ao adicionar: ' + err.message));
});

// ============================================================
// PWA — atualizar / service worker
// ============================================================
document.getElementById('btn-atualizar').addEventListener('click', async () => {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  }
  location.reload(true);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
