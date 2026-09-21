(() => {
  'use strict';

  const descriptions = {
    conectividade: 'Ativação dos serviços conectados: Pareado + Pareado depois sobre o total de chassis.',
    ltsm: 'Checagem de bateria no estoque: On Time + Done Late sobre o total de chassis elegíveis.',
    battery_check: 'Saúde da bateria na preparação do veículo novo: OK sobre o total Network.',
    dda: 'Jornada do veículo: média dos resultados de Recepção, Preparação e Entrega.'
  };

  const processSoftColors = {
    conectividade: '#f5c9dc',
    ltsm: '#c9dfd7',
    battery_check: '#d9cbe8',
    dda: '#f3df8f'
  };

  const state = {
    data: null,
    page: 'overview',
    process: 'conectividade',
    period: '',
    snapshot: 'ultimo_dia',
    regions: new Set(),
    view: 'performance',
    entityLevel: 'Grupo',
    selectedEntity: null,
    selectedMonths: new Set(),
    timelinePeriods: new Set(),
    timelineComponents: new Set(['result']),
    snapshotScope: 'Brasil',
    overviewPeriods: new Set(),
    overviewRegions: new Set(),
    chassisCache: new Map(),
    chassisManifest: null, chassisPending: new Map(), chassisRequest: 0
  };


  const $ = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fmtPct = (value) => value == null || Number.isNaN(value) ? '–' : `${(value * 100).toLocaleString('pt-BR', {minimumFractionDigits:1, maximumFractionDigits:1})}%`;
  const fmtPp = (value) => value == null || Number.isNaN(value) ? '–' : `${value >= 0 ? '+' : ''}${(value * 100).toLocaleString('pt-BR', {minimumFractionDigits:1, maximumFractionDigits:1})} p.p.`;
  const fmtInt = (value) => value == null ? '–' : Number(value).toLocaleString('pt-BR');
  const fmtPeriod = (period) => { if (!period) return '–'; const [year, month] = period.split('-'); return `${month}/${year}`; };
  const fmtMonthShort = (period) => { if (!period) return '–'; const [year, month] = period.split('-'); return `${['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][Number(month) - 1]}/${year}`; };
  const dataReferencePeriod = () => {
    const match = String(state.data?.generated_at || '').match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
  };
  const isCurrentPeriod = (period) => Boolean(period && period === dataReferencePeriod());
  const snapshotLabel = (snapshot, period = state.period) => isCurrentPeriod(period) ? 'Mês atual (parcial)' : snapshot === 'oficial' ? 'Fechamento oficial (D+15)' : 'Último dia do mês';
  const snapshotShort = (snapshot, period = state.period) => isCurrentPeriod(period) ? 'Mês atual (parcial)' : snapshot === 'oficial' ? 'Fechamento D+15' : 'Último dia do mês';
  const bandLabel = (band) => ({good:'Enquadrado', bad:'Desenquadrado', attention:'Atenção', neutral:'Sem meta'})[band] || 'Sem meta';
  const processMeta = () => state.data.processes[state.process];
  const selectedRegions = (row) => !row.region || state.regions.has(row.region);

  function effectiveSnapshots(process, period) {
    let snapshots = [...(state.data.availability[process]?.snapshots?.[period] || [])];
    if (process === 'conectividade') snapshots = snapshots.filter((snapshot) => snapshot !== 'oficial');
    if (isCurrentPeriod(period)) {
      const partial = snapshots.filter((snapshot) => snapshot !== 'oficial');
      if (partial.length) snapshots = partial;
    }
    return snapshots;
  }

  function preferredSnapshot(process, period, selected = null) {
    const snapshots = effectiveSnapshots(process, period);
    if (isCurrentPeriod(period) && snapshots.includes('parcial')) return 'parcial';
    if (selected && snapshots.includes(selected)) return selected;
    if (isCurrentPeriod(period) || process === 'conectividade') return snapshots.includes('ultimo_dia') ? 'ultimo_dia' : snapshots[0];
    return snapshots.includes('oficial') ? 'oficial' : snapshots.includes('ultimo_dia') ? 'ultimo_dia' : snapshots[0];
  }

  function latestSummaryRow(process) {
    const periods = state.data.availability[process]?.periods || [];
    const period = periods.at(-1);
    if (!period) return null;
    const snapshot = preferredSnapshot(process, period);
    return state.data.metrics.find((row) => row.process === process && row.period === period && row.snapshot === snapshot && row.level === 'Brasil') || null;
  }

  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  function setProgress(show, percent = 0, stage = 'Preparando dashboard', message = '') {
    $('progressOverlay').classList.toggle('hidden', !show);
    $('progressBar').style.width = `${percent}%`;
    $('progressPercent').textContent = `${percent}%`;
    $('progressStage').textContent = stage;
    $('progressMessage').textContent = message || stage;
  }

  async function pollProgress(stopPromise) {
    const started = Date.now();
    let done = false;
    stopPromise.finally(() => { done = true; });
    while (!done) {
      try {
        const progress = await fetch('/api/progress').then((response) => response.json());
        setProgress(true, progress.percent || 0, progress.stage || 'Processando', progress.message || '');
        $('progressElapsed').textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
      } catch (error) {}
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  async function loadData() {
    if (window.INLINE_PAYLOAD) {
      state.data = window.INLINE_PAYLOAD;
      setProgress(false);
      initialize();
      return;
    }
    if (document.body.dataset.mode === 'github-pages') {
      if (location.protocol === 'file:') throw new Error('Esta versão foi criada para publicação em GitHub Pages e precisa ser aberta por HTTP. Para uso local, utilize o HTML completo offline.');
      setProgress(true, 15, 'Preparando dashboard', 'Carregando dados agregados.');
      const response = await fetch('./data/dashboard.json');
      if (!response.ok) throw new Error('Não foi possível carregar dashboard.json.');
      state.data = await response.json();
      setProgress(false);
      initialize();
      return;
    }
    setProgress(true, 0, 'Preparando dashboard', 'Lendo o estado do processamento.');
    const started = Date.now();
    while (true) {
      const progress = await fetch('/api/progress').then((response) => response.json());
      setProgress(true, progress.percent || 0, progress.stage || 'Preparando dashboard', progress.message || '');
      $('progressElapsed').textContent = `${Math.floor((Date.now() - started) / 1000)}s`;
      if (progress.status === 'done') break;
      if (progress.status === 'error') throw new Error(progress.message || 'Falha ao carregar as bases.');
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    state.data = await fetch('/api/dashboard').then((response) => response.json());
    setProgress(false);
    initialize();
  }

  function initialize() {
    const available = Object.keys(state.data.availability).find((key) => state.data.availability[key].periods.length);
    if (!state.data.availability[state.process]?.periods.length && available) state.process = available;
    if (!state.regions.size) state.regions = new Set(state.data.regions);
    const overviewAvailablePeriods = [...new Set(Object.values(state.data.availability).flatMap((item) => item.periods || []))].sort();
    if (!state.overviewPeriods.size && overviewAvailablePeriods.length) state.overviewPeriods = new Set([overviewAvailablePeriods.includes(dataReferencePeriod()) ? dataReferencePeriod() : overviewAvailablePeriods.at(-1)]);
    if (!state.overviewRegions.size) state.overviewRegions = new Set(state.data.regions);
    $('generatedAt').textContent = new Date(state.data.generated_at).toLocaleString('pt-BR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});
    $('footerVersion').textContent = `v${state.data.version}`;
    if (state.data.demo_mode) $('overviewDescription').textContent = 'Cenário completo com resultados artificiais para validar metas, filtros, rankings, linha do tempo, YTD e detalhamentos.';
    bindOnce();
    updateProcessControls();
    renderDiagnostics();
  }

  let bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    qsa('.process-tab').forEach((button) => button.addEventListener('click', () => {
      if (button.dataset.page === 'overview') showOverview();
      else switchProcess(button.dataset.process);
    }));
    qsa('.subtab').forEach((button) => button.addEventListener('click', () => activateView(button.dataset.view)));
    qsa('[data-toggle="entity"] button').forEach((button) => button.addEventListener('click', () => setEntityLevel(button.dataset.entity)));
    qsa('.copy-image').forEach((button) => button.addEventListener('click', () => copyBlockAsPng(button.dataset.copy)));
    $('periodSelect').addEventListener('change', (event) => {
      state.period = event.target.value;
      state.snapshot = preferredSnapshot(state.process, state.period) || 'ultimo_dia';
      updateSnapshotToggle();
      state.selectedEntity = null;
      renderAll();
    });
    ['rankingSearch','rankingSort','rankingOrder'].forEach((id) => $(id).addEventListener(id === 'rankingSearch' ? 'input' : 'change', renderRanking));
    $('timelineSort').addEventListener('change', renderTimeline);
    $('timelineOrder').addEventListener('change', renderTimeline);
    $('timelineSearch').addEventListener('input', renderTimeline);
    $('snapshotScopeSelect').addEventListener('change', (event) => {
      state.snapshotScope = event.target.value;
      renderSnapshotHistory();
    });
    $('entitySearch').addEventListener('input', renderSearch);
    ['chassisStatus','chassisDateFrom','chassisDateTo','chassisRegion'].forEach((id) => $(id).addEventListener('change', renderChassis));
    ['chassisGroup','chassisDealer','chassisVin'].forEach((id) => $(id).addEventListener('input', renderChassis));
    $('clearChassisFilters').addEventListener('click', clearChassisFilters);
    $('refreshView').addEventListener('click', () => { renderAll(); toast('Visão atualizada.'); });
    $('reloadBases')?.addEventListener('click', reloadBases);
    $('exportFull')?.addEventListener('click', () => exportHtml('full'));
    $('exportPhone')?.addEventListener('click', () => exportHtml('iphone'));
    $('exportGithub')?.addEventListener('click', () => exportHtml('github-pages'));
    $('openDiagnostics').addEventListener('click', openDiagnostics);
    $('closeDiagnostics').addEventListener('click', () => $('diagnosticsDialog').close());
    $('diagnosticsDialog').addEventListener('click', (event) => {
      if (event.target === $('diagnosticsDialog')) $('diagnosticsDialog').close();
    });
  }

  function switchProcess(process) {
    $('overviewTooltip').hidden = true;
    if (!process) return;
    if (process === state.process && state.page === 'process') return;
    state.page = 'process';
    state.process = process;
    state.snapshot = '';
    state.selectedEntity = null;
    state.selectedMonths.clear();
    state.timelinePeriods.clear();
    state.timelineComponents = new Set(['result']);
    state.snapshotScope = 'Brasil';
    $('entitySearch').value = '';
    $('timelineSearch').value = '';
    $('rankingSearch').value = '';
    clearChassisFilters(false);
    syncMainSection();
    updateProcessControls();
  }

  function showOverview() {
    state.page = 'overview';
    syncMainSection();
    renderOverview();
  }

  function syncMainSection() {
    const isOverview = state.page === 'overview';
    $('processOverview').hidden = !isOverview;
    $('processWorkspace').hidden = isOverview;
    qsa('.process-tab').forEach((button) => {
      const active = isOverview ? button.dataset.page === 'overview' : button.dataset.process === state.process;
      button.classList.toggle('active', active);
    });
  }

  function activateView(view) {
    state.view = view;
    qsa('.subtab').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    qsa('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === view));
    $('regionFilterGroup').hidden = view === 'search' || view === 'snapshots' || view === 'chassis';
    $('snapshotFilterGroup').hidden = view === 'snapshots';
    if (view === 'snapshots') renderSnapshotHistory();
    if (view === 'ranking') renderRanking();
    if (view === 'timeline') renderTimeline();
    if (view === 'topflop') renderTopFlop();
    if (view === 'search') renderSearch();
    if (view === 'chassis') renderChassis();
  }

  function setEntityLevel(level) {
    if (level === state.entityLevel) return;
    state.entityLevel = level;
    state.selectedEntity = null;
    state.selectedMonths.clear();
    $('entitySearch').value = '';
    qsa('[data-toggle="entity"] button').forEach((button) => button.classList.toggle('active', button.dataset.entity === level));
    renderTimeline();
    renderRanking();
    renderTopFlop();
    renderSearch();
    renderChassis();
  }

  function updateProcessControls() {
    const meta = processMeta();
    document.documentElement.style.setProperty('--process', meta.color);
    document.documentElement.style.setProperty('--process-soft', processSoftColors[state.process] || '#e5e5e5');
    const tint = weight => {const hex=meta.color.replace('#','');return 'rgb('+[0,2,4].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*weight+255*(1-weight))).join(',')+')';};
    document.documentElement.style.setProperty('--process-tint',tint(.10));
    document.documentElement.style.setProperty('--process-hover-tint',tint(.17));
    syncMainSection();
    $('processTitle').textContent = meta.name;
    $('processTitle').title = descriptions[state.process] || '';
    $('processGoal').textContent = meta.target == null ? 'Sem meta definida' : `Objetivo ${fmtPct(meta.target)}`;
    const periods = state.data.availability[state.process]?.periods || [];
    state.period = periods.includes(state.period) ? state.period : (periods.at(-1) || '');
    state.timelinePeriods = new Set([...state.timelinePeriods].filter((period) => periods.includes(period)));
    if (!state.timelinePeriods.size && periods.length) state.timelinePeriods = new Set([periods.includes(dataReferencePeriod()) ? dataReferencePeriod() : periods.at(-1)]);
    $('periodSelect').innerHTML = periods.slice().reverse().map((period) => `<option value="${period}">${fmtPeriod(period)}</option>`).join('') || '<option value="">Sem dados</option>';
    $('periodSelect').value = state.period;
    updateSnapshotToggle();
    renderRegionChips();
    renderSnapshotScopeControl();
    renderTimelineControls();
    renderOverview();
    renderAll();
  }

  function firstComponentCount(row, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row.components || {}, key)) return Number(row.components[key] || 0);
    }
    return 0;
  }

  function overviewComponentMarkup(process, row, meta) {
    if (process === 'dda') {
      const labels = {reception:'Recepção', preparation:'Preparação', delivery:'Entrega'};
      return Object.entries(labels).map(([key, label]) => {
        const component = row.components?.[key] || {};
        return `<div><span>${label}</span><strong class="metric ${component.band || 'neutral'}">${fmtPct(component.metric)}</strong></div>`;
      }).join('');
    }
    if (process === 'conectividade') {
      const paired = firstComponentCount(row, ['Pareado', 'Conectado', 'Success']);
      const later = firstComponentCount(row, ['Pareado depois', 'Conectado depois', 'Paired later']);
      const notPaired = firstComponentCount(row, ['Não pareado', 'Não conectado']);
      const items = [
        ['Pareado', paired, 'paired'],
        ['Pareado depois', later, 'paired_later'],
        ['Total Pareado', paired + later, 'result'],
        ['Não pareado', notPaired, 'not_paired']
      ];
      return items.map(([label, count, key]) => `<div><span>${label}</span><strong class="metric ${componentBand(row, key, process)}">${fmtPct(row.denominator ? count / row.denominator : null)}</strong></div>`).join('');
    }
    return meta.statuses.map((status) => {
      const count = row.components?.[status] || 0;
      const share = row.denominator ? count / row.denominator : null;
      const key = process === 'battery_check' ? (status === 'OK' ? 'result' : 'ko') : status;
      return `<div><span>${esc(status)}</span><strong class="metric ${componentBand(row, key, process)}">${fmtPct(share)}</strong></div>`;
    }).join('');
  }

  function awaitsOfficial(process, period) {
    const snapshots = effectiveSnapshots(process,period);
    return process !== 'conectividade' && !isCurrentPeriod(period) && snapshots.includes('ultimo_dia') && !snapshots.includes('oficial');
  }
  function provisionalRow(row) { return row ? {...row, provisional:true} : null; }

  function rankingAnnualRows() {
    const year = state.period.slice(0,4);
    const monthly = state.data.metrics.filter(row => row.process === state.process && row.level === state.entityLevel && row.period.startsWith(year + '-') && /^\d{4}-\d{2}$/.test(row.period) && row.period <= state.period);
    if (['conectividade', 'ltsm'].includes(state.process)) return monthly.filter(row => row.snapshot === 'ytd_atual');
    return monthly.filter(row => row.snapshot === preferredSnapshot(state.process,row.period));
  }
  function renderRanking() {
    if (!state.data) return;
    const monthRows = activeRows(state.entityLevel).filter(selectedRegions);
    const annualRows = rankingAnnualRows().filter(selectedRegions);
    const map = new Map();
    [...monthRows,...annualRows].forEach(row => {
      const key = entityKey(row);
      if (!map.has(key)) map.set(key,{key,name:entityName(row),bir:row.bir,group:row.group,regional:row.region,months:[]});
    });
    monthRows.forEach(row => { map.get(entityKey(row)).mtd = row; });
    annualRows.forEach(row => { map.get(entityKey(row)).months.push(row); });
    const query = $('rankingSearch').value.trim().toLocaleLowerCase('pt-BR');
    const sort = $('rankingSort').value || 'mtd', order = $('rankingOrder').value || 'desc';
    const items = [...map.values()].map(item => ({...item,ytd:combine(item.months)})).filter(item => `${item.name} ${item.bir || ''} ${item.group || ''}`.toLocaleLowerCase('pt-BR').includes(query));
    const value = item => sort === 'volume' ? item.mtd?.denominator : sort === 'ytd' ? item.ytd?.metric : item.mtd?.metric;
    items.sort((a,b) => {
      if (order === 'alpha') return a.name.localeCompare(b.name,'pt-BR');
      const av=value(a), bv=value(b);
      if (av == null || bv == null) return av == null && bv == null ? a.name.localeCompare(b.name,'pt-BR') : av == null ? 1 : -1;
      return (order === 'asc' ? av-bv : bv-av) || a.name.localeCompare(b.name,'pt-BR');
    });
    const periods = [...new Set(annualRows.map(row => row.period))].sort();
    const annualLabel = state.period ? `Jan–${fmtMonthShort(state.period)}` : 'YTD';
    $('rankingTitle').textContent = `${processMeta().name} · ${state.entityLevel} · ${fmtPeriod(state.period)}`;
    $('rankingNote').textContent = `Volume e MTD: ${fmtPeriod(state.period)} · ${snapshotShort(state.snapshot)}. ${awaitsOfficial(state.process,state.period) ? 'D+15 pendente: usando último dia. ' : ''}YTD ${annualLabel}: ${['conectividade','ltsm'].includes(state.process) ? 'posição da base anual mais recente, limitada ao mês selecionado.' : 'bases mensais disponíveis de janeiro até o mês selecionado; resultado ponderado pelos volumes.'}`;
    const cell = row => `<td class="metric ${row ? bandFor(state.process,row.metric) : 'neutral'}" title="${row ? `${fmtInt(row.denominator)} chassis na base` : 'Sem base disponível'}">${fmtPct(row?.metric)}</td>`;
    $('rankingTable').innerHTML = `<thead><tr><th>#</th><th>${state.entityLevel}</th><th>Volume selecionado</th><th>MTD ${fmtPeriod(state.period)}</th><th>YTD ${annualLabel}</th></tr></thead><tbody>${items.map((item,i) => `<tr><td>${i+1}</td><td>${esc(item.name)}</td><td>${fmtInt(item.mtd?.denominator)}</td>${cell(item.mtd)}${cell(item.ytd)}</tr>`).join('') || '<tr><td colspan="5">Nenhum resultado para os filtros selecionados.</td></tr>'}</tbody>`;
  }

  function overviewBreakdown(row, process) {
    if (!row) return 'Sem base disponível.';
    const lines=[];
    if(process === 'dda') {
      const labels={reception:'Recepção',preparation:'Preparação',delivery:'Entrega'};
      Object.entries(labels).forEach(([key,label]) => {const c=row.components[key];lines.push(`${label}: ${fmtInt(c?.numerator)} OK / ${fmtInt(c?.denominator)} · ${fmtPct(c?.metric)}`)});
      lines.push('DDA Total = média das três taxas.');
    } else {
      Object.entries(row.components || {}).forEach(([key,val]) => lines.push(`${key}: ${fmtInt(val)} chassis`));
      lines.push(`Realizados: ${fmtInt(row.numerator)} / ${fmtInt(row.denominator)} · ${fmtPct(row.metric)}`);
    }
    lines.push(`Total: ${fmtInt(row.denominator)} chassis · ${fmtPeriod(row.period)}`);
    return lines.join('\n');
  }
  function openOverviewDrill(process, region=null, view='performance', entity=null) {
    $('overviewTooltip').hidden = true;
    switchProcess(process);
    const processPeriods = state.data.availability[process]?.periods || [];
    const selectedPeriods = [...state.overviewPeriods].filter((period) => processPeriods.includes(period)).sort();
    state.period = selectedPeriods.at(-1) || processPeriods.at(-1) || '';
    state.snapshot = preferredSnapshot(process, state.period) || 'ultimo_dia';
    state.regions=new Set(region ? [region] : state.overviewRegions);
    if(entity){
      state.entityLevel='Grupo';
      qsa('[data-toggle="entity"] button').forEach(b => b.classList.toggle('active',b.dataset.entity==='Grupo'));
      state.selectedEntity={...entity,key:entityKey(entity,'Grupo'),level:'Grupo',name:entityName(entity,'Grupo')};
      $('entitySearch').value=entity.group || entity.name;
      state.selectedMonths=new Set(historyRowsForEntity(state.selectedEntity).map(r=>r.period));
    }
    updateProcessControls();
    activateView(view);
    const target=$(view === 'search' ? 'entityDetail' : view === 'snapshots' ? 'snapshotHistoryBlock' : 'performanceBlock');
    target.classList.remove('drill-flash');
    requestAnimationFrame(()=> {target.classList.add('drill-flash');target.scrollIntoView({behavior:'smooth',block:'center'});});
  }
  function attachOverviewHint(element,text,onClick) {
    if(!element) return;
    element.tabIndex=0;
    element.setAttribute('aria-describedby','overviewTooltip');
    const show=()=> {
      const tip=$('overviewTooltip');tip.textContent=text;tip.hidden=false;
      const rect=element.getBoundingClientRect();
      const left=Math.max(12,Math.min(rect.left,window.innerWidth-tip.offsetWidth-12));
      const top=rect.bottom+9+tip.offsetHeight > window.innerHeight ? Math.max(12,rect.top-tip.offsetHeight-9) : rect.bottom+9;
      tip.style.left=`${left}px`;tip.style.top=`${top}px`;
    };
    const hide=()=> {$('overviewTooltip').hidden=true;};
    element.addEventListener('mouseenter',show);element.addEventListener('mouseleave',hide);
    element.addEventListener('focus',show);element.addEventListener('blur',hide);
    if(onClick){element.dataset.drill='true';element.setAttribute('role','button');element.setAttribute('aria-label',text+' Abrir detalhamento.');element.addEventListener('click',onClick);element.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onClick();}});}
    element.addEventListener('keydown',e=>{if(e.key==='Escape')hide();});
  }
  function overviewAvailablePeriods() {
    return [...new Set(Object.values(state.data.availability).flatMap((item) => item.periods || []))].sort();
  }

  function renderOverviewFilters() {
    const periods = overviewAvailablePeriods();
    state.overviewPeriods = new Set([...state.overviewPeriods].filter((period) => periods.includes(period)));
    if (!state.overviewPeriods.size && periods.length) state.overviewPeriods.add(periods.at(-1));
    state.overviewRegions = new Set([...state.overviewRegions].filter((region) => state.data.regions.includes(region)));
    if (!state.overviewRegions.size) state.overviewRegions = new Set(state.data.regions);
    const allMonths = periods.length > 0 && periods.every((period) => state.overviewPeriods.has(period));
    $('overviewMonthChips').innerHTML = periods.map((period) => `<button type="button" class="${state.overviewPeriods.has(period) ? 'active' : ''}" data-overview-period="${period}">${fmtMonthShort(period).split('/')[0]}</button>`).join('') + `<button type="button" class="${allMonths ? 'active' : ''}" data-overview-period-action="all">Todos</button><button type="button" data-overview-period-action="latest">Mais atual</button>`;
    qsa('[data-overview-period]', $('overviewMonthChips')).forEach((button) => button.addEventListener('click', () => {
      const period = button.dataset.overviewPeriod;
      if (state.overviewPeriods.has(period)) {
        if (state.overviewPeriods.size === 1) return toast('Mantenha ao menos um mês no Resumo.');
        state.overviewPeriods.delete(period);
      } else state.overviewPeriods.add(period);
      renderOverview();
    }));
    qsa('[data-overview-period-action]', $('overviewMonthChips')).forEach((button) => button.addEventListener('click', () => {
      state.overviewPeriods = button.dataset.overviewPeriodAction === 'all' ? new Set(periods) : new Set(periods.length ? [periods.at(-1)] : []);
      renderOverview();
    }));
    const allRegions = state.data.regions.every((region) => state.overviewRegions.has(region));
    $('overviewRegionChips').innerHTML = state.data.regions.map((region) => `<button type="button" class="${state.overviewRegions.has(region) ? 'active' : ''}" data-overview-region="${region}">${region}</button>`).join('') + `<button type="button" class="${allRegions ? 'active' : ''}" data-overview-region-action="all">Todas</button>`;
    qsa('[data-overview-region]', $('overviewRegionChips')).forEach((button) => button.addEventListener('click', () => {
      const region = button.dataset.overviewRegion;
      if (state.overviewRegions.has(region)) {
        if (state.overviewRegions.size === 1) return toast('Mantenha ao menos uma regional no Resumo.');
        state.overviewRegions.delete(region);
      } else state.overviewRegions.add(region);
      renderOverview();
    }));
    qsa('[data-overview-region-action]', $('overviewRegionChips')).forEach((button) => button.addEventListener('click', () => {
      state.overviewRegions = new Set(state.data.regions);
      renderOverview();
    }));
    const selectedPeriods = [...state.overviewPeriods].sort();
    $('overviewFilterNote').textContent = `${selectedPeriods.length} ${selectedPeriods.length === 1 ? 'mês selecionado' : 'meses selecionados'} · ${state.overviewRegions.size} ${state.overviewRegions.size === 1 ? 'regional selecionada' : 'regionais selecionadas'} · resultados consolidados pelos volumes.`;
  }

  function overviewAggregates(process, level) {
    const records = [];
    [...state.overviewPeriods].sort().forEach((period) => {
      const snapshots = state.data.availability[process]?.snapshots?.[period] || [];
      if (!snapshots.length) return;
      const snapshot = preferredSnapshot(process, period);
      state.data.metrics.filter((row) => row.process === process && row.period === period && row.snapshot === snapshot && row.level === level && (!row.region || state.overviewRegions.has(row.region))).forEach((row) => records.push(row));
    });
    if (level === 'Brasil') return records.length ? [combine(records, process)] : [];
    const buckets = new Map();
    records.forEach((row) => {
      const key = level === 'Regional' ? row.region : `${row.region}|${row.group || row.name}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });
    return [...buckets.values()].map((rows) => {
      const result = combine(rows, process);
      const first = rows[0];
      return {...result, level, name:level === 'Regional' ? first.region : (first.group || first.name), region:first.region, group:level === 'Grupo' ? (first.group || first.name) : ''};
    });
  }

  function overviewProcessData(process) {
    const regional = overviewAggregates(process, 'Regional');
    return {total:regional.length ? combine(regional, process) : null, regions:regional, groups:overviewAggregates(process, 'Grupo')};
  }

  function overviewSelectionLabels(process) {
    const periods = [...state.overviewPeriods].filter((period) => (state.data.availability[process]?.periods || []).includes(period)).sort();
    const period = periods.length === 1 ? fmtPeriod(periods[0]) : `${periods.length} meses`;
    const photo = periods.length === 1 ? snapshotShort(preferredSnapshot(process, periods[0]), periods[0]) : 'Melhor disponível/mês';
    return {periods, period, photo};
  }

  function enhanceOverview() {
    qsa('[data-overview-process]', $('overviewCards')).forEach(card=>{
      const process=card.dataset.overviewProcess, data=overviewProcessData(process), row=data.total;
      if(!row)return;
      const labels=overviewSelectionLabels(process), info=overviewBreakdown(row,process), open=()=>openOverviewDrill(process);
      attachOverviewHint(card.querySelector('.overview-result'),info+'\nClique para abrir Brasil e Regionais no mês mais recente da seleção.',open);
      attachOverviewHint(card.querySelector('.overview-meter'),`Resultado: ${fmtPct(row.metric)}. Objetivo: ${state.data.processes[process].target == null ? 'não definido' : fmtPct(state.data.processes[process].target)}.`,open);
      attachOverviewHint(card.querySelector('.status-pill'),info,open);
      qsa('.overview-components>div',card).forEach(element=>{
        const label=element.querySelector('span').textContent;
        let detail=info;
        if(process==='dda'){
          const key={Recepção:'reception',Preparação:'preparation',Entrega:'delivery'}[label];
          const c=row.components[key];detail=`${label}: ${fmtInt(c?.numerator)} OK, ${fmtInt((c?.denominator||0)-(c?.numerator||0))} não OK, ${fmtInt(c?.denominator)} no total.\nResultado: ${fmtPct(c?.metric)}.`;
        }else{
          const count=label==='Total Pareado'?row.numerator:row.components[label];
          detail=`${label}: ${fmtInt(count)} chassis de ${fmtInt(row.denominator)}.\n${fmtPct(row.denominator ? count/row.denominator : null)} do total.`;
        }
        attachOverviewHint(element,detail+'\nClique para ver a composição.',open);
      });
      qsa('.overview-meta>div',card).forEach(element=>{
        const label=element.querySelector('span').textContent;
        const text=label==='Comparação' ? 'Abra a evolução dos fechamentos para comparar último dia, D+15 e YTD quando aplicável.' : label==='Fotografia' ? `Origem: ${labels.photo}.` : label==='Período' ? `Seleção: ${labels.periods.map(fmtPeriod).join(', ')}.` : info;
        attachOverviewHint(element,text,()=>openOverviewDrill(process,null,label==='Comparação'?'snapshots':'performance'));
      });
      const regionBox=card.querySelector('.overview-regional');
      const regions=data.regions.filter((row) => row.metric != null).sort((a,b)=>b.metric-a.metric||a.name.localeCompare(b.name));
      const groups=data.groups.filter((row) => row.metric != null);
      attachOverviewHint(regionBox.firstElementChild,regions.map(r=>`${r.name}: ${fmtPct(r.metric)} · ${fmtInt(r.denominator)} chassis`).join('\n'),open);
      [[regions[0],true],[regions.at(-1),false]].forEach(([region,best])=>{
        if(!region)return;
        const contributors=groups.filter((row)=>row.region===region.name).sort((a,b)=>(best ? b.metric-a.metric : a.metric-b.metric)||b.denominator-a.denominator).slice(0,4);
        const detail=document.createElement('details');detail.className='overview-contributors';
        detail.innerHTML=`<summary><span>${best?'Melhor resultado':'Menor resultado'}</span><strong>${esc(region.name)} · <b class="metric ${region.band}">${fmtPct(region.metric)}</b></strong></summary><div class="overview-group-list"><small>${best?'Promotores · maiores resultados':'Detratores · menores resultados'} na região</small>${contributors.map((g,i)=>`<button type="button" data-group-index="${i}"><span>${esc(g.group||g.name)}</span><b class="metric ${g.band}">${fmtPct(g.metric)}</b></button>`).join('')}</div>`;
        regionBox.appendChild(detail);
        attachOverviewHint(detail.querySelector('summary'),overviewBreakdown(region,process)+'\nAbra a seta para ver os quatro grupos.');
        qsa('[data-group-index]',detail).forEach(button=>{const g=contributors[Number(button.dataset.groupIndex)];attachOverviewHint(button,overviewBreakdown(g,process)+'\nClique para consultar o grupo.',()=>openOverviewDrill(process,region.name,'search',g));});
      });
      const top=groups.slice().sort((a,b)=>b.metric-a.metric||b.denominator-a.denominator).slice(0,4);
      const flop=groups.slice().sort((a,b)=>a.metric-b.metric||b.denominator-a.denominator).slice(0,4);
      const topFlop=document.createElement('details');topFlop.className='overview-contributors';
      topFlop.innerHTML=`<summary><span>Top/Flop</span><strong>4 + 4 grupos</strong></summary><div class="overview-group-list overview-topflop-grid"><small>Grupos nas regionais e meses selecionados</small><div class="overview-topflop-column"><span>Top 4</span>${top.map((g,i)=>`<button type="button" data-top-group="${i}"><span>${esc(g.group||g.name)}</span><b class="metric ${g.band}">${fmtPct(g.metric)}</b></button>`).join('')}</div><div class="overview-topflop-column"><span>Flop 4</span>${flop.map((g,i)=>`<button type="button" data-flop-group="${i}"><span>${esc(g.group||g.name)}</span><b class="metric ${g.band}">${fmtPct(g.metric)}</b></button>`).join('')}</div></div>`;
      regionBox.appendChild(topFlop);
      attachOverviewHint(topFlop.querySelector('summary'),'Abra para consultar os quatro melhores e os quatro menores resultados de grupos no filtro atual.');
      qsa('[data-top-group]',topFlop).forEach(button=>{const g=top[Number(button.dataset.topGroup)];attachOverviewHint(button,overviewBreakdown(g,process),()=>openOverviewDrill(process,g.region,'search',g));});
      qsa('[data-flop-group]',topFlop).forEach(button=>{const g=flop[Number(button.dataset.flopGroup)];attachOverviewHint(button,overviewBreakdown(g,process),()=>openOverviewDrill(process,g.region,'search',g));});
    });
  }

  function renderOverview() {
    if (!state.data) return;
    renderOverviewFilters();
    const processOrder = ['conectividade', 'dda', 'battery_check', 'ltsm'];
    const processData = Object.fromEntries(processOrder.map((process) => [process, overviewProcessData(process)]));
    const targetRows = processOrder.map((process) => ({process, meta:state.data.processes[process], row:processData[process].total})).filter((item) => item.meta?.target != null && item.row);
    const goalsMet = targetRows.filter((item) => item.row.band === 'good').length;
    $('overviewGoalCount').textContent = targetRows.length ? `${goalsMet} de ${targetRows.length}` : '–';
    $('overviewGoalLabel').textContent = targetRows.length ? 'processos com meta no objetivo' : 'nenhum processo com meta definida';

    $('overviewCards').innerHTML = processOrder.map((process) => {
      const meta = state.data.processes[process], data=processData[process], row=data.total, labels=overviewSelectionLabels(process);
      if (!meta || !row) return `<article class="overview-card overview-card-empty" style="--card-color:${meta?.color || '#7a7f87'};--card-soft:${processSoftColors[process] || '#eceef1'}"><div class="overview-card-head"><div><p class="eyebrow">PROCESSO</p><h3>${esc(meta?.name || process)}</h3></div><span class="status-pill neutral">Sem dados</span></div><p class="overview-empty-text">Nenhum resultado válido foi encontrado para os meses e regionais selecionados.</p></article>`;
      const regionalRows=data.regions.filter((item)=>item.metric!=null), regionalGoal=regionalRows.filter((item)=>item.band==='good').length;
      const targetText = `Meta ${fmtPct(meta.target)}`, meter=Math.max(0,Math.min(100,row.metric*100));
      const marker=`<i style="left:${Math.max(0,Math.min(100,meta.target*100))}%" title="Meta ${fmtPct(meta.target)}"></i>`;
      const regionalText=`${regionalGoal} de ${regionalRows.length} no objetivo`;
      return `<article class="overview-card" data-overview-process="${process}" style="--card-color:${meta.color};--card-soft:${processSoftColors[process] || '#eceef1'}">
        <div class="overview-card-head"><div><p class="eyebrow">PROCESSO</p><h3>${esc(meta.name)}</h3></div><span class="status-pill ${row.band}">${bandLabel(row.band)}</span></div>
        <div class="overview-result"><strong class="metric ${row.band}">${fmtPct(row.metric)}</strong><span>${targetText}</span></div>
        <div class="overview-meter" aria-label="Resultado ${fmtPct(row.metric)}"><span style="width:${meter}%"></span>${marker}</div>
        <div class="overview-meta"><div><span>Período</span><strong>${labels.period}</strong></div><div><span>Fotografia</span><strong>${labels.photo}</strong></div><div><span>Volume</span><strong>${fmtInt(row.denominator)} chassis</strong></div><div><span>Comparação</span><strong class="delta-flat">Consultar evolução</strong></div></div>
        <div class="overview-components">${overviewComponentMarkup(process,row,meta)}</div>
        <div class="overview-regional"><div><span>Regionais</span><strong>${regionalText}</strong></div></div>
        <button type="button" class="overview-open" data-open-process="${process}">Abrir ${esc(meta.name)} <span>→</span></button>
      </article>`;
    }).join('');
    enhanceOverview();
    qsa('[data-open-process]', $('overviewCards')).forEach((button) => button.addEventListener('click', () => openOverviewDrill(button.dataset.openProcess)));
  }

  function updateSnapshotToggle() {
    const snapshots = effectiveSnapshots(state.process, state.period);
    state.snapshot = preferredSnapshot(state.process, state.period, state.snapshot) || 'ultimo_dia';
    $('snapshotToggle').innerHTML = snapshots.map((snapshot) => `<button type="button" class="${snapshot === state.snapshot ? 'active' : ''}" data-snapshot="${snapshot}">${snapshotShort(snapshot, state.period)}${awaitsOfficial(state.process,state.period) ? ' · D+15 pendente' : ''}</button>`).join('') || '<button type="button" class="active">Sem dados</button>';
    qsa('[data-snapshot]', $('snapshotToggle')).forEach((button) => button.addEventListener('click', () => {
      state.snapshot = button.dataset.snapshot;
      state.selectedEntity = null;
      qsa('[data-snapshot]', $('snapshotToggle')).forEach((item) => item.classList.toggle('active', item === button));
      renderAll();
    }));
  }

  function renderRegionChips() {
    $('regionChips').innerHTML = state.data.regions.map((region) => `<button type="button" class="filter-chip ${state.regions.has(region) ? 'active' : ''}" data-region="${region}">${region}</button>`).join('');
    qsa('[data-region]', $('regionChips')).forEach((button) => button.addEventListener('click', () => {
      const region = button.dataset.region;
      if (state.regions.has(region)) {
        if (state.regions.size === 1) { toast('Mantenha ao menos uma regional selecionada.'); return; }
        state.regions.delete(region);
      } else state.regions.add(region);
      state.selectedEntity = null;
      button.classList.toggle('active', state.regions.has(region));
      renderAll();
    }));
  }

  function activeRows(level) {
    return state.data.metrics.filter((row) => row.process === state.process && row.period === state.period && row.snapshot === state.snapshot && (!level || row.level === level));
  }

  function bandFor(process, metric) {
    if (metric == null) return 'neutral';
    const meta = state.data.processes[process];
    if (meta.target == null) return 'neutral';
    if (process === 'dda') return metric >= meta.target ? 'good' : metric >= meta.attention ? 'attention' : 'bad';
    return metric >= meta.target ? 'good' : 'bad';
  }

  function combine(rows, process = state.process) {
    if (!rows.length) return null;
    const result = {process, period:rows.at(-1).period, snapshot:rows.at(-1).snapshot, level:'Brasil', name:'Seleção', numerator:0, denominator:0, metric:null, components:{}};
    if (process === 'dda') {
      ['reception', 'preparation', 'delivery'].forEach((module) => {
        const numerator = rows.reduce((sum, row) => sum + (row.components?.[module]?.numerator || 0), 0);
        const denominator = rows.reduce((sum, row) => sum + (row.components?.[module]?.denominator || 0), 0);
        const metric = denominator ? numerator / denominator : null;
        result.components[module] = {numerator, denominator, metric, band:bandFor(process, metric)};
      });
      const rates = Object.values(result.components).map((item) => item.metric);
      result.metric = rates.every((value) => value != null) ? rates.reduce((sum, value) => sum + value, 0) / rates.length : null;
      result.denominator = rows.reduce((sum, row) => sum + (row.denominator || 0), 0);
      result.band = bandFor(process, result.metric);
      return result;
    }
    rows.forEach((row) => {
      result.numerator += row.numerator || 0;
      result.denominator += row.denominator || 0;
      Object.entries(row.components || {}).forEach(([key, value]) => { result.components[key] = (result.components[key] || 0) + value; });
    });
    result.metric = result.denominator ? result.numerator / result.denominator : null;
    result.band = bandFor(process, result.metric);
    return result;
  }

  function selectedTotal() {
    const rows = activeRows('Regional').filter(selectedRegions);
    if (state.regions.size === state.data.regions.length) return activeRows('Brasil')[0] || combine(rows);
    return combine(rows);
  }

  function renderAll() {
    renderYtdCard();
    renderPerformance();
    renderSnapshotHistory();
    renderTimeline();
    renderRanking();
    renderTopFlop();
    renderSearch();
    renderChassis();
  }

  function ytdRowForProcess(process) {
    const direct = state.data.ytd?.[process];
    if (Array.isArray(direct)) return direct.find((row) => row.level === 'Brasil') || direct[0] || null;
    if (direct) return direct;
    return state.data.metrics.find((row) => row.process === process && row.level === 'Brasil' && ['ytd', 'ytd_atual', 'ytdc'].includes(String(row.snapshot || '').toLowerCase())) || null;
  }

  function renderYtdCard() {
    const card = $('ytdLiveCard');
    const supported = ['conectividade', 'ltsm'].includes(state.process);
    card.hidden = !supported;
    if (!supported) return;
    const row = ytdRowForProcess(state.process);
    const year = dataReferencePeriod().split('-')[0] || '–';
    if (!row) {
      card.className = 'ytd-live-card empty';
      card.innerHTML = `<div class="ytd-heading"><span>VISÃO ANUAL DINÂMICA</span><h3>YTD ${year} atualizado</h3><p>Posição extraída no dia, independente das bases mensais congeladas.</p></div><div class="ytd-result"><span>Resultado YTD</span><strong>Aguardando a base YTD deste processo</strong><p>Este espaço não soma os fechamentos mensais.</p></div>`;
      return;
    }
    card.className = 'ytd-live-card';
    const meta = state.data.processes[state.process];
    card.innerHTML = `<div class="ytd-heading"><span>VISÃO ANUAL DINÂMICA</span><h3>YTD ${year} atualizado</h3><p>Resultado extraído no dia, sem somar as fotografias congeladas.</p></div><div><span>Resultado YTD</span><strong class="metric ${bandFor(state.process, row.metric)}">${fmtPct(row.metric)}</strong></div><div><span>Volume</span><strong>${fmtInt(row.denominator)} chassis</strong></div><div><span>Objetivo</span><strong>${meta.target == null ? 'Sem meta' : fmtPct(meta.target)}</strong></div>`;
  }

  function renderPerformance() {
    const total = selectedTotal();
    const rows = activeRows('Regional').filter(selectedRegions).sort((a, b) => a.name.localeCompare(b.name));
    const scope = state.regions.size === state.data.regions.length ? 'Brasil' : [...state.regions].sort().join(' + ');
    $('performancePeriodTitle').textContent = `${processMeta().name} · ${fmtPeriod(state.period)} · ${snapshotLabel(state.snapshot, state.period)}`;
    $('performanceRangeNote').textContent = (awaitsOfficial(state.process,state.period) ? 'D+15 pendente: utilizando a base do último dia. ' : '') + (processMeta().target == null ? 'Indicador sem objetivo definido' : `Objetivo do processo: ${fmtPct(processMeta().target)}`);
    $('performanceTableTitle').textContent = `${processMeta().name} · Desempenho Brasil e Regional`;
    $('regionalTable').innerHTML = tableHead('Regional') + `<tbody>${total ? resultRow(total, 'Brasil (Total geral)', true) : ''}${rows.map((row) => resultRow(row, row.name)).join('')}</tbody>`;
  }

  function renderSnapshotScopeControl() {
    const select = $('snapshotScopeSelect');
    if (!select || !state.data) return;
    const scopes = ['Brasil', ...(state.data.regions || [])];
    if (!scopes.includes(state.snapshotScope)) state.snapshotScope = 'Brasil';
    select.innerHTML = scopes.map((scope) => `<option value="${esc(scope)}">${esc(scope === 'Brasil' ? 'Brasil · Total geral' : `Regional ${scope}`)}</option>`).join('');
    select.value = state.snapshotScope;
  }

  function snapshotHistoryRow(period, snapshot) {
    const level = state.snapshotScope === 'Brasil' ? 'Brasil' : 'Regional';
    return state.data.metrics.find((row) => {
      if (row.process !== state.process || row.period !== period || row.snapshot !== snapshot || row.level !== level) return false;
      return level === 'Brasil' ? true : row.region === state.snapshotScope || row.name === state.snapshotScope;
    }) || null;
  }

  function snapshotExtractionDate() {
    const date = new Date(state.data.generated_at);
    return Number.isNaN(date.getTime()) ? 'extração mais recente' : `extraído em ${date.toLocaleDateString('pt-BR')}`;
  }

  function snapshotMetricCell(row, missingText = 'Não disponível') {
    if (!row || row.metric == null) return `<td class="snapshot-na">–<small>${esc(missingText)}</small></td>`;
    return `<td class="metric ${bandFor(state.process, row.metric)}">${fmtPct(row.metric)}<small>${fmtInt(row.denominator)} chassis${row.provisional ? ' · último dia; D+15 pendente' : ''}</small></td>`;
  }

  function snapshotDeltaCell(value, missingText = 'Sem comparação') {
    return value == null
      ? `<td class="snapshot-na">–<small>${esc(missingText)}</small></td>`
      : `<td class="${deltaClass(value)}">${fmtPp(value)}</td>`;
  }

  function drawSnapshotHistoryChart(comparisons, series) {
    const element = $('snapshotHistoryChart');
    if (!element) return;
    if (!comparisons.length) {
      element.innerHTML = '<div class="empty-state">Sem meses disponíveis para comparação.</div>';
      return;
    }
    const width = 1080, height = 300, padding = {left:52, right:24, top:24, bottom:42};
    const x = (index) => padding.left + (comparisons.length === 1 ? (width - padding.left - padding.right) / 2 : index * (width - padding.left - padding.right) / (comparisons.length - 1));
    const y = (value) => padding.top + (1 - Math.max(0, Math.min(1, value ?? 0))) * (height - padding.top - padding.bottom);
    let grid = '';
    [0, .25, .5, .75, 1].forEach((value) => {
      grid += `<line class="grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(value)}" y2="${y(value)}"/><text x="${padding.left - 9}" y="${y(value) + 4}" text-anchor="end">${value * 100}%</text>`;
    });
    const selectedIndex = comparisons.findIndex((item) => item.period === state.period);
    const selectedMark = selectedIndex < 0 ? '' : `<line x1="${x(selectedIndex)}" x2="${x(selectedIndex)}" y1="${padding.top}" y2="${height - padding.bottom}" stroke="rgba(0,0,0,.10)" stroke-width="20"/>`;
    const target = processMeta().target;
    const targetLine = target == null ? '' : `<line x1="${padding.left}" x2="${width - padding.right}" y1="${y(target)}" y2="${y(target)}" stroke="#111" stroke-dasharray="6 5"/><text x="${width - padding.right}" y="${y(target) - 7}" text-anchor="end">Meta ${fmtPct(target)}</text>`;
    const seriesMarkup = series.map((definition) => {
      const points = comparisons.map((item, index) => ({index, value:item[definition.key]?.metric})).filter((point) => point.value != null);
      if (!points.length) return '';
      const polyline = points.map((point) => `${x(point.index)},${y(point.value)}`).join(' ');
      return `<polyline fill="none" stroke="${definition.color}" stroke-width="3" ${definition.dash ? `stroke-dasharray="${definition.dash}"` : ''} points="${polyline}"/>${points.map((point) => `<circle cx="${x(point.index)}" cy="${y(point.value)}" r="${comparisons[point.index].period === state.period ? 6 : 4.5}" fill="${definition.color}" stroke="#fff" stroke-width="2"><title>${esc(definition.label)}${comparisons[point.index][definition.key]?.provisional ? ' (último dia; D+15 pendente)' : ''} · ${fmtPeriod(comparisons[point.index].period)} · ${fmtPct(point.value)}</title></circle>`).join('')}`;
    }).join('');
    const monthLabels = comparisons.map((item, index) => `<text x="${x(index)}" y="${height - 14}" text-anchor="middle" font-weight="${item.period === state.period ? '900' : '600'}">${fmtMonthShort(item.period)}</text>`).join('');
    element.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Comparação das fotografias mensais">${grid}${selectedMark}${targetLine}${seriesMarkup}${monthLabels}</svg>`;
  }

  function renderSnapshotHistory() {
    if (!state.data || !$('snapshotHistoryTable')) return;
    renderSnapshotScopeControl();
    const periods = state.data.availability[state.process]?.periods || [];
    const supportsD15 = state.process !== 'conectividade';
    const supportsYtd = ['conectividade', 'ltsm'].includes(state.process);
    $('snapshotHistoryNote').innerHTML = '<span>i</span><p>' + (state.process === 'conectividade' ? '<strong>YTD mais atual</strong> mostra cada mês recalculado pela última base anual recebida, comparado ao último dia. O mês atual usa a última parcial. Conectividade não utiliza D+15.' : supportsYtd ? '<strong>YTD mais atual</strong> mostra cada mês recalculado pela última base anual recebida. O mês atual usa a última parcial. D+15 pendente usa o último dia provisoriamente; a origem permanece identificada.' : `${processMeta().name} compara último dia e D+15. O mês atual usa a última parcial. Enquanto o D+15 não estiver disponível, exibimos o último dia identificado como provisório.`) + '</p>';
    const comparisons = periods.map((period) => ({
      period,
      lastDay:isCurrentPeriod(period) ? snapshotHistoryRow(period, preferredSnapshot(state.process,period)) : snapshotHistoryRow(period, 'ultimo_dia'),
      d15:!isCurrentPeriod(period) && supportsD15 ? (snapshotHistoryRow(period, 'oficial') || provisionalRow(snapshotHistoryRow(period, 'ultimo_dia'))) : null,
      ytd:supportsYtd ? snapshotHistoryRow(period, 'ytd_atual') : null
    }));
    const selected = comparisons.find((item) => item.period === state.period) || comparisons[comparisons.length - 1] || {period:state.period, lastDay:null, d15:null, ytd:null};
    const latestAvailable = selected.ytd || selected.d15 || selected.lastDay;
    const totalDelta = !latestAvailable?.provisional && !isCurrentPeriod(selected.period) && selected.lastDay?.metric != null && latestAvailable?.metric != null ? latestAvailable.metric - selected.lastDay.metric : null;
    const cards = [
      {label:isCurrentPeriod(selected.period) ? 'Mês atual · parcial' : 'Último dia do mês', row:selected.lastDay, color:'#6f747a', missing:isCurrentPeriod(selected.period) ? 'Mês ainda em andamento' : 'Base não disponível'},
      {label:'Fechamento D+15', row:selected.d15, color:'#c3a400', missing:supportsD15 ? (isCurrentPeriod(selected.period) ? 'Ainda não aplicável' : 'Base não disponível') : 'Não se aplica'},
      {label:'YTD mais atual', row:selected.ytd, color:processMeta().color, missing:supportsYtd ? 'Base YTD não disponível' : 'Não se aplica'},
      {label:'Variação total', delta:totalDelta, color:'#111', missing:isCurrentPeriod(selected.period) ? 'Aguardando fechamento' : 'Sem fotografias comparáveis'}
    ];
    $('snapshotSummaryCards').innerHTML = cards.filter((card) => !(card.label === 'Fechamento D+15' && !supportsD15) && !(card.label === 'YTD mais atual' && !supportsYtd)).map((card) => {
      const available = card.row?.metric != null || card.delta != null;
      const value = card.delta != null ? fmtPp(card.delta) : card.row?.metric != null ? fmtPct(card.row.metric) : 'Indisponível';
      const valueClass = card.delta != null ? deltaClass(card.delta) : card.row ? `metric ${bandFor(state.process, card.row.metric)}` : '';
      const detail = card.row ? `${fmtInt(card.row.denominator)} chassis${card.row.provisional ? ' · último dia; D+15 pendente' : ''}` : card.delta != null ? 'Da primeira à fotografia mais recente' : card.missing;
      return `<article class="snapshot-summary-card ${available ? '' : 'unavailable'}" style="--snapshot-color:${card.color}"><span>${esc(card.label)}</span><strong class="${valueClass}">${value}</strong><small>${esc(detail)}</small></article>`;
    }).join('');

    const extraction = snapshotExtractionDate();
    $('snapshotHistoryTitle').textContent = `${processMeta().name} · ${state.snapshotScope} · ${fmtPeriod(selected.period)}`;
    const series = [
      {key:'lastDay', label:'Último dia / mês atual parcial', color:'#6f747a'},
      ...(supportsD15 ? [{key:'d15', label:'Fechamento D+15', color:'#c3a400'}] : []),
      ...(supportsYtd ? [{key:'ytd', label:`YTD mais atual · ${extraction}`, color:processMeta().color, dash:'8 5'}] : [])
    ];
    $('snapshotHistoryLegend').innerHTML = series.map((item) => `<span class="snapshot-legend-item"><i style="--legend-color:${item.color}"></i>${esc(item.label)}</span>`).join('');

    let head = '<thead><tr><th>Mês de referência</th><th>Último dia / parcial</th>';
    if (supportsD15) head += '<th>Fechamento D+15</th>';
    if (supportsYtd) head += '<th>YTD mais atual</th>';
    if (supportsD15) head += '<th>Δ D+15 × último dia</th>';
    if (supportsD15 && supportsYtd) head += '<th>Δ YTD × D+15</th>';
    if (supportsYtd) head += '<th>Δ YTD × último dia</th>';
    head += '</tr></thead>';
    const body = comparisons.map((item) => {
      const deltaD15 = !item.d15?.provisional && item.lastDay?.metric != null && item.d15?.metric != null ? item.d15.metric - item.lastDay.metric : null;
      const deltaYtdD15 = !item.d15?.provisional && item.d15?.metric != null && item.ytd?.metric != null ? item.ytd.metric - item.d15.metric : null;
      const deltaYtdLast = !isCurrentPeriod(item.period) && item.lastDay?.metric != null && item.ytd?.metric != null ? item.ytd.metric - item.lastDay.metric : null;
      let cells = snapshotMetricCell(item.lastDay, isCurrentPeriod(item.period) ? 'Mês em andamento' : 'Base não encontrada');
      if (supportsD15) cells += snapshotMetricCell(item.d15, isCurrentPeriod(item.period) ? 'Ainda não aplicável' : 'Base não encontrada');
      if (supportsYtd) cells += snapshotMetricCell(item.ytd, 'Base YTD não encontrada');
      if (supportsD15) cells += snapshotDeltaCell(deltaD15, isCurrentPeriod(item.period) ? 'Ainda não aplicável' : (item.d15?.provisional ? 'D+15 pendente' : 'Sem par de bases'));
      if (supportsD15 && supportsYtd) cells += snapshotDeltaCell(deltaYtdD15, isCurrentPeriod(item.period) ? 'Ainda não aplicável' : (item.d15?.provisional ? 'D+15 pendente' : 'Sem par de bases'));
      if (supportsYtd) cells += snapshotDeltaCell(deltaYtdLast, isCurrentPeriod(item.period) ? 'Aguardando fechamento' : (item.d15?.provisional ? 'D+15 pendente' : 'Sem par de bases'));
      return `<tr class="${item.period === state.period ? 'current-period' : ''}"><td>${fmtPeriod(item.period)}<small>${isCurrentPeriod(item.period) ? 'mês em andamento' : 'mês encerrado'}</small></td>${cells}</tr>`;
    }).join('');
    $('snapshotHistoryTable').innerHTML = head + `<tbody>${body || '<tr><td colspan="7">Nenhum mês disponível.</td></tr>'}</tbody>`;
    drawSnapshotHistoryChart(comparisons, series);
  }

  function summaryMarkup(row, scope) {
    const delta = row.closing_delta;
    const deltaText = state.process === 'conectividade' ? 'D+15 não se aplica' : isCurrentPeriod(state.period) ? 'Mês atual em andamento' : delta == null ? 'Sem comparação entre fotografias' : `Variação D+15: ${fmtPp(delta)}`;
    let cells;
    if (state.process === 'dda') {
      const labels = {reception:'Recepção', preparation:'Preparação', delivery:'Entrega'};
      cells = Object.entries(labels).map(([key, label]) => {
        const component = row.components?.[key] || {};
        return `<div class="stat-cell"><span>${label}</span><strong class="metric ${component.band || 'neutral'}">${fmtPct(component.metric)}</strong><small>${fmtInt(component.numerator)} de ${fmtInt(component.denominator)}</small></div>`;
      });
      cells.push(`<div class="stat-cell"><span>Chassis</span><strong>${fmtInt(row.denominator)}</strong><small>volume elegível</small></div>`);
    } else {
      cells = processMeta().statuses.map((status) => {
        const count = row.components?.[status] || 0;
        const share = row.denominator ? count / row.denominator : null;
        return `<div class="stat-cell"><span>${esc(status)}</span><strong>${fmtInt(count)}</strong><small>${fmtPct(share)} do total</small></div>`;
      });
      cells.push(`<div class="stat-cell"><span>Total</span><strong>${fmtInt(row.denominator)}</strong><small>chassis avaliados</small></div>`);
    }
    return `<article class="hero-score"><div class="score-heading"><h3>${esc(scope)}</h3><span class="status-pill ${row.band}">${bandLabel(row.band)}</span></div><div class="score-value metric ${row.band}">${fmtPct(row.metric)}</div><div class="score-context"><span>${fmtPeriod(state.period)}</span><span>${snapshotLabel(state.snapshot, state.period)}</span><span>${deltaText}</span></div></article><article class="breakdown-card"><div class="breakdown-head"><h3>Composição do indicador</h3><span>${processMeta().target == null ? 'Sem objetivo definido' : `Objetivo ${fmtPct(processMeta().target)}`}</span></div><div class="breakdown-grid">${cells.join('')}</div></article>`;
  }

  function tableHead(nameLabel) {
    if (state.process === 'dda') return `<thead><tr><th>${nameLabel}</th><th>Rec. OK/Total</th><th>Recepção</th><th>Prep. OK/Total</th><th>Preparação</th><th>Ent. OK/Total</th><th>Entrega</th><th>DDA Total</th><th>Chassis</th></tr></thead>`;
    if (state.process === 'conectividade') return `<thead><tr><th>${nameLabel}</th><th>Pareado</th><th>Pareado depois</th><th>Total Pareado</th><th>Não pareado</th><th>Total chassis</th><th>Total Pareado (%)</th></tr></thead>`;
    const resultLabel = state.process === 'ltsm' ? 'Total Feito (%)' : state.process === 'battery_check' ? 'Total OK (%)' : 'Resultado';
    return `<thead><tr><th>${nameLabel}</th>${processMeta().statuses.map((status) => `<th>${esc(status)}</th>`).join('')}<th>Total</th><th>${resultLabel}</th></tr></thead>`;
  }

  function resultCells(row) {
    if (state.process === 'dda') {
      const components = row.components || {};
      const output = [];
      ['reception', 'preparation', 'delivery'].forEach((module) => {
        const item = components[module] || {};
        output.push({text:`${fmtInt(item.numerator)}/${fmtInt(item.denominator)}`});
        output.push({text:fmtPct(item.metric), metric:true, band:item.band || 'neutral'});
      });
      output.push({text:fmtPct(row.metric), metric:true, band:row.band});
      output.push({text:fmtInt(row.denominator)});
      return output;
    }
    if (state.process === 'conectividade') {
      const paired = firstComponentCount(row, ['Pareado', 'Conectado', 'Success']);
      const later = firstComponentCount(row, ['Pareado depois', 'Conectado depois', 'Paired later']);
      const notPaired = firstComponentCount(row, ['Não pareado', 'Não conectado']);
      return [
        {text:fmtInt(paired)},
        {text:fmtInt(later)},
        {text:fmtInt(paired + later)},
        {text:fmtInt(notPaired)},
        {text:fmtInt(row.denominator)},
        {text:fmtPct(row.metric), metric:true, band:row.band}
      ];
    }
    return [
      ...processMeta().statuses.map((status) => ({text:fmtInt(row.components?.[status] || 0)})),
      {text:fmtInt(row.denominator)},
      {text:fmtPct(row.metric), metric:true, band:row.band}
    ];
  }

  function resultRow(row, label, total = false) {
    return `<tr class="${total ? 'total' : ''}"><td>${esc(label)}</td>${resultCells(row).map((cell) => `<td class="${cell.metric ? `metric ${cell.band}` : ''}">${cell.text}</td>`).join('')}</tr>`;
  }

  function snapshotForPeriod(period) {
    return preferredSnapshot(state.process, period, period === state.period ? state.snapshot : null);
  }

  function entityKey(row, level = state.entityLevel) {
    return level === 'Grupo' ? `${row.region}|${row.group || row.name}` : `${row.bir}`;
  }

  function entityName(row, level = state.entityLevel) {
    return level === 'Grupo' ? (row.group || row.name) : (row.dealer || row.name);
  }

  function timelineMetricDefinitions(process = state.process) {
    const definitions = {
      conectividade: [
        {key:'result', label:'Total Pareado'},
        {key:'paired', label:'Pareado'},
        {key:'paired_later', label:'Pareado depois'},
        {key:'not_paired', label:'Não pareado'}
      ],
      ltsm: [
        {key:'result', label:'On Time + Done Late'},
        {key:'on_time', label:'On Time'},
        {key:'done_late', label:'Done Late'},
        {key:'not_done', label:'Not Done'}
      ],
      battery_check: [
        {key:'result', label:'OK'},
        {key:'ko', label:'NOK'}
      ],
      dda: [
        {key:'result', label:'DDA Total'},
        {key:'reception', label:'Recepção'},
        {key:'preparation', label:'Preparação'},
        {key:'delivery', label:'Entrega'}
      ]
    };
    return definitions[process] || [{key:'result', label:'Resultado'}];
  }

  function componentMetric(row, key, process = state.process) {
    if (!row) return null;
    if (key === 'result') return row.metric;
    if (process === 'dda') return row.components?.[key]?.metric ?? null;
    const denominator = row.denominator || 0;
    if (!denominator) return null;
    const keyMap = {
      conectividade: {
        paired:['Pareado', 'Conectado', 'Success'],
        paired_later:['Pareado depois', 'Conectado depois', 'Paired later'],
        not_paired:['Não pareado', 'Não conectado']
      },
      ltsm: {on_time:['On Time'], done_late:['Done Late'], not_done:['Not Done']},
      battery_check: {ok:['OK', 'DIAG PREPA VN'], ko:['NOK', 'KO']}
    };
    const keys = keyMap[process]?.[key] || [];
    return keys.length ? firstComponentCount(row, keys) / denominator : null;
  }

  function componentTargetRule(process, key) {
    const meta = state.data.processes[process];
    if (!meta || meta.target == null) return null;
    if (process === 'dda') return {direction:'higher', target:meta.target, attention:meta.attention};
    if (key === 'result' || key === 'ok') return {direction:'higher', target:meta.target, attention:meta.attention};
    if ((process === 'conectividade' && key === 'not_paired') || (process === 'battery_check' && key === 'ko') || (process === 'ltsm' && key === 'not_done')) return {direction:'lower', target:1 - meta.target, attention:null};
    return null;
  }

  function metricBandForComponent(process, key, value) {
    if (value == null) return 'neutral';
    const rule = componentTargetRule(process, key);
    if (!rule) return 'neutral';
    if (rule.direction === 'lower') return value <= rule.target ? 'good' : 'bad';
    if (value >= rule.target) return 'good';
    if (rule.attention != null && value >= rule.attention) return 'attention';
    return 'bad';
  }

  function componentBand(row, key, process = state.process) {
    return metricBandForComponent(process, key, componentMetric(row, key, process));
  }

  function renderTimelineControls() {
    const definitions = timelineMetricDefinitions();
    const periods = state.data.availability[state.process]?.periods || [];
    const currentPeriod = periods.includes(dataReferencePeriod()) ? dataReferencePeriod() : periods.at(-1);
    const allowed = new Set(definitions.map((item) => item.key));
    state.timelineComponents = new Set([...state.timelineComponents].filter((key) => allowed.has(key)));
    if (!state.timelineComponents.size) state.timelineComponents.add('result');
    state.timelinePeriods = new Set([...state.timelinePeriods].filter((period) => periods.includes(period)));
    if (!state.timelinePeriods.size && periods.length) state.timelinePeriods = new Set([currentPeriod]);
    const previousSort = $('timelineSort').value;
    $('timelineSort').innerHTML = definitions.map((item) => `<option value="metric:${item.key}">${esc(item.label)}</option>`).join('') + '<option value="evolution">Evolução no período</option><option value="volume">Volume selecionado</option>';
    $('timelineSort').value = [...$('timelineSort').options].some((option) => option.value === previousSort) ? previousSort : 'metric:result';
    const allSelected = periods.length > 0 && periods.every((period) => state.timelinePeriods.has(period));
    const onlyCurrent = state.timelinePeriods.size === 1 && state.timelinePeriods.has(currentPeriod);
    $('timelineMonthChips').innerHTML = periods.map((period) => `<button type="button" class="timeline-month-chip ${state.timelinePeriods.has(period) ? 'active' : ''}" data-timeline-period="${period}">${fmtMonthShort(period).split('/')[0]}</button>`).join('') + `<button type="button" class="timeline-month-action ${allSelected ? 'active' : ''}" data-timeline-period-action="all">Todos</button><button type="button" class="timeline-month-action ${onlyCurrent ? 'active' : ''}" data-timeline-period-action="current">Somente atual</button>`;
    qsa('[data-timeline-period]', $('timelineMonthChips')).forEach((button) => button.addEventListener('click', () => {
      const period = button.dataset.timelinePeriod;
      if (state.timelinePeriods.has(period)) {
        if (state.timelinePeriods.size === 1) { toast('Mantenha ao menos um mês selecionado.'); return; }
        state.timelinePeriods.delete(period);
      } else state.timelinePeriods.add(period);
      renderTimelineControls();
      renderTimeline();
    }));
    qsa('[data-timeline-period-action]', $('timelineMonthChips')).forEach((button) => button.addEventListener('click', () => {
      state.timelinePeriods = button.dataset.timelinePeriodAction === 'current' ? new Set(currentPeriod ? [currentPeriod] : []) : new Set(periods);
      renderTimelineControls();
      renderTimeline();
    }));
    $('timelineComponentChips').innerHTML = definitions.map((item) => `<button type="button" class="timeline-component-chip ${state.timelineComponents.has(item.key) ? 'active' : ''}" data-timeline-component="${item.key}">${esc(item.label)}</button>`).join('');
    qsa('[data-timeline-component]', $('timelineComponentChips')).forEach((button) => button.addEventListener('click', () => {
      const key = button.dataset.timelineComponent;
      if (state.timelineComponents.has(key)) {
        if (state.timelineComponents.size === 1) { toast('Mantenha ao menos um componente na linha do tempo.'); return; }
        state.timelineComponents.delete(key);
      } else state.timelineComponents.add(key);
      button.classList.toggle('active', state.timelineComponents.has(key));
      renderTimeline();
    }));
  }

  function accumulatedMetric(rows, key, process = state.process) {
    if (!rows.length) return null;
    if (process === 'dda') {
      const moduleMetric = (module) => {
        const numerator = rows.reduce((sum, row) => sum + (row.components?.[module]?.numerator || 0), 0);
        const denominator = rows.reduce((sum, row) => sum + (row.components?.[module]?.denominator || 0), 0);
        return denominator ? numerator / denominator : null;
      };
      if (key !== 'result') return moduleMetric(key);
      const values = ['reception','preparation','delivery'].map(moduleMetric);
      return values.every((value) => value != null) ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    }
    const denominator = rows.reduce((sum, row) => sum + (row.denominator || 0), 0);
    if (!denominator) return null;
    if (key === 'result') return rows.reduce((sum, row) => sum + (row.numerator || 0), 0) / denominator;
    const numerator = rows.reduce((sum, row) => sum + (componentMetric(row, key, process) || 0) * (row.denominator || 0), 0);
    return numerator / denominator;
  }

  function renderTimeline() {
    if (!state.data) return;
    const availablePeriods = state.data.availability[state.process]?.periods || [];
    const periods = availablePeriods.filter((period) => state.timelinePeriods.has(period));
    const definitions = timelineMetricDefinitions();
    const displayed = definitions.filter((item) => state.timelineComponents.has(item.key));
    const sort = $('timelineSort').value || 'metric:result';
    const sortMetric = sort.startsWith('metric:') ? sort.split(':')[1] : 'result';
    const records = [];
    periods.forEach((period) => {
      const snapshot = snapshotForPeriod(period);
      state.data.metrics.filter((row) => row.process === state.process && row.period === period && row.snapshot === snapshot && row.level === state.entityLevel && selectedRegions(row)).forEach((row) => records.push(row));
    });
    const entities = new Map();
    records.forEach((row) => {
      const key = entityKey(row);
      if (!entities.has(key)) entities.set(key, {key, name:entityName(row), region:row.region, group:row.group, bir:row.bir, rows:new Map()});
      entities.get(key).rows.set(row.period, row);
    });
    let items = [...entities.values()].map((item) => {
      const orderedRows = periods.map((period) => item.rows.get(period)).filter(Boolean);
      const values = orderedRows.map((row) => componentMetric(row, sortMetric)).filter((value) => value != null);
      const evolution = values.length > 1 ? values.at(-1) - values[0] : null;
      const accumulated = Object.fromEntries(displayed.map((definition) => [definition.key, accumulatedMetric(orderedRows, definition.key)]));
      return {...item, orderedRows, volume:orderedRows.reduce((sum, row) => sum + (row.denominator || 0), 0), evolution, accumulated, sortValue:accumulatedMetric(orderedRows, sortMetric)};
    });
    const query = $('timelineSearch').value.trim().toLocaleLowerCase('pt-BR');
    if (query) items = items.filter((item) => `${item.name} ${item.region} ${item.group || ''} ${item.bir || ''}`.toLocaleLowerCase('pt-BR').includes(query));
    const order = $('timelineOrder').value;
    const inverseMetric = sort.startsWith('metric:') && componentTargetRule(state.process, sortMetric)?.direction === 'lower';
    const compareNumber = (a, b) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      if (order === 'asc') return inverseMetric ? b - a : a - b;
      return inverseMetric ? a - b : b - a;
    };
    items.sort((a, b) => {
      if (order === 'alpha') return a.name.localeCompare(b.name, 'pt-BR');
      if (sort === 'evolution') return compareNumber(a.evolution, b.evolution) || a.name.localeCompare(b.name, 'pt-BR');
      if (sort === 'volume') return compareNumber(a.volume, b.volume) || a.name.localeCompare(b.name, 'pt-BR');
      return compareNumber(a.sortValue, b.sortValue) || a.name.localeCompare(b.name, 'pt-BR');
    });
    const sortLabel = definitions.find((item) => item.key === sortMetric)?.label || 'Resultado';
    $('timelinePeriodTitle').textContent = `${state.entityLevel} · ${processMeta().name} · ${periods.length} ${periods.length === 1 ? 'mês selecionado' : 'meses selecionados'} · ordenação por ${sortLabel}`;
    const monthGroups = periods.map((period) => `<th colspan="${displayed.length}" class="month-group ${period === state.period ? 'current-column' : ''}">${fmtMonthShort(period)}${isCurrentPeriod(period) ? ' · parcial' : ''}</th>`).join('');
    const monthComponents = periods.map((period) => displayed.map((definition, componentIndex) => `<th class="${period === state.period ? 'current-column ' : ''}${componentIndex === 0 ? 'period-start' : ''}">${esc(definition.label)}</th>`).join('')).join('');
    const accumulatedComponents = displayed.map((definition, componentIndex) => `<th class="accumulated-column ${componentIndex === 0 ? 'accumulated-start' : ''}">${esc(definition.label)}</th>`).join('');
    const head = `<thead><tr><th rowspan="2">#</th><th rowspan="2">${state.entityLevel}</th><th rowspan="2">Regional</th>${monthGroups}<th colspan="${displayed.length}" class="accumulated-group">Acumulado selecionado</th><th rowspan="2">Evolução<small>${esc(sortLabel)}</small></th><th rowspan="2">Volume selecionado</th></tr><tr>${monthComponents}${accumulatedComponents}</tr></thead>`;
    const body = items.map((item, index) => {
      const monthCells = periods.map((period) => displayed.map((definition, componentIndex) => {
        const row = item.rows.get(period);
        const value = componentMetric(row, definition.key);
        return `<td class="metric ${componentBand(row, definition.key)} ${period === state.period ? 'current-column ' : ''}${componentIndex === 0 ? 'period-start' : ''}">${value == null ? '–' : fmtPct(value)}</td>`;
      }).join('')).join('');
      const accumulatedCells = displayed.map((definition, componentIndex) => {
        const value = item.accumulated[definition.key];
        return `<td class="metric ${metricBandForComponent(state.process, definition.key, value)} accumulated-column ${componentIndex === 0 ? 'accumulated-start' : ''}">${value == null ? '–' : fmtPct(value)}</td>`;
      }).join('');
      return `<tr><td>${index + 1}</td><td title="${esc(item.name)}">${esc(item.name)}</td><td>${esc(item.region)}</td>${monthCells}${accumulatedCells}<td class="${deltaClass(item.evolution)}">${fmtPp(item.evolution)}</td><td>${fmtInt(item.volume)}</td></tr>`;
    }).join('');
    const columnCount = 5 + (periods.length + 1) * displayed.length;
    $('timelineTable').innerHTML = head + `<tbody>${body || `<tr><td colspan="${columnCount}">Nenhum grupo ou concessionária encontrado para os filtros informados.</td></tr>`}</tbody>`;
  }

  function deltaClass(value) {
    if (value == null || Math.abs(value) < .000001) return 'delta-flat';
    return value > 0 ? 'delta-up' : 'delta-down';
  }

  function renderTopFlop() {
    if (!state.data) return;
    const rows = activeRows(state.entityLevel).filter((row) => selectedRegions(row) && row.metric != null);
    const top = rows.slice().sort((a, b) => b.metric - a.metric || b.denominator - a.denominator || a.name.localeCompare(b.name)).slice(0, 20);
    const flop = rows.slice().sort((a, b) => a.metric - b.metric || b.denominator - a.denominator || a.name.localeCompare(b.name)).slice(0, 20);
    $('topCardTitle').textContent = `${processMeta().name} · Top 20 ${state.entityLevel}`;
    $('flopCardTitle').textContent = `${processMeta().name} · Flop 20 ${state.entityLevel}`;
    $('topTable').innerHTML = rankingTable(top);
    $('flopTable').innerHTML = rankingTable(flop);
  }

  function rankingTable(rows) {
    const head = `<thead><tr><th>#</th><th>${state.entityLevel}</th><th>Regional</th><th>Volume</th><th>Resultado</th></tr></thead>`;
    const body = rows.map((row, index) => `<tr><td>${index + 1}</td><td>${esc(entityName(row))}</td><td>${esc(row.region)}</td><td>${fmtInt(row.denominator)}</td><td class="metric ${row.band}">${fmtPct(row.metric)}</td></tr>`).join('');
    return head + `<tbody>${body || '<tr><td colspan="5">Sem dados para os filtros selecionados.</td></tr>'}</tbody>`;
  }

  function syntheticChassisRows() {
    const cacheKey = `${state.process}|${state.period}|${state.snapshot}`;
    if (state.chassisCache.has(cacheKey)) return state.chassisCache.get(cacheKey);
    if (Array.isArray(state.data.chassis)) {
      const provided = state.data.chassis.filter((row) => row.process === state.process && row.period === state.period && row.snapshot === state.snapshot);
      state.chassisCache.set(cacheKey, provided);
      return provided;
    }
    if (!state.data.demo_mode) return [];
    const models = ['KARDIAN','BOREAL','KWID','DUSTER','OROCH','KANGOO','KWID E-TECH'];
    const processCode = {conectividade:'C',ltsm:'L',battery_check:'B',dda:'D'}[state.process];
    const [year,month] = state.period.split('-').map(Number);
    const monthDays = new Date(year, month, 0).getDate();
    const rows = [];
    activeRows('Concessionária').forEach((dealerRow, dealerOrder) => {
      const statuses = [];
      if (state.process === 'conectividade') {
        ['Pareado','Pareado depois','Não pareado'].forEach((status) => { for (let index=0; index<(dealerRow.components?.[status] || 0); index+=1) statuses.push({status,detail:status}); });
      } else if (state.process === 'ltsm') {
        ['On Time','Done Late','Not Done'].forEach((status) => { for (let index=0; index<(dealerRow.components?.[status] || 0); index+=1) statuses.push({status,detail:status}); });
      } else if (state.process === 'battery_check') {
        ['OK','NOK'].forEach((status) => { for (let index=0; index<(dealerRow.components?.[status] || 0); index+=1) statuses.push({status,detail:status}); });
      } else {
        for (let index=0; index<dealerRow.denominator; index+=1) {
          const moduleLabels = {reception:'Recepção',preparation:'Preparação',delivery:'Entrega'};
          const checks = Object.entries(moduleLabels).map(([key,label],moduleIndex) => {
            const score=((index*37+dealerOrder*13+moduleIndex*19)%100)/100;
            return {label,ok:score < (dealerRow.components?.[key]?.metric || 0)};
          });
          const completed=checks.filter((item)=>item.ok).length;
          statuses.push({status:completed===3?'Completo':completed===0?'Não realizado':'Parcial',detail:checks.map((item)=>`${item.label}: ${item.ok?'OK':'NOK'}`).join(' · ')});
        }
      }
      statuses.slice(0,dealerRow.denominator).forEach((item,index) => {
        const day=String(1+((index*7+dealerOrder*3)%monthDays)).padStart(2,'0');
        const vin=`93Y${processCode}${state.period.replace('-','').slice(2)}${String(dealerRow.bir).slice(-4)}${String(index+1).padStart(5,'0')}`;
        rows.push({process:state.process,period:state.period,snapshot:state.snapshot,vin,date:`${state.period}-${day}`,status:item.status,detail:item.detail,model:models[(index+dealerOrder)%models.length],region:dealerRow.region,group:dealerRow.group,dealer:dealerRow.dealer,bir:dealerRow.bir});
      });
    });
    state.chassisCache.set(cacheKey,rows);
    return rows;
  }

  function chassisStatusBand(status) {
    if (['Pareado','Pareado depois','On Time','Done Late','OK','Completo'].includes(status)) return 'good';
    if (['Parcial'].includes(status)) return 'attention';
    return 'bad';
  }

  function clearChassisFilters(shouldRender=true) {
    ['chassisStatus','chassisDateFrom','chassisDateTo','chassisRegion','chassisGroup','chassisDealer','chassisVin'].forEach((id) => { if ($(id)) $(id).value=''; });
    if (shouldRender) renderChassis();
  }

  const chassisColumns = ['vin','date','status','detail','model','region','group','dealer','bir'];
  async function loadGithubChassis(key) {
    if (state.chassisCache.has(key)) return state.chassisCache.get(key);
    if (state.chassisPending.has(key)) return state.chassisPending.get(key);
    const task = (async () => {
      if (!state.chassisManifest) {
        const response = await fetch('./data/chassis/manifest.json');
        if (!response.ok) throw new Error('Não foi possível carregar o manifesto de chassis.');
        state.chassisManifest = await response.json();
      }
      const entry = state.chassisManifest.datasets[key];
      if (!entry) return [];
      const [process,period,snapshot] = key.split('|');
      const rows=[];
      for (const part of entry.parts) {
        let response;
        try {
          response=await fetch(part.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) { console.error('Falha ao carregar arquivo de chassis:',part.url,error); throw error; }
        const packed=await response.json();
        const cols=packed.columns || chassisColumns;
        for (const line of packed.rows) {
          const row={process,period,snapshot};
          cols.forEach((column,index)=>row[column]=packed.dictionaries?.[column] ? packed.dictionaries[column][line[index]] : line[index]);
          rows.push(row);
        }
      }
      if (rows.length !== entry.count) throw new Error(`Quantidade de chassis inconsistente: ${key}`);
      state.chassisCache.set(key,rows);
      return rows;
    })();
    state.chassisPending.set(key,task);
    try { return await task; } finally { state.chassisPending.delete(key); }
  }

  async function renderChassis() {
    const request=++state.chassisRequest;
    if (document.body.dataset.mode === 'github-pages') {
      if (!state.data?.chassis_available) {
        $('chassisVisibleCount').textContent='0';
        $('chassisNote').textContent='Os dados de chassis não foram incluídos nesta publicação.';
        $('chassisTable').innerHTML='';
        return;
      }
      const key=`${state.process}|${state.period}|${state.snapshot}`;
      if (!state.chassisCache.has(key)) {
        $('chassisNote').textContent=`Carregando chassis de ${processMeta().name} · ${fmtPeriod(state.period)}...`;
        $('chassisTable').innerHTML='';
        try { await loadGithubChassis(key); }
        catch(error) {
          if(request !== state.chassisRequest || state.view !== 'chassis') return;
          console.error('Falha ao carregar chassis:',error);
          $('chassisNote').textContent='Os chassis não puderam ser carregados.';
          $('chassisTable').innerHTML='<tbody><tr><td><button type="button" id="retryChassis">Tentar novamente</button></td></tr></tbody>';
          $('retryChassis').addEventListener('click',()=>renderChassis());
          return;
        }
      }
      if(request !== state.chassisRequest || state.view !== 'chassis' || key !== `${state.process}|${state.period}|${state.snapshot}`) return;
    }

    if (!state.data || !$('chassisTable')) return;
    if (state.view !== 'chassis') return;
    const rows=syntheticChassisRows();
    const previousStatus=$('chassisStatus').value, previousRegion=$('chassisRegion').value;
    const statuses=[...new Set(rows.map((row)=>row.status))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    $('chassisStatus').innerHTML='<option value="">Todos</option>'+statuses.map((status)=>`<option value="${esc(status)}">${esc(status)}</option>`).join('');
    $('chassisStatus').value=statuses.includes(previousStatus)?previousStatus:'';
    $('chassisRegion').innerHTML='<option value="">Todas</option>'+state.data.regions.map((region)=>`<option value="${region}">${region}</option>`).join('');
    $('chassisRegion').value=state.data.regions.includes(previousRegion)?previousRegion:'';
    const normalize=(value)=>String(value||'').toLocaleLowerCase('pt-BR');
    const status=$('chassisStatus').value, from=$('chassisDateFrom').value, to=$('chassisDateTo').value, region=$('chassisRegion').value;
    const group=normalize($('chassisGroup').value), dealer=normalize($('chassisDealer').value), vin=normalize($('chassisVin').value);
    const filtered=rows.filter((row)=>(!status||row.status===status)&&(!from||row.date>=from)&&(!to||row.date<=to)&&(!region||row.region===region)&&(!group||normalize(row.group).includes(group))&&(!dealer||normalize(`${row.dealer} ${row.bir}`).includes(dealer))&&(!vin||normalize(row.vin).includes(vin)));
    $('chassisVisibleCount').textContent=fmtInt(filtered.length);
    const sourceNote = state.data.demo_mode ? 'Nesta demonstração, os registros são artificiais.' : 'Registros carregados das bases do processo.';
    $('chassisNote').textContent=`${processMeta().name} · ${fmtPeriod(state.period)} · ${snapshotLabel(state.snapshot,state.period)} · ${fmtInt(filtered.length)} de ${fmtInt(rows.length)} chassis. ${sourceNote}`;
    const head='<thead><tr><th>Chassi</th><th>Data</th><th>Status</th><th>Detalhe</th><th>Modelo</th><th>Grupo</th><th>Concessionária</th><th>BIR</th><th>Regional</th></tr></thead>';
    const body=filtered.map((row)=>`<tr><td>${esc(row.vin)}</td><td>${new Date(`${row.date}T12:00:00`).toLocaleDateString('pt-BR')}</td><td><span class="status-pill ${chassisStatusBand(row.status)}">${esc(row.status)}</span></td><td>${esc(row.detail||'–')}</td><td>${esc(row.model||'–')}</td><td>${esc(row.group)}</td><td>${esc(row.dealer)}</td><td>${esc(row.bir)}</td><td>${esc(row.region)}</td></tr>`).join('');
    $('chassisTable').innerHTML=head+`<tbody>${body||'<tr><td colspan="9">Nenhum chassi corresponde aos filtros selecionados.</td></tr>'}</tbody>`;
  }

  function availableEntities() {
    const rows = state.data.metrics.filter((row) => row.process === state.process && row.level === state.entityLevel);
    const map = new Map();
    rows.forEach((row) => {
      const key = entityKey(row);
      if (!map.has(key)) map.set(key, {key, level:state.entityLevel, name:entityName(row), region:row.region, group:row.group, bir:row.bir, dealer:row.dealer});
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderSearch() {
    if (!state.data) return;
    const isGroup = state.entityLevel === 'Grupo';
    $('searchLabel').textContent = isGroup ? 'Nome do grupo' : 'Nome, BIR ou grupo';
    $('entitySearch').placeholder = isGroup ? 'Digite o nome do grupo' : 'Digite concessionária, BIR ou grupo';
    const query = $('entitySearch').value.trim().toLocaleLowerCase('pt-BR');
    const entities = availableEntities();
    const filtered = query ? entities.filter((entity) => `${entity.name} ${entity.group || ''} ${entity.bir || ''}`.toLocaleLowerCase('pt-BR').includes(query)).slice(0, 40) : [];
    $('searchResults').innerHTML = filtered.map((entity) => `<button type="button" class="result-button ${state.selectedEntity?.key === entity.key ? 'selected' : ''}" data-entity-key="${esc(entity.key)}"><strong>${esc(entity.name)}</strong><span>${esc(isGroup ? entity.region : `${entity.bir} · ${entity.group} · ${entity.region}`)}</span></button>`).join('');
    qsa('[data-entity-key]', $('searchResults')).forEach((button) => button.addEventListener('click', () => {
      state.selectedEntity = entities.find((entity) => entity.key === button.dataset.entityKey) || null;
      const rows = historyRowsForEntity(state.selectedEntity);
      state.selectedMonths = new Set(rows.map((row) => row.period));
      renderSearch();
    }));
    if (state.selectedEntity) renderEntityDetail();
    else {
      $('entityDetail').className = 'detail-panel empty-state';
      $('entityDetail').textContent = `Pesquise e selecione ${isGroup ? 'um grupo' : 'uma concessionária'} para abrir o detalhamento.`;
    }
  }

  function historyRowsForEntity(entity) {
    if (!entity) return [];
    const periods = state.data.availability[state.process]?.periods || [];
    return periods.map((period) => {
      const snapshot = snapshotForPeriod(period);
      return state.data.metrics.find((row) => {
        if (row.process !== state.process || row.period !== period || row.snapshot !== snapshot || row.level !== entity.level) return false;
        return entity.level === 'Grupo' ? row.region === entity.region && row.group === entity.group : row.bir === entity.bir;
      }) || null;
    }).filter(Boolean);
  }

  function renderEntityDetail() {
    const entity = state.selectedEntity;
    const rows = historyRowsForEntity(entity);
    const current = rows.find((row) => row.period === state.period) || rows.at(-1);
    const accumulatedRows = rows.filter((row) => state.selectedMonths.has(row.period));
    const accumulated = combine(accumulatedRows, state.process);
    const detail = $('entityDetail');
    detail.className = 'detail-panel';
    const accumulatedLabel = ['conectividade', 'ltsm'].includes(state.process)
      ? 'Acumulado das bases mensais congeladas'
      : 'Acumulado dos meses selecionados';
    const showClosingComparison = state.process !== 'conectividade';
    const tableRows = rows.map((row) => {
      const closingCell = showClosingComparison ? `<td class="${isCurrentPeriod(row.period) ? 'delta-flat' : deltaClass(row.closing_delta)}">${isCurrentPeriod(row.period) ? 'Em andamento' : fmtPp(row.closing_delta)}</td>` : '';
      return `<tr><td>${fmtPeriod(row.period)}</td><td>${snapshotShort(row.snapshot, row.period)}</td><td>${fmtInt(row.denominator)}</td><td class="metric ${row.band}">${fmtPct(row.metric)}</td>${closingCell}</tr>`;
    }).join('');
    detail.innerHTML = `<div class="entity-detail-grid"><aside class="detail-summary"><p class="eyebrow">${esc(entity.region)}${entity.level === 'Concessionária' ? ` · ${esc(entity.group)}` : ''}</p><h3>${esc(entity.name)}</h3>${entity.bir ? `<p class="muted">BIR ${esc(entity.bir)}</p>` : ''}${current ? `<div class="score-value metric ${current.band}">${fmtPct(current.metric)}</div><span class="status-pill ${current.band}">${bandLabel(current.band)}</span><p class="muted">${fmtInt(current.denominator)} chassis · ${fmtPeriod(current.period)}</p>` : '<p>Sem resultado neste processo.</p>'}<div class="month-selector"><span>MESES DO ACUMULADO</span><div class="month-chips">${rows.map((row) => `<button type="button" class="month-chip ${state.selectedMonths.has(row.period) ? 'active' : ''}" data-month="${row.period}">${fmtPeriod(row.period)}</button>`).join('')}</div></div><div class="accumulated">${accumulated ? `<strong>${accumulatedLabel}: ${fmtPct(accumulated.metric)}</strong>${fmtInt(accumulated.denominator)} chassis · ${accumulatedRows.length} ${accumulatedRows.length === 1 ? 'mês' : 'meses'}${['conectividade', 'ltsm'].includes(state.process) ? '<small>Este valor não substitui o YTD atualizado da base anual.</small>' : ''}` : 'Selecione ao menos um mês.'}</div></aside><div><div id="entityChart" class="chart"></div><div class="table-wrap"><table><thead><tr><th>Mês</th><th>Fotografia</th><th>Volume</th><th>Resultado</th>${showClosingComparison ? '<th>Comparação de fechamento</th>' : ''}</tr></thead><tbody>${tableRows}</tbody></table></div></div></div>`;
    drawChart('entityChart', rows, processMeta().target, processMeta().color);
    qsa('[data-month]', detail).forEach((button) => button.addEventListener('click', () => {
      const month = button.dataset.month;
      if (state.selectedMonths.has(month)) {
        if (state.selectedMonths.size === 1) { toast('Mantenha ao menos um mês no acumulado.'); return; }
        state.selectedMonths.delete(month);
      } else state.selectedMonths.add(month);
      renderEntityDetail();
    }));
  }

  function drawChart(id, rows, target, color) {
    const element = $(id);
    if (!element) return;
    if (!rows.length) { element.innerHTML = '<div class="empty-state">Sem histórico disponível.</div>'; return; }
    const width = 900, height = 255, padding = {left:48, right:20, top:24, bottom:40};
    const x = (index) => padding.left + (rows.length === 1 ? (width - padding.left - padding.right) / 2 : index * (width - padding.left - padding.right) / (rows.length - 1));
    const y = (value) => padding.top + (1 - Math.max(0, Math.min(1, value ?? 0))) * (height - padding.top - padding.bottom);
    let grid = '';
    [0, .25, .5, .75, 1].forEach((value) => { grid += `<line class="grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(value)}" y2="${y(value)}"/><text x="${padding.left - 8}" y="${y(value) + 4}" text-anchor="end">${value * 100}%</text>`; });
    const points = rows.map((row, index) => `${x(index)},${y(row.metric)}`).join(' ');
    const targetLine = target == null ? '' : `<line x1="${padding.left}" x2="${width - padding.right}" y1="${y(target)}" y2="${y(target)}" stroke="#111" stroke-dasharray="6 5"/><text x="${width - padding.right}" y="${y(target) - 7}" text-anchor="end">Meta ${fmtPct(target)}</text>`;
    element.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Linha do tempo mensal">${grid}${targetLine}<polyline class="line" style="stroke:${color}" points="${points}"/>${rows.map((row, index) => `<circle class="dot" style="fill:${color}" cx="${x(index)}" cy="${y(row.metric)}" r="5"/><text x="${x(index)}" y="${height - 12}" text-anchor="middle">${fmtPeriod(row.period)}</text><text x="${x(index)}" y="${y(row.metric) - 10}" text-anchor="middle">${fmtPct(row.metric)}</text>`).join('')}</svg>`;
  }

  function openDiagnostics() {
    const dialog = $('diagnosticsDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function renderDiagnostics() {
    const issues = state.data.diagnostics || [];
    const levels = ['critical', 'warning', 'information'];
    $('diagnosticSummary').innerHTML = levels.map((level) => `<div class="diagnostic-card ${level}"><strong>${issues.filter((item) => item.level === level).length}</strong><span>${level === 'critical' ? 'Erros críticos' : level === 'warning' ? 'Avisos' : 'Informações'}</span></div>`).join('');
    $('diagnosticTable').innerHTML = '<thead><tr><th>Nível</th><th>Processo</th><th>Arquivo</th><th>Problema</th><th>Quantidade</th><th>Consequência</th><th>Ação recomendada</th></tr></thead><tbody>' + (issues.map((item) => `<tr><td>${esc(item.level)}</td><td>${esc(item.process)}</td><td>${esc(item.file)}</td><td>${esc(item.message)}</td><td>${fmtInt(item.count)}</td><td>${esc(item.consequence)}</td><td>${esc(item.action)}</td></tr>`).join('') || '<tr><td colspan="7">Nenhuma ocorrência.</td></tr>') + '</tbody>';
    const columns = state.data.column_diagnostics || [];
    $('columnDiagnosticTable').innerHTML = '<thead><tr><th>Fonte</th><th>Campo</th><th>Coluna encontrada</th><th>Letra</th><th>Método</th><th>Status</th><th>Motivo</th></tr></thead><tbody>' + columns.map((item) => `<tr><td>${esc(item.source)}</td><td>${esc(item.label)}</td><td>${esc(item.column)}</td><td>${esc(item.letter)}</td><td>${esc(item.method)}</td><td>${esc(item.status)}</td><td>${esc(item.reason)}</td></tr>`).join('') + '</tbody>';
  }

  async function reloadBases() {
    const promise = fetch('/api/reload', {method:'POST'}).then((response) => response.json());
    pollProgress(promise);
    const result = await promise;
    if (!result.ok) { setProgress(false); toast(result.error || 'Falha ao recarregar.'); return; }
    window.INLINE_PAYLOAD = null;
    state.data = await fetch('/api/dashboard').then((response) => response.json());
    setProgress(false);
    state.selectedEntity = null;
    updateProcessControls();
    renderDiagnostics();
    toast('Bases recarregadas.');
  }

  async function exportHtml(mode) {
    const include_chassis = Boolean($('includeChassis')?.checked);
    if (mode === 'github-pages' && include_chassis && !window.confirm('Esta exportação incluirá VINs em arquivos estáticos. Qualquer pessoa com acesso ao site poderá baixar esses dados. Deseja continuar?')) return;
    const promise = fetch(`/api/export/${mode}`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({include_chassis})}).then((response) => response.json());
    pollProgress(promise);
    const result = await promise;
    setProgress(false);
    if (!result.ok) { toast(result.error || 'Falha na exportação.'); return; }
    const link = document.createElement('a');
    link.href = result.url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast(mode === 'github-pages' ? 'ZIP GitHub Pages gerado.' : 'HTML gerado.');
  }

  async function copyBlockAsPng(id) {
    const source = $(id);
    if (!source) return;
    try {
      const wrappers = qsa('.table-wrap', source);
      const extraHeight = wrappers.reduce((sum, wrapper) => sum + Math.max(0, wrapper.scrollHeight - wrapper.clientHeight), 0);
      const fullWidth = wrappers.reduce((maximum, wrapper) => Math.max(maximum, wrapper.scrollWidth), 0);
      const clone = source.cloneNode(true);
      qsa('.copy-image', clone).forEach((button) => button.remove());
      qsa('.table-wrap', clone).forEach((wrapper) => { wrapper.style.maxHeight = 'none'; wrapper.style.overflow = 'visible'; wrapper.style.width = 'max-content'; wrapper.style.minWidth = '100%'; });
      const width = Math.max(source.scrollWidth, fullWidth + 40, 900);
      const height = Math.max(source.scrollHeight + extraHeight, 150);
      clone.style.cssText += `;width:${width}px;max-height:none;overflow:visible;background:#fff;padding:20px`;
      const styles = [...document.styleSheets].map((sheet) => { try { return [...sheet.cssRules].map((rule) => rule.cssText).join(''); } catch (error) { return ''; } }).join('');
      const markup = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${styles}</style>${markup}</div></foreignObject></svg>`;
      const blob = new Blob([svg], {type:'image/svg+xml'});
      const url = URL.createObjectURL(blob);
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const context = canvas.getContext('2d');
      context.scale(2, 2);
      context.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
        toast('Imagem copiada.');
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(png);
        link.download = 'resultado.png';
        link.click();
        toast('Imagem baixada.');
      }
    } catch (error) {
      toast('O navegador bloqueou a cópia. Use a captura de tela do sistema.');
    }
  }

  if (document.body.dataset.mode !== 'server') qsa('.server-only').forEach((element) => element.remove());
  // O HTML exportado carrega os dados incorporados e não precisa bloquear a tela.
  // Alguns visualizadores do iOS limitam ou interrompem JavaScript em arquivos locais;
  // por isso a camada começa oculta e também recebe uma saída de segurança.
  const embeddedProgressFailsafe = document.body.dataset.embedded === 'true'
    ? setTimeout(() => setProgress(false), 1500)
    : null;
  Promise.resolve(loadData())
    .catch((error) => {
      setProgress(false);
      console.error('Falha ao inicializar o dashboard:', error);
      const banner=document.createElement('div');
      banner.setAttribute('role','alert');
      banner.style.cssText='margin:18px;padding:20px;background:#fff5d1;border:2px solid #d19b00;border-radius:9px;color:#171717';
      banner.textContent=error.message || 'Não foi possível abrir o dashboard.';
      document.querySelector('.wrap')?.prepend(banner);
    })
    .finally(() => {
      if (embeddedProgressFailsafe) clearTimeout(embeddedProgressFailsafe);
    });
})();
