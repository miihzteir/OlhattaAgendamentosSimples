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
  metas: {}
};
let carregouDoc = false;
let carregouEntries = false;
let currentDate = new Date();          // controla mês/ano da aba Agendamentos
let anoAnual = new Date().getFullYear(); // controla ano da aba Comparativo Anual
let editingEntryId = null;
let abaAtiva = 'agendamentos';
let filtros = { busca: '', status: '', tipo: '', cidade: '', clinica: '' };
let unsubDoc = null;
let unsubEntries = null;
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
  if (user) {
    const email = (user.email || '').toLowerCase();
    const permitido = EMAILS_PERMITIDOS.map(e => e.toLowerCase()).includes(email);
    if (!permitido) {
      document.getElementById('login-erro').style.display = 'block';
      document.getElementById('login-status').textContent = '';
      auth.signOut();
      return;
    }
    document.getElementById('tela-login').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('user-email').textContent = user.email;
    iniciarEscuta();
  } else {
    document.getElementById('tela-login').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    if (unsubEntries) { unsubEntries(); unsubEntries = null; }
    carregouDoc = false;
    carregouEntries = false;
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

// ============================================================
// CÁLCULOS — resumo do mês
// ============================================================
// Regra combinada: um contato conta no mês em que foi FALADO (dataContato);
// um agendamento conta no mês em que a consulta/cirurgia vai ACONTECER (dataAgendamento).
// Os dois podem cair em meses diferentes (ex: contato em agosto, agendado pra setembro).
function contatosDoMes(mesKey) {
  return state.entries.filter(e => mesDe(e.dataContato) === mesKey);
}
function agendadosDoMes(mesKey) {
  return state.entries.filter(e => STATUS_AGENDADOS.includes(e.status) && mesDe(e.dataAgendamento) === mesKey);
}
function naoAgendadosOuDesmarcadosDoMes(mesKey) {
  // usa a data do desmarque/decisão quando existe; senão cai pra data de contato
  return state.entries.filter(e => STATUS_NAO_AGENDADOS.includes(e.status) && mesDe(e.dataAgendamento || e.dataContato) === mesKey);
}
// mantido pra telas que ainda precisam "todos os registros relevantes a este mês"
function entriesDoMes(mesKey) {
  return contatosDoMes(mesKey);
}

function statsDoMes(mesKey) {
  const contatos = contatosDoMes(mesKey);
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
  if (!document.getElementById('modal-entry').hidden) atualizarPainelHistorico();
  if (!document.getElementById('modal-categorias').hidden) renderCategoriasPainel();
}

function renderAba() {
  document.getElementById('aba-agendamentos').hidden = abaAtiva !== 'agendamentos';
  document.getElementById('aba-anual').hidden = abaAtiva !== 'anual';
  document.querySelectorAll('nav.abas button').forEach(b => b.classList.toggle('ativa', b.dataset.aba === abaAtiva));
  if (abaAtiva === 'agendamentos') renderAgendamentos();
  else renderAnual();
}

document.querySelectorAll('nav.abas button').forEach(btn => {
  btn.addEventListener('click', () => { abaAtiva = btn.dataset.aba; renderAba(); });
});

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

  preencher('f-clinica', cat.clinicas, null);
  preencher('f-cidade', cat.cidades, null);
  preencher('f-tipo', cat.tipos, null);
  preencher('f-motivo', cat.motivos, null);
  const optNovoMotivo = document.createElement('option');
  optNovoMotivo.value = '__novo__';
  optNovoMotivo.textContent = '+ Adicionar novo motivo...';
  document.getElementById('f-motivo').appendChild(optNovoMotivo);

}

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

function renderAgendamentos() {
  document.getElementById('mes-rotulo').textContent = rotuloMes(currentDate);
  const mesKey = mesKeyDe(currentDate);
  const stats = statsDoMes(mesKey);

  renderCards(stats);
  renderPendentes();
  renderSemanas(stats);
  renderMetas(mesKey, stats);
  renderTabela(mesKey);
}

// Contatos com status "Aguardando" (a recontatar depois) — mostrados sempre,
// independente do mês selecionado, pra não ficarem esquecidos.
function renderPendentes() {
  const painel = document.getElementById('painel-pendentes');
  const contagem = document.getElementById('pendentes-contagem');
  const lista = document.getElementById('lista-pendentes');

  const pendentes = state.entries
    .filter(e => e.status === 'Aguardando')
    .sort((a, b) => (a.dataContato || '').localeCompare(b.dataContato || ''));

  if (pendentes.length === 0) { painel.hidden = true; return; }

  painel.hidden = false;
  contagem.textContent = pendentes.length;
  lista.innerHTML = pendentes.map(e => `
    <div class="pendente-item">
      <div class="pendente-info">
        <b>${escapeHtml(e.nome || '(sem nome)')}</b> — ${escapeHtml(e.telefone || '')}${e.animal ? ' · ' + escapeHtml(e.animal) : ''}
        <span>Contato em ${formatarData(e.dataContato)}${e.detalheMotivo ? ' · ' + escapeHtml(e.detalheMotivo) : ''}</span>
      </div>
      <button type="button" class="btn-editar-pendente" data-id="${e.id}">Contatar / editar</button>
    </div>
  `).join('');

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

function renderSemanas(stats) {
  const max = Math.max(0, ...stats.porSemana);
  const cont = document.getElementById('grafico-semanas');
  cont.innerHTML = stats.porSemana.map((v, i) => `
    <tr class="${v === max && max > 0 ? 'semana-linha-max' : ''}">
      <td>Semana ${i+1}</td>
      <td class="semana-num">${v}</td>
    </tr>
  `).join('');
}

// ---------- Metas ----------
const CAMPOS_META = [
  { key: 'CA', titulo: 'Consultas e Acompanhamentos', getAtual: s => s.consultasEAcompanhamentos },
  { key: 'Cirurgias', titulo: 'Cirurgias', getAtual: s => s.cirurgias },
  { key: 'Exames', titulo: 'Exames', manual: true },
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

    let statusTxt = 'Defina a meta', statusClasse = 'andamento';
    if (meta > 0) {
      if (super_ > 0 && atual >= super_) { statusTxt = 'Supermeta batida!'; statusClasse = 'super'; }
      else if (atual >= meta) { statusTxt = 'Meta batida!'; statusClasse = 'ok'; }
      else { statusTxt = 'Meta em andamento...'; statusClasse = 'andamento'; }
    }

    const formatar = v => campo.moeda ? 'R$ ' + v.toFixed(2) : v;

    const campoAtualManual = campo.manual
      ? `<label style="flex:1">Atual${campo.moeda ? ' (R$)' : ''}<input type="number" min="0" step="${campo.moeda ? '0.01' : '1'}" data-mkey="${mesKey}" data-campo="atual${campo.key}" value="${atual||''}" class="input-meta"></label>`
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
          <label>Meta<input type="number" min="0" step="1" data-mkey="${mesKey}" data-campo="meta${campo.key}" value="${meta||''}" class="input-meta"></label>
          <label>Supermeta<input type="number" min="0" step="1" data-mkey="${mesKey}" data-campo="super${campo.key}" value="${super_||''}" class="input-meta"></label>
          ${campoAtualManual}
          <span class="meta-status ${statusClasse}">${statusTxt}</span>
        </div>
      </div>
    `;
  }).join('');

  cont.querySelectorAll('.input-meta').forEach(inp => {
    inp.addEventListener('change', onMetaInputChange);
  });
}

function onMetaInputChange(ev) {
  const el = ev.target;
  const mkey = el.dataset.mkey;
  const campo = el.dataset.campo;
  const valor = el.value === '' ? 0 : Number(el.value);
  state.metas[mkey] = Object.assign({}, state.metas[mkey] || {}, { [campo]: valor }); // atualização otimista local
  salvarCampoMeta(mkey, campo, valor).then(() => mostrarToast('Meta salva')).catch(err => mostrarToast('Erro ao salvar meta: ' + err.message));
}

// ---------- Filtros ----------
['filtro-busca','filtro-status','filtro-tipo','filtro-cidade','filtro-clinica'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    filtros.busca = document.getElementById('filtro-busca').value.trim().toLowerCase();
    filtros.status = document.getElementById('filtro-status').value;
    filtros.tipo = document.getElementById('filtro-tipo').value;
    filtros.cidade = document.getElementById('filtro-cidade').value;
    filtros.clinica = document.getElementById('filtro-clinica').value;
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
  let lista = entriesDoMes(mesKey);
  if (filtros.status) lista = lista.filter(e => e.status === filtros.status);
  if (filtros.tipo) lista = lista.filter(e => e.tipo === filtros.tipo);
  if (filtros.cidade) lista = lista.filter(e => e.cidade === filtros.cidade);
  if (filtros.clinica) lista = lista.filter(e => e.clinica === filtros.clinica);
  if (filtros.busca) {
    lista = lista.filter(e =>
      (e.nome||'').toLowerCase().includes(filtros.busca) ||
      (e.animal||'').toLowerCase().includes(filtros.busca) ||
      (e.telefone||'').toLowerCase().includes(filtros.busca)
    );
  }
  lista = lista.slice().sort((a,b) => {
    const da = a.dataAgendamento || a.dataContato || '';
    const db_ = b.dataAgendamento || b.dataContato || '';
    return da < db_ ? -1 : da > db_ ? 1 : 0;
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
      <td>${escapeHtml(e.nome||'')}${desmarques >= 2 ? `<span class="badge-alerta">já desmarcou ${desmarques}x</span>` : ''}</td>
      <td>${escapeHtml(e.telefone||'')}</td>
      <td>${escapeHtml(e.animal||'')}</td>
      <td>${escapeHtml(e.clinica||'')}</td>
      <td>${escapeHtml(e.cidade||'')}</td>
      <td>${escapeHtml(e.tipo||'')}</td>
      <td>${formatarData(e.dataContato)}</td>
      <td><span class="pill ${pillClasse(e.status)}">${e.status||''}</span></td>
      <td style="text-align:center"><input type="checkbox" class="chk-agendado" data-id="${e.id}" ${jaAgendado ? 'checked' : ''} title="${jaAgendado ? 'Já agendado' : 'Marcar como agendado'}"></td>
      <td>${formatarData(e.dataAgendamento)}${ehHoje ? '<span class="tag-hoje">Hoje</span>' : ''}</td>
      <td class="obs-cel" title="${escapeHtml((e.motivo||'') + (e.detalheMotivo ? ' — '+e.detalheMotivo : ''))}"><span>${escapeHtml(e.motivo||'—')}</span>${e.detalheMotivo ? '<span class="detalhe-sub">'+escapeHtml(e.detalheMotivo)+'</span>' : ''}</td>
      <td class="obs-cel" title="${escapeHtml(e.obs||'')}"><span>${escapeHtml(e.obs||'')}</span></td>
      <td class="acoes"><button class="btn outline sm btn-editar">Editar</button></td>
    </tr>
  `;
  }).join('');

  corpo.querySelectorAll('.btn-editar').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      abrirModalEntry(state.entries.find(e => e.id === id));
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
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  document.getElementById('label-detalhe-motivo').textContent = ehAguardando ? 'Observação (quando contatar de novo, etc.)' : 'Detalhes do motivo';
  document.getElementById('f-data2-label').textContent = precisaMotivo ? 'Data do desmarque/contato' : 'Data de agendamento';
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
  document.getElementById('f-indicacao').value = entry ? entry.indicacao||'' : '';
  document.getElementById('f-clinica').value = entry ? entry.clinica||'' : (state.categorias.clinicas[0]||'');
  document.getElementById('f-cidade').value = entry ? entry.cidade||'' : (state.categorias.cidades[0]||'');
  document.getElementById('f-tipo').value = entry ? entry.tipo||'' : (state.categorias.tipos[0]||'');
  document.getElementById('f-datacontato').value = entry ? entry.dataContato||'' : hojeStr();
  document.getElementById('f-status').value = entry ? entry.status||'Agendado' : 'Agendado';
  document.getElementById('f-data2').value = entry ? entry.dataAgendamento||'' : '';
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

document.getElementById('form-entry').addEventListener('submit', ev => {
  ev.preventDefault();
  const status = document.getElementById('f-status').value;
  const precisaMotivo = STATUS_NAO_AGENDADOS.includes(status);
  const mostrarDetalhe = precisaMotivo || status === 'Aguardando';
  const btnSalvar = ev.target.querySelector('button[type=submit]');
  const dados = {
    nome: document.getElementById('f-nome').value.trim(),
    telefone: document.getElementById('f-telefone').value.trim(),
    animal: document.getElementById('f-animal').value.trim(),
    indicacao: document.getElementById('f-indicacao').value.trim(),
    clinica: document.getElementById('f-clinica').value,
    cidade: document.getElementById('f-cidade').value,
    tipo: document.getElementById('f-tipo').value,
    dataContato: document.getElementById('f-datacontato').value,
    status: status,
    dataAgendamento: document.getElementById('f-data2').value,
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
}

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
