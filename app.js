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
  linksUteis: []
};
let carregouDoc = false;
let carregouEntries = false;
let carregouNfDoc = false;
let carregouNfEntries = false;
let currentDate = new Date();          // controla mês/ano da aba Agendamentos
let nfCurrentDate = new Date();        // controla mês/ano da aba Notas Fiscais
let anoAnual = new Date().getFullYear(); // controla ano da aba Comparativo Anual
let editingEntryId = null;
let editingNfId = null;
let nfNomeSincronizado = true; // enquanto true, "Nome completo (NF)" copia o que for digitado em "Cliente"
let abaAtiva = 'inicio';
let filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '', motivo: '', periodo: '' };
let nfFiltros = { busca: '', cidade: '', querNf: '' };
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

// ---- Links úteis: botões de atalho que ela mesma cadastra na Visão Geral
// (ex: planilha, WhatsApp da clínica, site) — lista pequena, salva inteira ----
function salvarLinksUteis(lista) {
  return docRef.update({ linksUteis: lista });
}
function normalizarUrl(url) {
  url = (url || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

let editingLinkIdx = null;
// Os mesmos links aparecem nas duas abas (Agendamentos e Notas Fiscais) —
// cada uma tem seu próprio <div> de grade, mas é a mesma lista salva uma vez só
function renderLinksUteis() {
  const lista = state.linksUteis || [];
  [
    { grid: 'links-uteis-grid', vazio: 'links-uteis-vazio' },
    { grid: 'links-uteis-grid-nf', vazio: 'links-uteis-vazio-nf' }
  ].forEach(({ grid, vazio }) => {
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
      btn.addEventListener('click', () => abrirModalLink(Number(btn.dataset.idx)));
    });
    cont.querySelectorAll('.link-excluir').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        if (!confirm('Excluir este link?')) return;
        const nova = state.linksUteis.slice();
        nova.splice(idx, 1);
        salvarLinksUteis(nova).catch(err => mostrarToast('Não foi possível excluir: ' + err.message));
      });
    });
  });
}
function abrirModalLink(idx) {
  editingLinkIdx = (idx === null || idx === undefined) ? null : idx;
  const l = editingLinkIdx !== null ? state.linksUteis[editingLinkIdx] : null;
  document.getElementById('link-titulo').textContent = l ? 'Editar link' : 'Novo link';
  document.getElementById('link-f-nome').value = l ? l.nome||'' : '';
  document.getElementById('link-f-url').value = l ? l.url||'' : '';
  document.getElementById('btn-excluir-link').hidden = !l;
  document.getElementById('modal-link').hidden = false;
}
function fecharModalLink() { document.getElementById('modal-link').hidden = true; }
document.getElementById('btn-add-link').addEventListener('click', () => abrirModalLink(null));
document.getElementById('btn-add-link-nf').addEventListener('click', () => abrirModalLink(null));
document.getElementById('fechar-modal-link').addEventListener('click', fecharModalLink);
document.getElementById('btn-cancelar-link').addEventListener('click', fecharModalLink);
document.getElementById('form-link').addEventListener('submit', ev => {
  ev.preventDefault();
  const nome = document.getElementById('link-f-nome').value.trim();
  const url = normalizarUrl(document.getElementById('link-f-url').value);
  if (!nome || !url) return;
  const nova = (state.linksUteis||[]).slice();
  if (editingLinkIdx !== null) nova[editingLinkIdx] = { nome, url };
  else nova.push({ nome, url });
  salvarLinksUteis(nova).then(() => { mostrarToast('Link salvo'); fecharModalLink(); })
    .catch(err => mostrarToast('Não foi possível salvar: ' + err.message));
});
document.getElementById('btn-excluir-link').addEventListener('click', () => {
  if (editingLinkIdx === null) return;
  if (!confirm('Excluir este link?')) return;
  const nova = state.linksUteis.slice();
  nova.splice(editingLinkIdx, 1);
  salvarLinksUteis(nova).then(() => { mostrarToast('Link excluído'); fecharModalLink(); })
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
      fecharModalPesquisa();
      if (r.tipo === 'agendamento') {
        abaAtiva = 'agendamentos';
        renderAba();
        abrirModalEntry(r.entry);
      } else {
        abaAtiva = 'notas';
        renderAba();
        abrirModalNf(r.entry);
      }
    });
  });
}
function abrirModalPesquisa() {
  document.getElementById('modal-pesquisa').hidden = false;
  const input = document.getElementById('pesquisa-universal-input');
  input.value = '';
  renderResultadosPesquisa('');
  setTimeout(() => input.focus(), 50);
}
function fecharModalPesquisa() { document.getElementById('modal-pesquisa').hidden = true; }
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
    total: contatos.length, porTipo, porCidade, porClinica, porMotivo, porSemana,
    consultasEAcompanhamentos, cirurgias, desmarques, naoAgendados
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
    if (!document.getElementById('modal-servicos').hidden) renderServicosLista();
  }
}

// Contador vermelho na aba "Agendamentos": quantos "Aguardando" já passaram do
// dia marcado pra recontatar — aparece não importa em qual mês você esteja
// olhando, pra nunca esquecer que tem atrasado sem precisar ir atrás.
function atualizarBadgeAtrasados() {
  const badge = document.getElementById('badge-atrasados');
  if (!badge) return;
  const hoje = hojeStr();
  const atrasados = state.entries.filter(e => {
    if (e.status !== 'Aguardando') return false;
    const data = e.dataAgendamento || e.dataContato || '';
    return !!data && data < hoje;
  }).length;
  badge.textContent = atrasados;
  badge.hidden = atrasados === 0;
}

function renderAba() {
  document.getElementById('aba-inicio').hidden = abaAtiva !== 'inicio';
  document.getElementById('aba-agendamentos').hidden = abaAtiva !== 'agendamentos';
  document.getElementById('aba-metas').hidden = abaAtiva !== 'metas';
  document.getElementById('aba-notas').hidden = abaAtiva !== 'notas';
  document.getElementById('aba-anual').hidden = abaAtiva !== 'anual';
  document.querySelectorAll('nav.abas button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === abaAtiva));
  if (abaAtiva === 'inicio') renderInicio();
  else if (abaAtiva === 'agendamentos' || abaAtiva === 'metas') renderAgendamentos();
  else if (abaAtiva === 'notas') { if (carregouNfDoc && carregouNfEntries) renderNotas(); }
  else renderAnual();
}

document.querySelectorAll('nav.abas button').forEach(btn => {
  btn.addEventListener('click', () => { abaAtiva = btn.dataset.aba; renderAba(); });
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
function buscarHistorico(telefone, nome) {
  const tel = normalizarTelefone(telefone);
  const nomeNorm = (nome || '').trim().toLowerCase();
  if (tel.length < 8 && !nomeNorm) return [];
  return state.entries.filter(e => {
    if (editingEntryId && e.id === editingEntryId) return false;
    if (tel.length >= 8) return normalizarTelefone(e.telefone) === tel;
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

function atualizarPainelHistorico() {
  const painel = document.getElementById('historico-contato');
  if (!painel) return;
  const telefone = document.getElementById('f-telefone').value;
  const nome = document.getElementById('f-nome').value;
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
    if (!tel || vistos.has(telNorm)) return;
    if (telNorm.includes(alvo)) { vistos.add(telNorm); lista.push({ tel, nome: e.nome || '(sem nome)' }); }
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
    const semNada = document.getElementById('painel-agendados-hoje').hidden
      && document.getElementById('painel-consultas-hoje').hidden
      && document.getElementById('painel-pendentes').hidden;
    vazio.hidden = !semNada;
  }
}

// Quem ELA agendou HOJE (dia em que falou com a pessoa/marcou o agendamento),
// não importa pra quando ficou marcada a consulta — é só informativo, com
// atalho pra editar caso precise ajustar algo
function entriesAgendadosHoje() {
  const hoje = hojeStr();
  return state.entries
    .filter(e => e.status === 'Agendado' && e.dataContato === hoje)
    .sort((a, b) => (a.dataAgendamento || '').localeCompare(b.dataAgendamento || '') || (a.horario || '').localeCompare(b.horario || ''));
}

function renderAgendadosHoje() {
  const painel = document.getElementById('painel-agendados-hoje');
  const contagem = document.getElementById('agendados-hoje-contagem');
  const lista = document.getElementById('lista-agendados-hoje');
  const hoje = hojeStr();
  const agendadosHoje = entriesAgendadosHoje();

  if (agendadosHoje.length === 0) { painel.hidden = true; return; }

  painel.hidden = false;
  contagem.textContent = agendadosHoje.length;
  lista.innerHTML = agendadosHoje.map(e => {
    const consultaHoje = e.dataAgendamento === hoje;
    const quando = e.dataAgendamento
      ? (consultaHoje ? 'Consulta hoje' : 'Consulta em ' + formatarData(e.dataAgendamento)) + (e.horario ? ' às ' + escapeHtml(e.horario) : '')
      : 'Sem data de consulta definida';
    return `
    <div class="pendente-item">
      <div class="pendente-info">
        <b>${escapeHtml(e.nome || '(sem nome)')}</b> — ${telefoneClicavel(e.telefone)}${e.animal ? ' · ' + escapeHtml(e.animal) : ''}
        <span>${quando}${e.clinica ? ' · ' + escapeHtml(e.clinica) : ''}</span>
      </div>
      <button type="button" class="btn-editar-pendente" data-id="${e.id}">Editar</button>
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

// Quem TEM consulta marcada pra HOJE (não importa quando foi agendado) — ela
// confirma aqui se o cliente realmente veio; confirmando, já marca Realizado
function entriesConsultasHoje() {
  const hoje = hojeStr();
  return state.entries
    .filter(e => e.status === 'Agendado' && e.dataAgendamento === hoje)
    .sort((a, b) => (a.horario || '').localeCompare(b.horario || ''));
}

function renderConsultasHoje() {
  const painel = document.getElementById('painel-consultas-hoje');
  const contagem = document.getElementById('consultas-hoje-contagem');
  const lista = document.getElementById('lista-consultas-hoje');
  const consultasHoje = entriesConsultasHoje();

  if (consultasHoje.length === 0) { painel.hidden = true; return; }

  painel.hidden = false;
  contagem.textContent = consultasHoje.length;
  lista.innerHTML = consultasHoje.map(e => `
    <div class="pendente-item">
      <div class="pendente-info">
        <b>${escapeHtml(e.nome || '(sem nome)')}</b> — ${telefoneClicavel(e.telefone)}${e.animal ? ' · ' + escapeHtml(e.animal) : ''}
        <span>${e.horario ? 'Hoje às ' + escapeHtml(e.horario) : 'Hoje'}${e.clinica ? ' · ' + escapeHtml(e.clinica) : ''}</span>
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
// todo mundo que está esperando contato, mais próximo primeiro.
function renderPainelPendentes() {
  const painel = document.getElementById('painel-pendentes');
  const contagem = document.getElementById('pendentes-contagem');
  const lista = document.getElementById('lista-pendentes');
  const hoje = hojeStr();

  // ordena pelo dia escolhido pra contatar de novo (dataAgendamento); contatos
  // antigos sem esse dia definido caem no fim, ordenados pela data de contato
  const pendentes = state.entries
    .filter(e => e.status === 'Aguardando')
    .sort((a, b) => {
      const da = a.dataAgendamento || '9999-99-99';
      const db_ = b.dataAgendamento || '9999-99-99';
      if (da !== db_) return da < db_ ? -1 : 1;
      return (a.dataContato || '').localeCompare(b.dataContato || '');
    });

  if (pendentes.length === 0) { painel.hidden = true; return; }

  painel.hidden = false;
  contagem.textContent = pendentes.length;
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
    return `<div class="linha"><span>${t}</span><b>${s.agendados}</b></div>`;
  }).join('');

  let htmlCidades = cat.cidades.map(c => `<div class="linha"><span>${c}</span><b>${stats.porCidade[c]||0}</b></div>`).join('');
  let htmlClinicas = cat.clinicas.map(c => `<div class="linha"><span>${c}</span><b>${stats.porClinica[c]||0}</b></div>`).join('');

  const motivosComValor = Object.entries(stats.porMotivo).filter(([,v]) => v > 0);
  let htmlMotivos = motivosComValor.length
    ? motivosComValor.map(([m,v]) => `<div class="linha"><span>${m}</span><b>${v}</b></div>`).join('')
    : '<div class="sub">Nenhum registro</div>';

  cont.innerHTML = `
    <div class="card">
      <h3>Contatos no mês</h3>
      <div class="num">${stats.total}</div>
      <div class="sub">${stats.desmarques} desmarque(s) · ${stats.naoAgendados} não agendou(aram)</div>
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
      else { statusTxt = 'Meta em andamento...'; statusClasse = 'andamento'; }
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
  const algumAtivo = !!(filtros.busca || filtros.status || filtros.tipo || filtros.cidade || filtros.clinica || filtros.motivo || filtros.periodo);
  document.getElementById('btn-limpar-filtros').hidden = !algumAtivo;
}

['filtro-busca','filtro-status','filtro-tipo','filtro-cidade','filtro-clinica','filtro-motivo'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    filtros.busca = normalizarTexto(document.getElementById('filtro-busca').value.trim());
    filtros.status = document.getElementById('filtro-status').value;
    filtros.tipo = document.getElementById('filtro-tipo').value;
    filtros.cidade = document.getElementById('filtro-cidade').value;
    filtros.clinica = document.getElementById('filtro-clinica').value;
    filtros.motivo = document.getElementById('filtro-motivo').value;
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
  document.getElementById('btn-filtro-7dias').classList.remove('ativo');
  filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '', motivo: '', periodo: '' };
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
      <td><span class="avatar-mini">${escapeHtml(iniciais(e.nome))}</span>${escapeHtml(e.nome||'')}${desmarques >= 2 ? `<span class="badge-alerta">já desmarcou ${desmarques}x</span>` : ''}${e.mesmoContatoOutroAnimal ? `<span class="badge-mesmo-contato">mesmo telefonema</span>` : ''}</td>
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
  document.getElementById('modal-texto').hidden = false;
}
document.getElementById('fechar-modal-texto').addEventListener('click', () => {
  document.getElementById('modal-texto').hidden = true;
});
document.getElementById('modal-texto').addEventListener('click', ev => {
  if (ev.target.id === 'modal-texto') document.getElementById('modal-texto').hidden = true;
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

  // horário só faz sentido quando realmente existe um agendamento (marcado ou já realizado);
  // só esconde o campo (não apaga o valor, caso ela troque o status e volte)
  document.getElementById('campo-horario').hidden = !STATUS_AGENDADOS.includes(status);
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

function abrirModalEntry(entry) {
  popularSelects();
  editingEntryId = entry ? entry.id : null;
  document.getElementById('entry-titulo').textContent = entry ? 'Editar contato' : 'Novo contato';
  document.getElementById('btn-excluir-entry').hidden = !entry;

  document.getElementById('f-nome').value = entry ? entry.nome||'' : '';
  document.getElementById('f-telefone').value = entry ? entry.telefone||'' : '';
  document.getElementById('f-animal').value = entry ? entry.animal||'' : '';
  document.getElementById('f-mesmo-contato').checked = entry ? !!entry.mesmoContatoOutroAnimal : false;
  document.getElementById('f-indicacao').value = entry ? entry.indicacao||'' : '';
  document.getElementById('f-clinica').value = entry ? entry.clinica||'' : (state.categorias.clinicas[0]||'');
  document.getElementById('f-cidade').value = entry ? entry.cidade||'' : (state.categorias.cidades[0]||'');
  document.getElementById('f-tipo').value = entry ? entry.tipo||'' : (state.categorias.tipos[0]||'');
  document.getElementById('f-datacontato').value = entry ? entry.dataContato||'' : hojeStr();
  // contato novo começa como "Aguardando" — só vira Agendado/Realizado/etc quando
  // ela de fato decidir o que aconteceu com esse contato
  document.getElementById('f-status').value = entry ? entry.status||'Agendado' : 'Aguardando';
  document.getElementById('f-data2').value = entry ? entry.dataAgendamento||'' : '';
  document.getElementById('f-horario').value = entry ? entry.horario||'' : '';
  document.getElementById('f-motivo').value = entry ? entry.motivo||'' : (state.categorias.motivos[0]||'');
  document.getElementById('f-detalhe-motivo').value = entry ? entry.detalheMotivo||'' : '';
  document.getElementById('f-obs').value = entry ? entry.obs||'' : '';
  atualizarVisibilidadeMotivo();
  atualizarPainelHistorico();

  document.getElementById('modal-entry').hidden = false;
}
function fecharModalEntry() {
  document.getElementById('modal-entry').hidden = true;
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
    indicacao: document.getElementById('f-indicacao').value.trim(),
    clinica: document.getElementById('f-clinica').value,
    cidade: document.getElementById('f-cidade').value,
    tipo: document.getElementById('f-tipo').value,
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
  document.getElementById('modal-categorias').hidden = false;
});
document.getElementById('fechar-modal-categorias').addEventListener('click', () => {
  document.getElementById('modal-categorias').hidden = true;
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
      <div class="stat-tile">
        <div class="rot">Mês com mais ${d.label}</div>
        <div class="val">${maisD ? MESES_ABREV[Number(maisD.mesKey.slice(5,7))-1].toLowerCase() + ' (' + maisD[d.campo] + ')' : '—'}</div>
      </div>
      <div class="stat-tile">
        <div class="rot">Mês com menos ${d.label}</div>
        <div class="val">${menosD ? MESES_ABREV[Number(menosD.mesKey.slice(5,7))-1].toLowerCase() + ' (' + menosD[d.campo] + ')' : '—'}</div>
      </div>
    `;
  }).join('');
  document.getElementById('anual-destaques').innerHTML = destaquesHtml;

  const maxPorCampo = {};
  defs.forEach(d => { maxPorCampo[d.campo] = Math.max(0, ...meses.map(m => m[d.campo])); });

  const linhasHtml = meses.map((m,i) => `
    <tr>
      <td class="mes-nome">${MESES_ABREV[i]}</td>
      <td class="${m.contatos === maxPorCampo.contatos && m.contatos > 0 ? 'maior-valor' : ''}">${m.contatos}</td>
      <td class="${m.consultas === maxPorCampo.consultas && m.consultas > 0 ? 'maior-valor' : ''}">${m.consultas}</td>
      <td class="${m.cirurgias === maxPorCampo.cirurgias && m.cirurgias > 0 ? 'maior-valor' : ''}">${m.cirurgias}</td>
    </tr>
  `).join('');
  document.getElementById('tabela-anual-corpo').innerHTML = linhasHtml;

  renderGraficoAnual(meses, defs);
}

// ---- Gráfico do Comparativo Anual: uma linha por indicador, mês a mês ----
// Cores escolhidas e validadas pra quem tem daltonismo conseguir diferenciar
// as 3 linhas mesmo sem olhar a legenda (não são as cores do tema do app).
const CORES_ANUAL = { contatos: '#2a78d6', consultas: '#eb6834', cirurgias: '#1baf7a' };

function escalaNiceMax(valor) {
  if (valor <= 0) return 4;
  const passos = [1, 2, 2.5, 5, 10];
  const grandeza = Math.pow(10, Math.floor(Math.log10(valor)));
  for (const p of passos) {
    const candidato = p * grandeza;
    if (candidato >= valor) return candidato;
  }
  return 10 * grandeza;
}

function renderGraficoAnual(meses, defs) {
  const svg = document.getElementById('grafico-anual');
  const legenda = document.getElementById('anual-legenda');
  const tooltip = document.getElementById('anual-tooltip');
  if (!svg || !legenda) return;

  legenda.innerHTML = defs.map(d => `<span class="legenda-item"><span class="legenda-linha" style="background:${CORES_ANUAL[d.campo]}"></span>${escapeHtml(d.label)}</span>`).join('');

  const W = 720, H = 260, PAD_L = 32, PAD_R = 14, PAD_T = 14, PAD_B = 28;
  const areaW = W - PAD_L - PAD_R, areaH = H - PAD_T - PAD_B;
  const valorMax = escalaNiceMax(Math.max(0, ...meses.flatMap(m => defs.map(d => m[d.campo]))));
  const xDe = i => PAD_L + (areaW * i) / 11;
  const yDe = v => PAD_T + areaH - (areaH * v) / valorMax;

  const NUM_FAIXAS = 4;
  let grade = '';
  for (let i = 0; i <= NUM_FAIXAS; i++) {
    const v = Math.round((valorMax / NUM_FAIXAS) * i);
    const y = yDe(v);
    grade += `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="#EFE3D3" stroke-width="1"/>`;
    grade += `<text x="${PAD_L - 6}" y="${(y + 3.5).toFixed(1)}" font-size="9.5" fill="#7A6A5C" text-anchor="end">${v}</text>`;
  }

  let rotulosMes = '';
  meses.forEach((m, i) => {
    rotulosMes += `<text x="${xDe(i).toFixed(1)}" y="${H - 8}" font-size="9.5" fill="#7A6A5C" text-anchor="middle">${MESES_ABREV[i]}</text>`;
  });

  let linhas = '';
  defs.forEach(d => {
    const cor = CORES_ANUAL[d.campo];
    const pontos = meses.map((m, i) => `${xDe(i).toFixed(1)},${yDe(m[d.campo]).toFixed(1)}`).join(' ');
    linhas += `<polyline points="${pontos}" fill="none" stroke="${cor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    meses.forEach((m, i) => {
      linhas += `<circle cx="${xDe(i).toFixed(1)}" cy="${yDe(m[d.campo]).toFixed(1)}" r="4" fill="${cor}" stroke="#FFF8F2" stroke-width="2"></circle>`;
    });
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = grade + linhas + rotulosMes +
    `<line id="anual-crosshair" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" stroke="#C9AD8C" stroke-width="1" style="display:none"></line>`;

  if (!tooltip) return;
  function atualizarHover(clientX) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const escalaX = W / rect.width;
    const xSvg = (clientX - rect.left) * escalaX;
    let idx = Math.round(((xSvg - PAD_L) / areaW) * 11);
    idx = Math.max(0, Math.min(11, idx));
    const cx = xDe(idx);
    const crosshair = document.getElementById('anual-crosshair');
    if (crosshair) { crosshair.setAttribute('x1', cx); crosshair.setAttribute('x2', cx); crosshair.style.display = ''; }
    tooltip.innerHTML = `<b>${MESES[idx]}</b>` + defs.map(d => `<div class="anual-tooltip-linha"><span class="legenda-linha" style="background:${CORES_ANUAL[d.campo]}"></span>${escapeHtml(d.label)}: <b>${meses[idx][d.campo]}</b></div>`).join('');
    tooltip.style.display = 'block';
    const xPix = cx / escalaX;
    tooltip.style.left = Math.max(0, Math.min(rect.width - 170, xPix - 80)) + 'px';
  }
  svg.onmousemove = ev => atualizarHover(ev.clientX);
  svg.onmouseleave = () => {
    const crosshair = document.getElementById('anual-crosshair');
    if (crosshair) crosshair.style.display = 'none';
    tooltip.style.display = 'none';
  };
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
  const totalCobrado = lista.reduce((s,e) => s + (Number(e.cobrado)||0), 0);
  const totalNaNota = lista.reduce((s,e) => s + (Number(e.valorNota)||0), 0);
  const pendentes = lista.filter(e => !e.feito).length;
  const feitos = lista.filter(e => e.feito).length;
  cont.innerHTML = `
    <div class="card">
      <h3>Lançamentos no mês</h3>
      <div class="num">${lista.length}</div>
      <div class="sub">R$ ${formatarMoeda(totalCobrado)} cobrado(s)</div>
    </div>
    <div class="card">
      <h3>Valor na nota</h3>
      <div class="num">R$ ${formatarMoeda(totalNaNota)}</div>
      <div class="sub">cobrado menos splits</div>
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

// Monta a linha de um lançamento — usada nas duas tabelonas (feitas/pendentes)
function linhaNf(e) {
  const servicosTxt = (e.servicos||[]).join(', ');
  return `
    <tr data-id="${e.id}">
      <td><span class="avatar-mini">${escapeHtml(iniciais(e.cliente))}</span>${escapeHtml(e.cliente||'')}</td>
      <td>${escapeHtml(e.animal||'')}</td>
      <td>${telefoneClicavel(e.telefone)}</td>
      <td>${escapeHtml(e.cidade||'')}</td>
      <td>${escapeHtml(servicosTxt || '—')}</td>
      <td>${formatarData(e.dataPagamento)}</td>
      <td>${escapeHtml(e.pagamento||'')}</td>
      <td>R$ ${formatarMoeda(e.cobrado)}</td>
      <td>R$ ${formatarMoeda(e.valorNota)}</td>
      <td>${e.querNf ? '<span class="tag-sim-nf">Enviar</span>' : ''}</td>
      <td><button type="button" class="pill-toggle pill ${e.feito ? 'feito' : 'pendente'} btn-toggle-feito" title="Clique pra marcar ${e.feito ? 'como pendente' : 'como feito'}">${e.feito ? '✓ Feito' : 'Pendente'}</button></td>
      <td class="acoes"><button class="btn outline sm btn-editar-nf">Editar</button></td>
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
  corpo.querySelectorAll('.btn-editar-nf').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      abrirModalNf(state.nfEntries.find(e => e.id === id));
    });
  });
}

// Duas tabelonas separadas (feitas / pendentes) pra não misturar visualmente —
// o mesmo lançamento aparece numa ou noutra dependendo só do campo "feito"
function renderTabelaNf(mesKey) {
  let lista = entriesNfDoMes(mesKey);
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
  document.getElementById('nf-f-quer-nf').checked = entry ? !!entry.querNf : true;
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

  document.getElementById('modal-nf').hidden = false;
}
function fecharModalNf() {
  document.getElementById('modal-nf').hidden = true;
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
  if (!achado) return;
  if (!document.getElementById('nf-f-cliente').value.trim()) document.getElementById('nf-f-cliente').value = achado.cliente || '';
  if (!document.getElementById('nf-f-cidade').value) document.getElementById('nf-f-cidade').value = achado.cidade || '';
  if (!document.getElementById('nf-f-nome').value.trim()) { document.getElementById('nf-f-nome').value = achado.nomeNf || ''; nfNomeSincronizado = false; }
  if (!document.getElementById('nf-f-cpf').value.trim()) document.getElementById('nf-f-cpf').value = achado.cpf || '';
  if (!document.getElementById('nf-f-cep').value.trim()) document.getElementById('nf-f-cep').value = achado.cep || '';
  if (!document.getElementById('nf-f-numero').value.trim()) document.getElementById('nf-f-numero').value = achado.numero || '';
  if (!document.getElementById('nf-f-rua').value.trim()) document.getElementById('nf-f-rua').value = achado.rua || '';
  if (!document.getElementById('nf-f-complemento').value.trim()) document.getElementById('nf-f-complemento').value = achado.complemento || '';
  if (!document.getElementById('nf-f-bairro').value.trim()) document.getElementById('nf-f-bairro').value = achado.bairro || '';
  if (!document.getElementById('nf-f-cidade-end').value.trim()) document.getElementById('nf-f-cidade-end').value = achado.cidadeEndereco || '';
  if (!document.getElementById('nf-f-estado').value.trim()) document.getElementById('nf-f-estado').value = achado.estado || '';
  if (!document.getElementById('nf-f-email').value.trim()) document.getElementById('nf-f-email').value = achado.email || '';
  mostrarToast('Dados preenchidos a partir de um lançamento anterior');
}
document.getElementById('nf-f-telefone').addEventListener('blur', autopreencherNf);
document.getElementById('nf-f-cpf').addEventListener('blur', autopreencherNf);

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
  document.getElementById('modal-servicos').hidden = false;
});
document.getElementById('fechar-modal-servicos').addEventListener('click', () => {
  document.getElementById('modal-servicos').hidden = true;
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
