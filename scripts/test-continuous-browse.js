const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scripts = ['/content/modules/ContinuousBrowseTableBridge.js', '/content/modules/BaseModule.js', '/content/modules/ContinuousBrowseAdapters.js', '/content/modules/ContinuousBrowse.js'];
const attempts = new Map();
const fixture = (url) => {
  const requestedMode = url.searchParams.get('mode');
  const mode = ['normal', 'nested', 'unsupported', 'error', 'slow'].includes(requestedMode) ? requestedMode : 'normal';
  const page = Number(url.searchParams.get('page') || 1);
  const items = page === 1 ? [1, 2, 3, 4, 5] : page === 2 ? [5, 6, 7, 8, 9] : [10, 11];
  const next = page < 3 ? `<nav class="pagination"><a rel="next" href="?mode=${mode}&page=${page + 1}">下一页</a></nav>` : '';
  const content = mode === 'unsupported' ? '<p>没有可靠分页规则</p><button>下一页</button>' : `<ul id="results">${items.map(id => `<li><a href="/detail/${id}">测试条目 ${id}</a><p>第 ${id} 条内容</p></li>`).join('')}${page === 2 ? '<script>window.injected = true</script><li onclick="window.injected=true"><a href="javascript:window.injected=true">安全条目</a><img src="/missing.png" onerror="window.injected=true"><iframe srcdoc="test"></iframe></li>' : ''}</ul>${next}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>连续浏览回归</title><style>body{margin:32px;font:15px system-ui;background:#f6f7f9}main{max-width:850px;margin:auto}li{min-height:180px;padding:20px;background:white;border-bottom:1px solid #ddd}button{padding:8px;margin:4px}#scroll{${mode === 'nested' ? 'height:320px;overflow:auto;border:1px solid #ccc' : ''}}</style></head><body><header><h1>连续浏览测试</h1><button id="start">开始连续浏览</button><button id="pause">暂停</button><button id="resume">继续</button><button id="stop">恢复原分页</button><button id="test">运行自动回归</button><output id="result"></output></header><div id="scroll"><main>${content}</main></div>${scripts.map(src => `<script src="${src}"></script>`).join('')}<script>
  window.fixtureData = { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [location.hostname] };
  window.chrome = {runtime:{onMessage:{addListener(){},removeListener(){}}},storage:{local:{async get(){return {...fixtureData}},async set(values){Object.assign(fixtureData,values)}}}};
  window.browserModule = new ContinuousBrowse();
  window.browserReady = browserModule.init();
  ['pause','resume','stop'].forEach(command=>document.getElementById(command).onclick=()=>browserModule.command(command));
  document.getElementById('start').onclick=async()=>{await chrome.storage.local.set({continuousBrowseModuleEnabled:true,enabledContinuousBrowseSites:[location.hostname]});browserModule.destroy();window.browserModule=new ContinuousBrowse();await browserModule.init()};
  document.getElementById('test').onclick=()=>runRegression();
  async function runRegression(){
    const checks=[];
    const assert=(name,ok)=>{checks.push({name,pass:!!ok});if(!ok)throw new Error(name)};
    const waitFor=async(test)=>{const end=Date.now()+3000;while(!test()){if(Date.now()>end)throw new Error('授权后自动开启超时');await new Promise(resolve=>setTimeout(resolve,25))}};
    try {
      await browserReady;
      assert('识别通用HTML分页',browserModule.status().adapter==='通用 HTML 分页');
      assert('支持页面授权后自动开启',!!browserModule.adapter && browserModule.pages===1);
      await browserModule.command('pause');
      await browserModule._load();
      assert('暂停不加载',browserModule.pages===1);
      await browserModule.command('resume');
      await browserModule._load();
      assert('追加第二页及去重',browserModule.pages===2 && browserModule.adapter.loaded===10);
      const shadow=browserModule._host.shadowRoot;
      assert('不执行注入脚本',!window.injected);
      assert('剥离主动内容',!shadow.querySelector('iframe,[onclick],[onerror],a[href^="javascript:"]'));
      assert('恢复绝对链接',shadow.querySelector('a[href$="/detail/6"]')?.href===location.origin+'/detail/6');
      assert('原内容未改动',document.querySelectorAll('#results>li').length===5);
      await browserModule._load();
      assert('末页停止',browserModule.state==='done' && browserModule.adapter.loaded===12 && browserModule.pages===3);
      await browserModule.command('stop');
      assert('恢复分页与清理UI',!document.querySelector('[data-geek-continuous-browse]') && document.querySelector('.pagination').style.display==='');
      assert('关闭移除当前域名许可',!fixtureData.enabledContinuousBrowseSites.includes(location.hostname));
      browserModule.destroy();
      window.browserModule=new ContinuousBrowse();await browserModule.init();
      assert('下次初始化仍保持关闭',!browserModule.adapter && !browserModule.isEnabled);
      await chrome.storage.local.set({continuousBrowseModuleEnabled:true,enabledContinuousBrowseSites:[location.hostname]});
      browserModule.destroy();
      window.browserModule=new ContinuousBrowse();await browserModule.init();
      assert('重新许可当前网站后自动开启',!!browserModule.adapter);
      await browserModule.command('pause');
      history.pushState({},'', '?mode=normal&page=1&changed=1');browserModule._checkContext();
      assert('路由变化退出',!browserModule.adapter);
      await waitFor(()=>browserModule.adapter);
      assert('路由变化后自动开启且保留域名许可',browserModule.pages===1 && fixtureData.enabledContinuousBrowseSites.includes(location.hostname));
      await browserModule.command('pause');
      document.querySelector('#results li p').textContent='筛选后内容';
      await new Promise(resolve=>setTimeout(resolve,0));
      assert('原站重渲染退出',!browserModule.adapter);
      const source=new DOMParser().parseFromString('<article><header><h1>标题</h1></header><picture><img src="/image.png"></picture><p>正文</p></article>','text/html');
      const clean=ContinuousBrowseHtmlAdapter.sanitize(source.querySelector('article'),location.href);
      assert('保留安全容器的子内容',clean.textContent==='标题正文' && !!clean.querySelector('img'));
      const first=document.createElement('li');first.innerHTML='<img src="/one.png">';
      const second=document.createElement('li');second.innerHTML='<img src="/two.png">';
      const adapter=ContinuousBrowseHtmlAdapter.detect();
      assert('纯图片内容不会误去重',adapter.key(first,location.href)!==adapter.key(second,location.href));
      const ambiguous=new DOMParser().parseFromString('<nav><a rel="next" href="?page=2">下一页</a><a rel="next" href="?page=3">下一页</a></nav>','text/html');
      assert('歧义分页不视为末页',ContinuousBrowseHtmlAdapter.nextLink(ambiguous,location.href).ambiguous);
      await waitFor(()=>browserModule.adapter);
      assert('原站重渲染后自动开启',browserModule.pages===1);
      window.dispatchEvent(new Event('pagehide'));
      await new Promise(resolve=>setTimeout(resolve,400));
      assert('页面隐藏不自动重启',!browserModule.adapter);
      window.dispatchEvent(new Event('pageshow'));
      await waitFor(()=>browserModule.adapter);
      assert('页面恢复后自动开启',browserModule.pages===1);
      await browserModule.command('pause');
      assert('暂停保留域名许可',fixtureData.enabledContinuousBrowseSites.includes(location.hostname));
    } catch(error){checks.push({error:error.message})}
    browserModule.destroy();
    window.regressionResults=checks;
    document.getElementById('result').textContent=checks.filter(x=>x.pass).length+' 项通过 / '+checks.filter(x=>x.name).length;
    return checks;
  }
  </script></body></html>`;
};

function setupTableFixture(client = false, options = {}) {
  const watcherMode = options.mode === 'watcher';
  const deferredProps = client || watcherMode;
  const table = document.querySelector('.el-table');
  const pager = document.querySelector('.el-pagination');
  const nextButton = pager.querySelector('.btn-next');
  const tbody = table.querySelector('tbody');
  const watchers = new Set();
  const selection = new Set();
  let renderPending = false;
  const notify = watcher => {
    const value = watcher.get();
    if (value !== watcher.value) {
      const previous = watcher.value;
      watcher.value = value;
      watcher.callback(value, previous);
    }
  };
  const flush = () => {
    for (const watcher of [...watchers]) {
      if (!watcher.deferred) notify(watcher);
      else if (!watcher.pending) {
        watcher.pending = true;
        queueMicrotask(() => { watcher.pending = false; notify(watcher); });
      }
    }
    if (!renderPending) {
      renderPending = true;
      queueMicrotask(() => { renderPending = false; render(); });
    }
  };
  const reactive = value => new Proxy(value, { set(target, key, next) { target[key] = next; flush(); return true; } });
  const rows = page => Array.from({ length: page === 3 ? 2 : 3 }, (_, i) => ({ id: (page - 1) * 3 + i + 1, name: `条目 ${(page - 1) * 3 + i + 1}` }));
  function clientState() {
    const ref = value => reactive({ __v_isRef: true, value });
    const raw = {
      allData: ref([...rows(1), ...rows(2), ...rows(3)]), tableLoading: ref(false),
      pagination: reactive({ currentPage: 1, pageSize: 3, total: 8 }),
      handlePageChange(page) { raw.pagination.currentPage = page; },
    };
    let cached, source, page, size;
    // Vue computed slices retain their identity until a dependency changes.
    raw.tableData = {
      __v_isRef: true, __v_isReadonly: true,
      get value() {
        const data = raw.allData.value;
        const { currentPage, pageSize } = raw.pagination;
        if (data !== source || currentPage !== page || pageSize !== size) {
          source = data; page = currentPage; size = pageSize;
          cached = data.slice((page - 1) * size, page * size);
        }
        return cached;
      },
    };
    return new Proxy(raw, {
      get(target, key) {
        if (key === '__v_raw') return target;
        const value = target[key];
        return value?.__v_isRef ? value.value : value;
      },
      set(target, key, value) {
        if (target[key]?.__v_isReadonly) return false;
        if (target[key]?.__v_isRef) target[key].value = value;
        else { target[key] = value; flush(); }
        return true;
      },
    });
  }
  const watcherControls = watcherMode ? window.fixtureWatcher = {
    loads: [], nextClicks: [], searchCalls: 0, pending: 0, delay: 50,
    failPages: new Set(), disableNext: false, ignoreNext: false, resetting: false,
  } : null;
  const queryProps = watcherMode ? reactive({ keyword: '' }) : null;
  function watcherState() {
    const data = reactive({
      tableData: rows(1), tableLoading: false,
      pagination: reactive({ currentPage: 1, pageSize: 3, total: 8 }),
      async handleSearch() { watcherControls.searchCalls++; },
    });
    let revision = 0;
    // The page loader is private; the native pager only changes currentPage.
    const load = async (page, keyword) => {
      const token = ++revision;
      const request = { page, keyword, before: data.tableData, failed: !!window.fixtureFail || watcherControls.failPages.has(page) };
      watcherControls.loads.push(request);
      watcherControls.pending++;
      data.tableLoading = true;
      await new Promise(resolve => setTimeout(resolve, window.fixtureSlow ? 500 : watcherControls.delay));
      request.retained = data.tableData === request.before;
      if (token === revision) {
        if (!request.failed) {
          request.data = rows(page).map(row => keyword ? { id: row.id + 100, name: keyword + ' ' + row.name } : row);
          data.tableData = request.data;
          request.applied = true;
        }
        data.tableLoading = false;
      }
      request.completed = true;
      watcherControls.pending--;
    };
    const get = () => JSON.stringify([data.pagination.currentPage, queryProps.keyword]);
    watchers.add({ get, value: get(), deferred: true, callback(value, previous) {
      if (watcherControls.resetting) return;
      const [page, keyword] = JSON.parse(value);
      if (keyword !== JSON.parse(previous)[1] && page !== 1) {
        data.pagination.currentPage = 1;
        return;
      }
      void load(page, keyword);
    } });
    return data;
  }
  const state = client ? clientState() : watcherMode ? watcherState() : reactive({
    tableData: rows(1), formData: reactive({ pageNum: 1, pageSize: 3, total: 8, keyword: '' }), loading: false,
    async handleCurrentChange(page) {
      state.formData.pageNum = page;
      state.loading = true;
      await new Promise(resolve => setTimeout(resolve, window.fixtureSlow ? 500 : 50));
      if (!window.fixtureFail) state.tableData = rows(page);
      state.loading = false;
    },
  });
  const owner = {
    type: { name: watcherMode ? 'RehabilitationPage' : 'FixturePage' }, setupState: state, isUnmounted: false,
    ...(watcherMode ? { props: queryProps } : {}),
    proxy: {
      $el: document.querySelector('main'), $nextTick: () => Promise.resolve(),
      $watch(get, callback) { const watcher = { get, callback, value: get() }; watchers.add(watcher); return () => watchers.delete(watcher); },
    },
  };
  const actions = {
    getSelectionRows: () => [...selection],
    clearSelection: () => { selection.clear(); },
    toggleRowSelection: (row, selected) => { if (selected) selection.add(row); else selection.delete(row); },
  };
  const pagination = deferredProps ? state.pagination : state.formData;
  const currentPage = () => deferredProps ? pagination.currentPage : pagination.pageNum;
  let rendered;
  table.__vueParentComponent = {
    type: { name: 'ElTable' }, parent: owner, setupState: actions, exposed: actions,
    props: { get data() { return deferredProps ? rendered.data : state.tableData; }, rowKey: 'id', lazy: false, treeProps: { children: 'children', hasChildren: 'hasChildren' } },
  };
  pager.__vueParentComponent = {
    type: { name: 'ElPagination' }, parent: owner,
    props: {
      get currentPage() { return deferredProps ? rendered.page : state.formData.pageNum; },
      get pageSize() { return deferredProps ? rendered.size : state.formData.pageSize; },
      get total() { return deferredProps ? rendered.total : state.formData.total; },
    },
  };
  function render() {
    // Vue child props and DOM update after synchronous setupState writes.
    rendered = { data: state.tableData, page: currentPage(), size: pagination.pageSize, total: pagination.total };
    tbody.replaceChildren(...rendered.data.map(row => {
      const tr = document.createElement('tr'); tr.className = 'el-table__row';
      if (deferredProps) tr.dataset.rowId = row.id;
      const selectionCell = tr.insertCell(); selectionCell.className = 'el-table-column--selection';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selection.has(row);
      checkbox.onchange = () => actions.toggleRowSelection(row, checkbox.checked); selectionCell.append(checkbox);
      tr.insertCell().textContent = row.name;
      const button = document.createElement('button'); button.textContent = '查看详情';
      button.onclick = () => {
        window.fixtureDetail = { id: row.id, ids: state.tableData.map(item => item.id), page: currentPage() };
        if (watcherMode) Object.assign(window.fixtureDetail, {
          data: state.tableData, loading: state.tableLoading, loads: watcherControls.loads.length,
          propsPage: pager.__vueParentComponent.props.currentPage,
        });
        document.querySelector('#detail').hidden = false;
      };
      tr.insertCell().append(button);
      return tr;
    }));
    pager.querySelector('.is-active').textContent = currentPage();
    pager.querySelector('.btn-prev').disabled = currentPage() <= 1;
    const next = pager.querySelector('.btn-next');
    if (next) next.disabled = !!watcherControls?.disableNext || currentPage() >= (deferredProps ? Math.ceil(pagination.total / pagination.pageSize) : 3);
    table.classList.toggle('is-loading', deferredProps ? state.tableLoading : state.loading);
  }
  const changePage = page => client ? state.handlePageChange(page)
    : watcherMode ? (pagination.currentPage = page) : state.handleCurrentChange(page);
  pager.querySelector('.btn-prev').onclick = () => changePage(currentPage() - 1);
  nextButton.onclick = () => { if (!watcherControls?.ignoreNext) return changePage(currentPage() + 1); };
  if (watcherMode) nextButton.addEventListener('click', () => watcherControls.nextClicks.push({
    page: currentPage(), propsPage: pager.__vueParentComponent.props.currentPage,
    loading: state.tableLoading, loads: watcherControls.loads.length, button: nextButton,
  }));
  document.querySelector('#closeDetail').onclick = () => { document.querySelector('#detail').hidden = true; };
  render();
  window.fixtureTableState = state;
  window.fixtureTableSelection = selection;
  window.fixtureTableOwner = owner;
  if (new URL(location.href).searchParams.has('extension')) return;
  window.fixtureData = { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [location.hostname] };
  window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } }, storage: { local: {
    async get() { return { ...window.fixtureData }; }, async set(data) { Object.assign(window.fixtureData, data); },
  } } };
  if (client) {
    const starts = window.fixtureClientStarts = [];
    const sourceSnapshot = (data = state.allData) => ({
      data, ref: state.__v_raw.allData, rows: data.slice(), json: JSON.stringify(data),
    });
    const initialSource = sourceSnapshot();
    const initClient = () => {
      const module = window.browserModule = new ContinuousBrowse();
      const start = module.start;
      module.start = function (...args) {
        const previous = this.adapter;
        const result = start.apply(this, args);
        if (!previous && this.adapter) {
          const adapter = this.adapter;
          // Observe the actual auto-start synchronously, before the render microtask.
          const sample = {
            adapter, host: this._host, session: this._session, pending: renderPending,
            data: state.tableData, cached: state.tableData === state.tableData,
            page: pagination.currentPage, size: pagination.pageSize,
            propsData: table.__vueParentComponent.props.data, domRows: tbody.rows.length,
            propsPage: pager.__vueParentComponent.props.currentPage,
            propsSize: pager.__vueParentComponent.props.pageSize,
            state: this.state, nextUrl: adapter.nextUrl,
          };
          starts.push(sample);
          sample.isCurrent = adapter.isCurrent();
          this._checkContext();
          sample.retained = this.adapter === adapter && this._host === sample.host && this._session === sample.session;
        }
        return result;
      };
      window.browserReady = module.init();
      return window.browserReady;
    };
    window.runClientTableRegression = async () => {
      const checks = [];
      const assert = (name, pass) => { checks.push({ name, pass: !!pass }); if (!pass) throw new Error(name); };
      const tick = () => owner.proxy.$nextTick();
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const ids = data => data.map(row => row.id).join();
      const domIds = () => [...tbody.rows].map(row => row.dataset.rowId).join();
      const rowControl = (id, selector) => tbody.querySelector('[data-row-id="' + id + '"] ' + selector);
      const assertSource = (saved, name = 'allData 数组、ref、行身份及内容不变') => assert(name,
        state.allData === saved.data && state.__v_raw.allData === saved.ref
        && state.allData.length === saved.rows.length && state.allData.every((row, index) => row === saved.rows[index])
        && JSON.stringify(state.allData) === saved.json);
      const prepare = async (page = 1, data = [...rows(1), ...rows(2), ...rows(3)]) => {
        browserModule.destroy();
        window.fixtureData = { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [location.hostname] };
        starts.length = 0;
        selection.clear();
        document.querySelector('#detail').hidden = true;
        delete window.fixtureDetail;
        state.allData = data;
        state.tableLoading = false;
        pagination.pageSize = 3;
        pagination.total = data.length;
        state.handlePageChange(page);
        await tick();
        return sourceSnapshot();
      };
      // Isolate cases so a failing start does not hide refresh/rejection regressions.
      const test = async (name, run) => {
        try { await run(); } catch (error) { checks.push({ test: name, error: error.message }); }
        finally { browserModule.destroy(); await tick(); }
      };
      const assertExpanded = initialPage => {
        const sample = starts[0];
        assert('客户端自动开启一次', starts.length === 1 && !!sample?.adapter.interactive);
        assert('渲染前已展开全部八行且 computed 缓存稳定', sample.pending && sample.cached
          && sample.page === 1 && sample.size === 8 && ids(sample.data) === '1,2,3,4,5,6,7,8'
          && sample.data !== state.allData);
        assert('子组件 props 和 DOM 确实滞后一轮', sample.propsData !== sample.data
          && sample.propsData.length === 3 && sample.domRows === 3 && sample.propsPage === initialPage && sample.propsSize === 3);
        assert('渲染前 done、nextUrl=false、isCurrent=true 且检查上下文不退出', sample.state === 'done'
          && sample.nextUrl === false && sample.isCurrent && sample.retained);
        assert('渲染后仍为同一完成会话', browserModule.adapter === sample.adapter && browserModule._host === sample.host
          && browserModule._session === sample.session && browserModule.state === 'done' && browserModule.pages === 1
          && browserModule.adapter.loaded === 8 && browserModule.adapter.total === 8
          && browserModule.adapter.nextUrl === false && browserModule.adapter.isCurrent());
        assert('原生表格展示全部八行', pagination.currentPage === 1 && pagination.pageSize === 8
          && domIds() === '1,2,3,4,5,6,7,8' && tbody.querySelectorAll('button').length === 8
          && table.__vueParentComponent.props.data === state.tableData && state.tableData !== state.allData);
      };
      await test('自动开启与浮层稳定', async () => {
        let source = initialSource;
        if (browserModule._destroyed) { source = await prepare(); await initClient(); }
        else await browserReady;
        assertExpanded(1);
        assertSource(source);
        const { adapter, host, session } = starts[0];
        const displayed = state.tableData;
        let detached = false;
        const observer = new MutationObserver(records => {
          if (records.some(record => [...record.removedNodes].some(node => node === host || node.contains?.(host)))) detached = true;
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        const stable = () => browserModule.adapter === adapter && browserModule._host === host && host.isConnected
          && browserModule._session === session && starts.length === 1 && !browserModule._autoStartTimer
          && document.querySelectorAll('[data-geek-continuous-browse]').length === 1
          && browserModule.state === 'done' && browserModule.pages === 1 && adapter.nextUrl === false
          && adapter.isCurrent() && state.tableData === displayed && !detached;
        let stayedStable = true;
        const began = performance.now();
        try {
          // Cover both context timers without invalidating the computed slice.
          while (performance.now() - began < 1300) {
            table.classList.toggle('fixture-pulse');
            state.tableLoading = false;
            browserModule._checkContext();
            stayedStable = stable() && stayedStable;
            await delay(75);
            browserModule._checkContext();
            stayedStable = stable() && stayedStable;
          }
          assert('至少 1.2 秒上下文轮询及 DOM 变动不闪烁、不重启', performance.now() - began >= 1200 && stayedStable);
          await browserModule._load();
          assert('完成态不请求下一页或重建浮层', stable() && browserModule.pages === 1);
          assertSource(source);
        } finally { observer.disconnect(); table.classList.remove('fixture-pulse'); }
      });
      await test('显式关闭恢复第一页', async () => {
        const source = await prepare();
        await initClient();
        assertExpanded(1);
        await browserModule.command('stop');
        await tick();
        assert('关闭恢复初始 page1 / size3', pagination.currentPage === 1 && pagination.pageSize === 3
          && ids(state.tableData) === '1,2,3' && domIds() === '1,2,3');
        assertSource(source);
        assert('关闭移除浮层、恢复分页并记忆域名', !browserModule.adapter && !document.querySelector('[data-geek-continuous-browse]')
          && pager.style.display === '' && !fixtureData.enabledContinuousBrowseSites.includes(location.hostname));
        await delay(400);
        browserModule._checkContext();
        assert('显式关闭后不自动重启', !browserModule.adapter && starts.length === 1);
      });
      await test('第二页开启、勾选与恢复', async () => {
        const source = await prepare(2);
        const displayed = state.tableData;
        assert('computed 为只读 ref，重复读取不生成新数组', state.__v_raw.tableData.__v_isReadonly
          && state.__v_raw.allData.__v_isRef && !Reflect.set(state, 'tableData', [])
          && state.tableData === displayed && displayed !== state.allData && ids(displayed) === '4,5,6');
        state.tableLoading = false;
        pagination.total = 9;
        assert('无关依赖不使 computed 失效', state.tableData === displayed);
        pagination.total = 8;
        assert('同步 handlePageChange 无异步请求', state.handlePageChange(1) === undefined && state.tableLoading === false);
        const firstPage = state.tableData;
        assert('页码变化才重新计算并缓存切片', firstPage !== displayed && state.tableData === firstPage && ids(firstPage) === '1,2,3');
        state.handlePageChange(2);
        await tick();
        rowControl(4, 'input').click();
        await initClient();
        assertExpanded(2);
        assert('展开后保留原页勾选及行身份', selection.has(source.rows[3]) && rowControl(4, 'input').checked);
        const { adapter, host, session } = starts[0];
        rowControl(7, 'input').click();
        browserModule._checkContext();
        await tick();
        assert('checkbox 不结束会话且保留新增勾选', browserModule.adapter === adapter && adapter.isCurrent()
          && browserModule._host === host && browserModule._session === session && starts.length === 1
          && pagination.pageSize === 8 && selection.has(source.rows[3]) && selection.has(source.rows[6])
          && rowControl(7, 'input').checked && !window.fixtureDetail);
        await browserModule.command('stop');
        await tick();
        assert('从第二页开启后关闭恢复 page2 / size3', pagination.currentPage === 2 && pagination.pageSize === 3
          && ids(state.tableData) === '4,5,6' && domIds() === '4,5,6');
        assert('关闭仍保留选择', selection.size === 2 && selection.has(source.rows[3]) && selection.has(source.rows[6])
          && rowControl(4, 'input').checked);
        assertSource(source);
      });
      await test('第七行原生业务操作', async () => {
        const source = await prepare();
        await initClient();
        assertExpanded(1);
        const adapter = browserModule.adapter;
        rowControl(7, 'button').click();
        // No await: restoration must precede the original synchronous row handler.
        assert('row7 原事件同步看到 page3 的 ids7,8', window.fixtureDetail?.id === 7 && fixtureDetail.page === 3
          && fixtureDetail.ids.join() === '7,8' && pagination.currentPage === 3 && pagination.pageSize === 3);
        assert('业务点击结束客户端会话', !adapter.isCurrent());
        browserModule._checkContext();
        await tick();
        assert('第三页渲染且详情期间不重新展开', domIds() === '7,8' && !browserModule.adapter
          && !document.querySelector('[data-geek-continuous-browse]') && !ContinuousBrowseTableAdapter.detect());
        assertSource(source);
      });
      for (const kind of ['loading', 'source', 'total']) {
        await test('刷新失效：' + kind, async () => {
          const original = await prepare();
          await initClient();
          assertExpanded(1);
          const adapter = browserModule.adapter;
          let expected = original;
          if (kind === 'loading') state.tableLoading = true;
          if (kind === 'source') {
            const replacement = original.rows.map(row => ({ id: row.id + 100, name: '刷新 ' + row.id }));
            expected = sourceSnapshot(replacement);
            state.allData = replacement;
          }
          if (kind === 'total') pagination.total = 9;
          assert(kind + ' 改变即结束旧会话', !adapter.isCurrent());
          browserModule._checkContext();
          assert(kind + ' 失效恢复 size3 并移除浮层', pagination.pageSize === 3 && !browserModule.adapter
            && !document.querySelector('[data-geek-continuous-browse]'));
          assertSource(expected, kind + ' 失效不截断或替换 allData');
          if (kind === 'loading') {
            assert('恢复分页不清除站点 loading', state.tableLoading === true);
            const replacement = Array.from({ length: 9 }, (_, index) => ({ id: index + 101, name: '刷新 ' + index }));
            expected = sourceSnapshot(replacement);
            state.allData = replacement;
            pagination.total = 9;
            state.tableLoading = false;
          }
          await tick();
          assertSource(expected, kind + ' 刷新完成后保留完整源数据及行身份');
          assert(kind + ' 刷新后保持 size3 和新 total', pagination.pageSize === 3
            && pagination.total === (kind === 'source' ? 8 : 9)
            && state.tableData.length === 3 && domIds() === ids(expected.data.slice(0, 3)));
        });
      }
      await test('外部修改 pageSize', async () => {
        const source = await prepare();
        await initClient();
        assertExpanded(1);
        const adapter = browserModule.adapter;
        pagination.pageSize = 5;
        assert('外部 pageSize 变化结束会话', !adapter.isCurrent());
        browserModule._checkContext();
        await browserModule.command('stop');
        await tick();
        assert('清理及显式关闭均不覆盖外部 size5', pagination.pageSize === 5 && !browserModule.adapter
          && ids(state.tableData) === '1,2,3,4,5' && domIds() === '1,2,3,4,5');
        assertSource(source);
      });
      for (const kind of ['total-too-small', 'total-too-large', 'duplicate-off-page']) {
        await test('拒绝无效客户端数据：' + kind, async () => {
          const data = [...rows(1), ...rows(2), ...rows(3)];
          if (kind === 'duplicate-off-page') data[7] = { ...data[7], id: data[6].id };
          const source = await prepare(1, data);
          if (kind !== 'duplicate-off-page') pagination.total = kind === 'total-too-small' ? 7 : 9;
          await tick();
          assert(kind + ' 初始三行合法且 props 已渲染', ids(state.tableData) === '1,2,3' && domIds() === '1,2,3'
            && table.__vueParentComponent.props.data === state.tableData
            && pager.__vueParentComponent.props.total === pagination.total);
          assert(kind + ' detect 拒绝整个源数据契约', !ContinuousBrowseTableAdapter.detect());
          const result = ContinuousBrowseTableAdapter.send(table, 'start');
          assert(kind + ' start 同样拒绝', result?.supported === false && !result.active);
          await initClient();
          browserModule._checkContext();
          assert(kind + ' 不自动开启或扩大分页', !browserModule.adapter && starts.length === 0
            && pagination.pageSize === 3 && pagination.currentPage === 1 && !document.querySelector('[data-geek-continuous-browse]'));
          assertSource(source);
        });
      }
      window.regressionResults = checks;
      return checks;
    };
    initClient();
    return;
  }
  if (watcherMode) {
    const initWatcher = () => {
      window.browserModule = new ContinuousBrowse();
      window.browserReady = browserModule.init();
      return window.browserReady;
    };
    window.runWatcherTableRegression = async () => {
      const checks = [];
      const controls = watcherControls;
      const assert = (name, pass) => { checks.push({ name, pass: !!pass }); if (!pass) throw new Error(name); };
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const tick = async () => { await owner.proxy.$nextTick(); await owner.proxy.$nextTick(); };
      const ids = data => data.map(row => row.id).join();
      const domIds = () => [...tbody.rows].map(row => row.dataset.rowId).join();
      const rowControl = (id, selector) => tbody.querySelector('[data-row-id="' + id + '"] ' + selector);
      const waitFor = async test => {
        const end = Date.now() + 4000;
        while (!test()) { if (Date.now() > end) throw new Error('watcher 状态超时'); await delay(10); }
      };
      const bounded = async promise => {
        let timer;
        try {
          return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('watcher 请求未在 18 秒内结束')), 18000);
          })]);
        } finally { clearTimeout(timer); }
      };
      const settle = async () => {
        await tick();
        await waitFor(() => controls.pending === 0 && !state.tableLoading);
        await tick();
      };
      let requestId = 0;
      const requestNext = async () => {
        const id = 'fixture-watcher-' + ++requestId;
        let listener;
        try {
          return await bounded(new Promise(resolve => {
            listener = event => {
              if (event.target !== table || typeof event.detail !== 'string') return;
              const response = JSON.parse(event.detail);
              if (response.id === id) resolve(response);
            };
            table.addEventListener('geek-continuous-table-response', listener);
            table.dispatchEvent(new CustomEvent('geek-continuous-table-request', {
              detail: JSON.stringify({ id, command: 'next' }), bubbles: true,
            }));
          }));
        } finally { table.removeEventListener('geek-continuous-table-response', listener); }
      };
      const prepare = async ({ start = true, control = 'normal' } = {}) => {
        browserModule.destroy();
        ContinuousBrowseTableAdapter.send(table, 'stop');
        await settle();
        controls.resetting = true;
        controls.delay = 50;
        controls.failPages.clear();
        controls.disableNext = control === 'disabled';
        controls.ignoreNext = false;
        window.fixtureFail = false;
        window.fixtureSlow = false;
        window.fixtureData = { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [location.hostname] };
        selection.clear();
        document.querySelector('#detail').hidden = true;
        delete window.fixtureDetail;
        if (!nextButton.isConnected) pager.append(nextButton);
        queryProps.keyword = '';
        pagination.currentPage = 1;
        pagination.pageSize = 3;
        pagination.total = 8;
        state.tableData = rows(1);
        state.tableLoading = false;
        await tick();
        controls.resetting = false;
        controls.loads.length = 0;
        controls.nextClicks.length = 0;
        controls.searchCalls = 0;
        if (control === 'missing') nextButton.remove();
        const original = state.tableData;
        if (start) {
          await initWatcher();
          assert('watcher 自动开启原生交互会话', browserModule.adapter?.interactive && browserModule.adapter.loaded === 3
            && browserModule.pages === 1 && browserModule.adapter.isCurrent());
        }
        return original;
      };
      const test = async (name, run) => {
        try { await run(); } catch (error) { checks.push({ test: name, error: error.message }); }
        finally {
          browserModule.destroy();
          ContinuousBrowseTableAdapter.send(table, 'stop');
          try { await settle(); } catch (error) { checks.push({ test: name + ' cleanup', error: error.message }); }
        }
      };
      await browserReady;
      await test('私有 watcher、原生点击与行操作', async () => {
        const original = await prepare({ start: false });
        assert('writable tableData / tableLoading / pagination，无导出翻页函数', !state.handleCurrentChange && !state.handlePageChange
          && !state.allData && !state.formData && owner.props.keyword === '' && Reflect.set(state, 'tableData', original));
        await tick();
        const detected = ContinuousBrowseTableAdapter.detect();
        assert('没有命名加载函数仍可 detect', detected?.interactive && detected.loaded === 3 && detected.nextUrl === true);
        await initWatcher();
        assert('没有命名加载函数仍可 start', browserModule.adapter?.isCurrent() && browserModule.pages === 1);
        rowControl(1, 'input').click();
        controls.delay = 180;
        const loading = browserModule._load();
        await waitFor(() => state.tableLoading);
        const click = controls.nextClicks[0];
        assert('实际原 btn-next 点击一次，仅更新页码且 props 滞后', controls.nextClicks.length === 1 && click.button === nextButton
          && click.page === 2 && click.propsPage === 1 && !click.loading && click.loads === 0);
        assert('deferred watcher 只加载一次 page2，不猜测 handleSearch', controls.loads.length === 1
          && controls.loads[0].page === 2 && controls.searchCalls === 0);
        assert('延迟请求完成前不追加或提前记成功', browserModule.state === 'loading' && browserModule.pages === 1
          && browserModule.adapter.loaded === 3 && state.tableData === original && domIds() === '1,2,3');
        await bounded(loading);
        await settle();
        const secondPage = controls.loads[0].data;
        assert('六行按原顺序追加且保留行身份及全部原生按钮', ids(state.tableData) === '1,2,3,4,5,6'
          && domIds() === ids(state.tableData) && browserModule.pages === 2 && browserModule.adapter.loaded === 6
          && state.tableData.every((row, index) => row === [...original, ...secondPage][index])
          && tbody.querySelectorAll('button').length === 6);
        const adapter = browserModule.adapter;
        rowControl(5, 'input').click();
        browserModule._checkContext();
        assert('旧页和新增页 checkbox 保持原交互，不终止会话', browserModule.adapter === adapter && adapter.isCurrent()
          && selection.has(original[0]) && selection.has(secondPage[1]) && rowControl(1, 'input').checked && rowControl(5, 'input').checked);
        await bounded(browserModule._load());
        await settle();
        assert('最后追加八行，仍有原生操作和跨页选择', ids(state.tableData) === '1,2,3,4,5,6,7,8'
          && domIds() === ids(state.tableData) && tbody.querySelectorAll('button').length === 8
          && browserModule.pages === 3 && adapter.loaded === 8 && selection.size === 2
          && rowControl(1, 'input').checked && rowControl(5, 'input').checked);
        assert('真实 next 按钮禁用即完成，无后续页', nextButton.isConnected && nextButton.disabled
          && pager.querySelector('.btn-next') === nextButton && browserModule.state === 'done' && adapter.nextUrl === false
          && ContinuousBrowseTableAdapter.send(table, 'status')?.next === false);
        await bounded(browserModule._load());
        assert('完成后不再点击、重复加载或调用搜索', controls.nextClicks.length === 2
          && controls.loads.map(load => load.page).join() === '2,3' && controls.searchCalls === 0);
        const loadCount = controls.loads.length;
        rowControl(4, 'button').click();
        // No await: the original handler must see cached page2 before its deferred watcher reload.
        assert('前页原生事件同步拿到缓存 page2 / ids4,5,6', window.fixtureDetail?.id === 4 && fixtureDetail.page === 2
          && fixtureDetail.ids.join() === '4,5,6' && fixtureDetail.data.every((row, index) => row === secondPage[index])
          && fixtureDetail.propsPage === 3 && !fixtureDetail.loading && fixtureDetail.loads === loadCount);
        assert('行操作同步终止旧会话', !adapter.isCurrent());
        browserModule._checkContext();
        await settle();
        assert('原站随后正常 reload page2，详情期间不重新合并', controls.loads.length === loadCount + 1
          && controls.loads.at(-1).page === 2 && controls.loads.at(-1).applied && domIds() === '4,5,6'
          && !browserModule.adapter && !ContinuousBrowseTableAdapter.detect() && !document.querySelector('[data-geek-continuous-browse]'));
      });
      for (const retry of ['settled', 'immediate']) {
        await test('失败回滚与重试：' + retry, async () => {
          await prepare();
          await bounded(browserModule._load());
          await settle();
          const successful = state.tableData.slice();
          rowControl(1, 'input').click();
          rowControl(5, 'input').click();
          controls.delay = 180;
          controls.failPages.add(3);
          await bounded(browserModule._load());
          const failed = controls.loads.find(load => load.page === 3);
          assert('第三页失败保留原数据并回滚，而非丢掉已成功的前两页', failed?.failed && failed.completed && failed.retained
            && pagination.currentPage === 2 && ids(state.tableData) === '1,2,3,4,5,6'
            && browserModule.state === 'error' && browserModule.pages === 2 && browserModule.adapter?.loaded === 6);
          if (retry === 'settled') {
            await settle();
            await delay(350);
            assert('回滚 reload 完成后仍保留六行、错误状态和跨页勾选', controls.loads.at(-1).page === 2
              && controls.loads.at(-1).applied && browserModule.state === 'error' && browserModule.pages === 2
              && browserModule.adapter?.loaded === 6 && ids(state.tableData) === '1,2,3,4,5,6'
              && domIds() === ids(state.tableData) && rowControl(1, 'input').checked && rowControl(5, 'input').checked);
          }
          controls.failPages.clear();
          await browserModule.command('retry');
          await bounded(browserModule._load());
          await settle();
          assert(retry + ' retry 在回滚 watcher reload 后仍成功且不重复', browserModule.state === 'done'
            && browserModule.pages === 3 && browserModule.adapter?.loaded === 8 && pagination.currentPage === 3
            && ids(state.tableData) === '1,2,3,4,5,6,7,8' && domIds() === ids(state.tableData)
            && successful.every((row, index) => state.tableData[index] === row));
          assert('回滚确实触发一次成功 page2 加载，重试只点击一次 page3', controls.loads.map(load => load.page).join() === '2,3,2,3'
            && controls.loads[2].applied && controls.nextClicks.map(click => click.page).join() === '2,3,3' && controls.searchCalls === 0);
          assert('失败及回滚 reload 后跨页勾选仍保留', selection.has(successful[0]) && selection.has(successful[4])
            && rowControl(1, 'input').checked && rowControl(5, 'input').checked);
        });
      }
      await test('在途关闭不晚合并', async () => {
        await prepare();
        await bounded(browserModule._load());
        const adapter = browserModule.adapter;
        controls.delay = 250;
        const loading = browserModule._load();
        await waitFor(() => state.tableLoading);
        await browserModule.command('stop');
        assert('请求尚在 loading 即可关闭', state.tableLoading && !browserModule.adapter && !adapter.isCurrent());
        await bounded(loading);
        await settle();
        await delay(350);
        browserModule._checkContext();
        assert('晚到响应仅保留原站单页，不追加旧页也不自动重启', !browserModule.adapter && adapter.loaded === 6
          && pagination.currentPage === 3 && state.tableData === controls.loads.at(-1).data && domIds() === '7,8'
          && pager.style.display === '' && !document.querySelector('[data-geek-continuous-browse]')
          && !fixtureData.enabledContinuousBrowseSites.includes(location.hostname));
      });
      for (const inflight of [false, true]) {
        await test('owner.props 查询失效：' + (inflight ? '在途' : '空闲'), async () => {
          await prepare();
          await bounded(browserModule._load());
          const adapter = browserModule.adapter;
          controls.delay = 200;
          const loading = inflight ? browserModule._load() : Promise.resolve();
          if (inflight) await waitFor(() => state.tableLoading);
          owner.props.keyword = '新筛选';
          assert('只有查询 props 改变也立即使旧会话失效', !adapter.isCurrent());
          browserModule._checkContext();
          assert('清理不覆盖外部查询或保留旧适配器', owner.props.keyword === '新筛选' && browserModule.adapter !== adapter);
          await bounded(loading);
          await settle();
          await delay(350);
          browserModule._checkContext();
          assert('新查询只显示自己的 page1，旧成功页和在途页不混入', owner.props.keyword === '新筛选'
            && pagination.currentPage === 1 && pagination.pageSize === 3 && domIds() === '101,102,103'
            && state.tableData === controls.loads.at(-1).data && adapter.loaded === 6
            && (!browserModule.adapter || (browserModule.adapter !== adapter && browserModule.adapter.loaded === 3 && browserModule.pages === 1)));
          if (inflight) assert('旧查询晚到响应不覆盖新结果', controls.loads.find(load => load.page === 3)?.completed
            && !controls.loads.find(load => load.page === 3).applied);
          assert('props watcher 不借用 handleSearch', controls.searchCalls === 0);
        });
      }
      for (const control of ['missing', 'disabled']) {
        await test('初始 next 控件：' + control, async () => {
          await prepare({ start: false, control });
          const detected = ContinuousBrowseTableAdapter.send(table, 'detect');
          const started = ContinuousBrowseTableAdapter.send(table, 'start');
          assert(control + ' 控件不能仅凭 total8 声称有下一页', detected && started
            && (!detected.supported || detected.next === false) && (!started.active || started.next === false));
          const response = await requestNext();
          assert(control + ' 控件请求明确结束且不猜测加载', (!response.ok || response.result?.next === false)
            && controls.loads.length === 0 && controls.nextClicks.length === 0 && controls.searchCalls === 0
            && pagination.currentPage === 1 && domIds() === '1,2,3');
        });
        await test('会话中 next 控件：' + control, async () => {
          await prepare();
          if (control === 'missing') nextButton.remove();
          else { controls.disableNext = true; nextButton.disabled = true; }
          const response = await requestNext();
          assert(control + ' 控件变化后请求不会静默等待或绕过原按钮', (!response.ok || response.result?.next === false)
            && !state.tableLoading && controls.loads.length === 0 && controls.nextClicks.length === 0
            && controls.searchCalls === 0 && pagination.currentPage === 1 && ids(state.tableData) === '1,2,3');
        });
      }
      await test('点击不产生 loading 时有界失败', async () => {
        await prepare();
        controls.ignoreNext = true;
        const response = await requestNext();
        assert('有效按钮不触发加载也必须返回失败，不能永远等待', response.ok === false
          && controls.nextClicks.length === 1 && controls.loads.length === 0 && controls.searchCalls === 0
          && !state.tableLoading && pagination.currentPage === 1 && domIds() === '1,2,3');
      });
      window.regressionResults = checks;
      return checks;
    };
    initWatcher();
    return;
  }
  window.browserModule = new ContinuousBrowse();
  window.browserReady = browserModule.init();
  window.runTableRegression = async () => {
    const checks = [];
    const assert = (name, pass) => { checks.push({ name, pass: !!pass }); if (!pass) throw new Error(name); };
    const waitFor = async test => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw new Error('表格状态超时'); await new Promise(resolve => setTimeout(resolve, 25)); } };
    const restart = async () => {
      browserModule.destroy();
      window.fixtureData = { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [location.hostname] };
      window.browserModule = new ContinuousBrowse();
      await browserModule.init();
    };
    try {
      await browserReady;
      assert('交互表格自动适配',browserModule.adapter?.interactive && browserModule.adapter.loaded === 3);
      await browserModule.command('pause');
      tbody.querySelector('input').click();
      await browserModule.command('resume'); await browserModule._load();
      assert('原生表格追加六行',state.tableData.length === 6 && tbody.rows.length === 6 && browserModule.pages === 2);
      assert('保留上一页勾选', [...selection].some(row => row.id === 1));
      assert('所有行保留原按钮',tbody.querySelectorAll('button').length === 6);
      await browserModule.command('pause');
      tbody.rows[0].querySelector('button').click();
      assert('原事件拿到正确行和分页',fixtureDetail.id === 1 && fixtureDetail.page === 1 && fixtureDetail.ids.join() === '1,2,3');
      await waitFor(() => !browserModule.adapter);
      assert('详情打开不重新拼表',!ContinuousBrowseTableAdapter.detect());
      document.querySelector('#closeDetail').click();
      await waitFor(() => browserModule.adapter);
      window.fixtureFail = true;
      await browserModule._load();
      assert('吞掉的请求错误仍被识别',browserModule.state === 'error' && state.formData.pageNum === 1 && state.tableData.length === 3);
      window.fixtureFail = false;
      await browserModule.command('retry'); await browserModule._load();
      assert('重试成功且无重复',browserModule.pages === 2 && state.tableData.length === 6);
      await browserModule._load();
      assert('最后一页停止',browserModule.state === 'done' && state.tableData.length === 8);
      await browserModule.command('stop');
      assert('关闭恢复最后单页和页码',state.formData.pageNum === 3 && state.tableData.length === 2 && !table.querySelector('[data-geek-continuous-browse]'));
      assert('关闭记忆不丢失',!fixtureData.enabledContinuousBrowseSites.includes(location.hostname));
      await state.handleCurrentChange(1); await restart();
      await browserModule._load();
      state.formData.keyword = '新筛选';
      await state.handleCurrentChange(1);
      await waitFor(() => browserModule.adapter?.loaded === 3);
      assert('筛选清空旧追加数据',state.tableData.length === 3 && state.formData.pageNum === 1);
      window.fixtureSlow = true;
      const loading = browserModule._load();
      await browserModule.command('stop'); await loading;
      await waitFor(() => !state.loading);
      assert('关闭不合并在途响应',!browserModule.adapter && state.tableData.length === 3);
      await state.handleCurrentChange(1); await restart();
      const timedOut = browserModule._load();
      browserModule._request.abort();
      await timedOut;
      await waitFor(() => !state.loading);
      await new Promise(resolve => setTimeout(resolve,800));
      assert('超时保留错误且不自动重启',browserModule.state === 'error' && browserModule._autoStartBlocked);
      window.fixtureSlow = false;
      await browserModule.command('retry');
      assert('超时后可手动建立新会话',browserModule.adapter?.isCurrent() && !browserModule._autoStartBlocked);
      const saved = table.__vueParentComponent; delete table.__vueParentComponent;
      assert('无Vue契约不强行适配',!ContinuousBrowseTableAdapter.detect());
      table.__vueParentComponent = saved;
    } catch (error) { checks.push({ error: error.message }); }
    browserModule.destroy();
    window.regressionResults = checks;
    return checks;
  };
}

const tableFixture = url => `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>交互表格回归</title>
<style>body{font:14px system-ui;margin:24px}.el-scrollbar__wrap{height:300px;overflow:auto}table{width:100%}td{height:200px;border-bottom:1px solid #ddd}button{padding:8px}.el-drawer{position:fixed;inset:0 0 0 50%;background:white;border:1px solid} [hidden]{display:none!important}</style>
<main><h1>交互表格回归</h1><div class="el-table"><div class="el-table__body-wrapper"><div class="el-scrollbar__wrap"><div class="el-scrollbar__view"><table class="el-table__body"><tbody></tbody></table></div></div></div></div>
<div class="el-pagination"><button class="btn-prev">上一页</button><ul class="el-pager"><li class="is-active">1</li></ul><button class="btn-next">下一页</button></div></main>
<div id="detail" class="el-drawer" role="dialog" hidden><h2>原生详情</h2><button id="closeDetail">关闭</button></div>
${url.searchParams.has('extension') ? '' : scripts.map(src => `<script src="${src}"></script>`).join('')}<script>(${setupTableFixture.toString()})(${url.searchParams.get('mode') === 'client'},${JSON.stringify({ mode: url.searchParams.get('mode') === 'watcher' ? 'watcher' : '' })})</script></html>`;

// Serialized into /click: pagination state and the asynchronous loader stay private.
function setupClickFixture(options) {
  const scope = document.querySelector('#click-scope');
  const query = document.querySelector('#click-query');
  const apply = document.querySelector('#click-filter');
  const result = document.querySelector('#click-result');
  const runButton = document.querySelector('#click-test');
  const drawer = document.querySelector('#click-detail');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let mode, element, pager, current, next, prev, page, busy, keyword, presentation, detailUrl, revision = 0;
  const closeDetail = () => {
    drawer.hidden = true;
    if (detailUrl !== undefined) {
      history.replaceState(history.state, '', detailUrl);
      detailUrl = undefined;
      window.dispatchEvent(new Event('hashchange'));
    }
  };
  document.querySelector('#click-close-detail').onclick = closeDetail;
  const controls = window.clickFixture = {
    behavior: options.behavior, delay: options.delay, clicks: [], requests: [], edits: [], submits: 0,
    get element() { return element; }, get pager() { return pager; },
    get next() { return next; }, get prev() { return prev; },
    get page() { return page; }, get busy() { return busy; },
    get pending() { return this.requests.filter(request => !request.completed).length; },
  };
  const rows = target => target === 1 ? [1, 2, 3] : target === 2 ? [3, 4, 5] : target === 4 ? [8, 9] : [6, 7];
  // Optional keyed-in-place rendering retains both rows and their button nodes.
  const patch = (target, source) => {
    if (target.nodeType !== Node.ELEMENT_NODE) { target.textContent = source.textContent; return; }
    for (const attr of [...target.attributes]) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of source.attributes) target.setAttribute(attr.name, attr.value);
    while (target.childNodes.length > source.childNodes.length) target.lastChild.remove();
    [...source.childNodes].forEach((child, index) => {
      const previous = target.childNodes[index];
      if (!previous) target.append(child.cloneNode(true));
      else if (previous.nodeType !== child.nodeType || previous.nodeName !== child.nodeName) previous.replaceWith(child.cloneNode(true));
      else patch(previous, child);
    });
  };
  function render(ids) {
    const target = element.tagName === 'TABLE' ? element.tBodies[0] : element;
    const previous = [...target.children];
    const rendered = ids.map((value, index) => {
      const id = value + (keyword ? 100 : 0);
      let row = document.createElement(element.tagName === 'TABLE' ? 'tr' : ['UL', 'OL'].includes(element.tagName) ? 'li' : 'div');
      row.dataset.rowKey = id;
      if (mode === 'role-list' || mode === 'grid') row.setAttribute('role', mode === 'grid' ? 'row' : 'listitem');
      const cells = presentation ? [
        '<input type="checkbox" aria-label="选择记录">',
        // No image src: dimensions must come from computed CSS, not network/intrinsic sizing.
        `<div class="click-title"><img class="click-avatar" alt="负责人头像"><a class="click-title-link" href="/record/${id}">这是用于验证宽标题列与单行省略的很长项目任务标题，不能被压缩成七十像素，条目 ${id}</a></div>`,
        `<fixture-column><em>自定义值-${id}</em></fixture-column><button type="button" data-action="edit">编辑</button><button type="button" data-action="inspect">查看</button>`,
        `<span id="click-badge-${id}" class="click-badge ${page === 1 ? 'click-active' : 'click-blocked'}" onclick="window.clickFixtureInjected=true" style="position:relative;top:3px;background-image:url('#click-fixture-paint')">${page === 1 ? '进行中' : '已阻塞'}</span>`
          + '<scr' + 'ipt>window.clickFixtureInjected=true;</scr' + 'ipt>',
      ] : [
        `<a href="/record/${id}">${keyword ? keyword + ' ' : ''}条目 ${id}</a><p>记录正文 ${id}</p>`,
        `<fixture-column><em>自定义值-${id}</em></fixture-column>`,
        '<input type="checkbox"><input value="原生输入"><textarea>原生备注</textarea><select><option>原生选项</option></select><button type="button" data-action="edit">原生编辑</button><button type="button" data-action="inspect">原生查看</button>',
        // innerHTML keeps this source script inert; the copy must remove it, not execute it.
        '<scr' + 'ipt>window.clickFixtureInjected=true;</scr' + 'ipt><span onclick="window.clickFixtureInjected=true">事件文本</span><a href="javascript:window.clickFixtureInjected=true">危险链接</a><b contenteditable="true">可编辑文本</b>',
      ];
      for (const html of cells) {
        const cell = document.createElement(element.tagName === 'TABLE' ? 'td' : 'div');
        if (mode === 'grid') cell.setAttribute('role', 'gridcell');
        cell.innerHTML = html;
        row.append(cell);
      }
      controls.mutateRow?.(row, { id, page });
      if (controls.reuseRows && previous[index]) {
        patch(previous[index], row);
        row = previous[index];
      }
      return row;
    });
    if (!controls.reuseRows) target.replaceChildren(...rendered);
    else {
      while (target.children.length > rendered.length) target.lastElementChild.remove();
      rendered.forEach((row, index) => { if (target.children[index] !== row) target.append(row); });
    }
  }
  function paintPager() {
    current.textContent = page;
    element.setAttribute('aria-busy', String(busy));
    for (const button of pager.querySelectorAll('[data-fixture-page]')) button.disabled = busy || Number(button.dataset.fixturePage) === page;
    for (const [button, disabled] of [[prev, page === 1 || busy], [next, page === controls.maxPage || busy]]) {
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
      if (mode === 'antd') {
        button.parentElement.classList.toggle('ant-pagination-disabled', disabled);
        button.parentElement.setAttribute('aria-disabled', String(disabled));
      }
    }
  }
  async function requestPage(target, filter = false) {
    const token = ++revision;
    const behavior = controls.behavior;
    const request = { page: target, keyword, filter, failed: behavior === 'fail', completed: false, applied: false, stage: false };
    controls.requests.push(request);
    page = target; // Deliberately ahead of the content, just like native async pagers.
    busy = true;
    paintPager();
    await delay(behavior === 'slow' ? Math.max(600, controls.delay) : controls.delay);
    if (token === revision && !request.failed) {
      const ids = behavior === 'duplicate' && !filter ? rows(1) : rows(target);
      if (behavior === 'staged') {
        render(ids.slice(0, 2));
        request.stage = true;
        await delay(100);
      }
      if (token === revision) { render(ids); request.applied = true; }
    }
    // Content arrives before aria-busy clears; consumers must wait for stability.
    await delay(35);
    if (token === revision) { busy = false; paintPager(); }
    request.completed = true;
  }
  function reset({ mode: nextMode = options.mode, behavior = 'normal', delay: latency = 100,
    reuseRows = false, maxPage = 3, numbered = false, hashDetails = false, mutateRow = null } = {}) {
    revision++;
    closeDetail();
    mode = nextMode;
    page = 1;
    busy = false;
    keyword = '';
    query.value = '';
    Object.assign(controls, { behavior, delay: latency, reuseRows, maxPage, hashDetails, mutateRow,
      clicks: [], requests: [], edits: [], submits: 0 });
    element = document.createElement(mode === 'list' ? 'ul' : mode === 'ol' ? 'ol' : ['role-list', 'grid'].includes(mode) ? 'div' : 'table');
    if (mode === 'role-list' || mode === 'grid') element.setAttribute('role', mode === 'grid' ? 'grid' : 'list');
    if (element.tagName === 'TABLE') {
      element.innerHTML = '<thead><tr><th>记录</th><th>任意自定义列</th><th>业务编辑</th><th>安全内容</th></tr></thead><tbody></tbody>';
      element.className = mode === 'fusion' ? 'next-table' : mode === 'antd' ? 'ant-table' : '';
    }
    element.style.setProperty('display', element.tagName === 'TABLE' ? 'table' : 'block', 'important');
    // Only the live table/list delegates business operations. Detached old rows have no handler.
    element.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      const row = button?.closest('[data-row-key]');
      if (!row || !element.contains(row)) return;
      const id = Number(row.dataset.rowKey);
      controls.edits.push({ id, page, action: button.dataset.action, connected: button.isConnected,
        visible: button.getClientRects().length > 0 && getComputedStyle(element).display !== 'none' });
      if (controls.hashDetails && button.dataset.action === 'inspect') {
        detailUrl = location.href;
        drawer.hidden = false;
        location.hash = 'click-detail-' + id;
      }
    });
    pager = document.createElement(mode === 'antd' ? 'ul' : mode === 'fusion' ? 'div' : 'nav');
    if (mode === 'fusion') {
      pager.className = 'next-pagination';
      pager.innerHTML = '<button type="button" class="next-prev">‹</button><button type="button" class="next-current">1</button><button type="button" class="next-next">›</button>';
      current = pager.querySelector('.next-current');
      next = pager.querySelector('.next-next');
      prev = pager.querySelector('.next-prev');
    } else if (mode === 'antd') {
      pager.className = 'ant-pagination';
      pager.innerHTML = '<li class="ant-pagination-prev"><button type="button">‹</button></li><li class="ant-pagination-item ant-pagination-item-active">1</li><li class="ant-pagination-next"><button type="button">›</button></li>';
      current = pager.querySelector('.ant-pagination-item-active');
      next = pager.querySelector('.ant-pagination-next button');
      prev = pager.querySelector('.ant-pagination-prev button');
    } else {
      pager.className = 'pagination';
      pager.setAttribute('aria-label', '分页');
      pager.innerHTML = '<button type="button" aria-label="previous">‹</button><span aria-current="page">1</span><button type="button" aria-label="next">›</button>';
      current = pager.querySelector('[aria-current]');
      next = pager.querySelector('[aria-label="next"]');
      prev = pager.querySelector('[aria-label="previous"]');
    }
    pager.style.setProperty('display', 'flex', 'important');
    for (const [button, direction] of [[next, 1], [prev, -1]]) {
      button.addEventListener('click', () => {
        controls.clicks.push({ direction, page });
        if (controls.behavior !== 'noop' && !busy) void requestPage(page + direction);
      });
    }
    if (numbered) for (let target = 1; target <= maxPage; target++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = target;
      button.dataset.fixturePage = target;
      button.addEventListener('click', () => {
        controls.clicks.push({ target, page });
        if (controls.behavior !== 'noop' && !busy) void requestPage(target);
      });
      pager.append(button);
    }
    scope.replaceChildren(element, pager);
    render(rows(1));
    paintPager();
    window.clickFixtureInjected = false;
  }
  controls.reset = reset; // Only test controls are exposed, never the native loader/state.
  apply.addEventListener('click', () => {
    keyword = query.value;
    void requestPage(1, true);
  });
  reset(options);

  window.fixtureData = {}; // Both the module and this site are closed by default.
  window.chrome = { runtime: { onMessage: { addListener() {}, removeListener() {} } }, storage: { local: {
    async get() { return { ...window.fixtureData }; },
    async set(values) { Object.assign(window.fixtureData, values); },
  } } };
  const initModule = async () => {
    window.browserModule?.destroy();
    window.browserModule = new ContinuousBrowse();
    window.browserReady = browserModule.init();
    await browserReady;
  };
  const authorize = async () => {
    await chrome.storage.local.set({ continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [location.hostname] });
    await initModule(); // Exercise init's automatic discovery, not a stubbed start/detect.
  };
  document.querySelector('#click-start').onclick = authorize;
  for (const command of ['pause', 'resume', 'stop']) {
    document.querySelector('#click-' + command).onclick = () => browserModule.command(command);
  }
  initModule();
  let running = false;
  window.runClickRegression = async ({ scroll = false, interactionOnly = false } = {}) => {
    if (running) throw new Error('按钮分页回归已在运行');
    running = true;
    runButton.disabled = true;
    const checks = [], adapters = new Set(), controllers = new Set();
    const originalFetch = window.fetch, originalOpen = XMLHttpRequest.prototype.open;
    let networkCalls = 0;
    const forbidNetwork = () => { networkCalls++; throw new Error('按钮分页不得猜测 URL 或调用 API'); };
    const assert = (name, pass) => { checks.push({ name, pass: !!pass }); if (!pass) throw new Error(name); };
    const ids = root => [...root.querySelectorAll('a[href]')].map(link => link.textContent.match(/条目 (\d+)$/)?.[1]).filter(Boolean).join();
    const host = () => document.querySelector('[data-geek-continuous-browse]');
    const copies = () => host()?.shadowRoot;
    const copyIds = root => [...(root?.querySelectorAll('section') || [])].map(ids).filter(Boolean).join();
    const style = node => [node.style.getPropertyValue('display'), node.style.getPropertyPriority('display')].join('|');
    const silence = () => browserModule._observer?.disconnect();
    const waitFor = async (test, message = '按钮分页状态超时', timeout = 3000) => {
      const end = Date.now() + timeout;
      while (!test()) { if (Date.now() > end) throw new Error(message); await delay(10); }
    };
    const bounded = async (promise, timeout = 3500) => {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('按钮分页操作未及时结束')), timeout);
        })]);
      } finally { clearTimeout(timer); }
    };
    const settle = () => waitFor(() => !controls.pending && !controls.busy, '原生请求未完成');
    const prepare = async (nextMode = options.mode, behavior = 'normal', latency = 100, fixtureOptions = {}) => {
      browserModule.destroy();
      await settle();
      reset({ ...fixtureOptions, mode: nextMode, behavior, delay: latency });
      window.scrollTo(0, 0);
      window.fixtureData = {};
      await initModule();
      silence();
    };
    const test = async (name, run, interaction = false) => {
      if (interactionOnly && !interaction) return;
      try { await run(); } catch (error) { checks.push({ test: name, error: error.message }); }
      finally {
        for (const controller of controllers) controller.abort();
        for (const adapter of adapters) adapter.destroy();
        adapters.clear();
        browserModule.destroy();
        closeDetail();
        try { await settle(); } catch (error) { checks.push({ test: name + ' cleanup', error: error.message }); }
      }
    };
    const interactionTest = (name, run) => test(name, run, true);
    const assertClean = (root, expected) => {
      assert('净化脚本、输入及业务编辑控件', !root.querySelector('script,iframe,object,embed,input,textarea,select,button,form,[contenteditable]'));
      assert('净化所有事件属性和 JS href', [...root.querySelectorAll('*')].every(node => [...node.attributes].every(attr =>
        !/^on/i.test(attr.name) && (attr.name !== 'href' || !/^javascript:/i.test(attr.value.replace(/[\s\u0000-\u001f]/g, ''))))));
      assert('未知自定义列保留可读文本而非自定义组件', !root.querySelector('fixture-column')
        && expected.split(',').every(id => root.textContent.includes('自定义值-' + id)));
      assert('副本未执行脚本或事件', !window.clickFixtureInjected);
    };
    const direct = async (nextMode, behavior = 'normal') => {
      await prepare(nextMode, behavior);
      const adapter = ContinuousBrowseClickAdapter.detect();
      assert(nextMode + ' detect 返回通用只读适配器', adapter?.name === '通用按钮分页（只读）');
      adapters.add(adapter);
      assert(nextMode + ' 声明自管隐藏与变更、非原生编辑', adapter.hideOriginal === false && adapter.handlesMutations === true && !adapter.interactive);
      assert(nextMode + ' start 成功', adapter.start() !== false);
      const root = document.createElement('div');
      const initial = adapter.initial();
      assert(nextMode + ' initial 提供脱离原 DOM 的副本', !!initial && initial !== element && !element.contains(initial));
      root.append(initial);
      assert(nextMode + ' 首屏三条且没有原生请求', ids(root) === '1,2,3' && adapter.loaded === 3 && controls.clicks.length === 0 && adapter.isCurrent());
      return { adapter, root };
    };
    const request = (adapter, abortAfter = 2200) => {
      const controller = new AbortController();
      controllers.add(controller);
      let settled = false;
      const timer = setTimeout(() => controller.abort(), abortAfter);
      // Catch immediately, including failure cases tested before awaiting their result.
      const promise = bounded(Promise.resolve().then(() => adapter.load(controller.signal)), abortAfter + 600)
        .then(fragment => ({ fragment }), error => ({ error })).finally(() => {
          settled = true;
          clearTimeout(timer);
          controllers.delete(controller);
        });
      return { controller, promise, get settled() { return settled; } };
    };
    const prepareInteraction = async (fixtureOptions = {}) => {
      await prepare(fixtureOptions.mode || 'semantic', 'normal', 50, fixtureOptions);
      await authorize();
      silence();
      assert('交互测试经显式授权自动开启真实 ClickAdapter', browserModule.adapter instanceof ContinuousBrowseClickAdapter
        && browserModule.pages === 1 && browserModule.adapter.loaded === 3);
      const interact = browserModule._interact;
      assert('主模块提供真实 _interact 入口', typeof interact === 'function');
      const calls = [];
      // Observe promises/signals only; the real module still controls pause, concurrency and cancellation.
      browserModule._interact = function (action) {
        const call = { started: false, finished: false };
        calls.push(call);
        const promise = interact.call(this, async signal => {
          call.started = true;
          call.signal = signal;
          try { return await action(signal); }
          catch (error) { call.error = error; throw error; }
          finally { call.finished = true; }
        });
        call.promise = Promise.resolve(promise);
        call.promise.catch(() => {});
        return promise;
      };
      return calls;
    };
    const copyControl = (id, text = '原生查看') => {
      const link = [...copies().querySelectorAll('section a[href]')].find(link => new URL(link.href).pathname === '/record/' + id);
      const row = link?.closest('tr');
      const control = [...(row?.querySelectorAll('span') || [])].find(span => span.textContent === text);
      assert('副本操作仍净化为 span：' + id + ' / ' + text, !!control && !row.querySelector('button'));
      return control;
    };
    const clickCopy = (calls, id, text) => {
      const before = calls.length;
      copyControl(id, text).click();
      assert('副本 click 恰好经过一次主模块交互入口', calls.length === before + 1);
      return calls.at(-1);
    };
    const finishInteraction = async (call, rejected = false) => {
      await bounded(call.promise, 6000);
      await settle();
      assert(rejected ? '真实 activate 明确拒绝操作' : '真实 activate 完成操作', call.started && call.finished && !!call.error === rejected);
    };
    const loadThrough = async target => {
      while (browserModule.pages < target) {
        const before = browserModule.pages;
        await bounded(browserModule._load(), 6000);
        silence();
        assert('逐页加载只增加一页', browserModule.pages === before + 1);
      }
    };
    const savedCopies = () => ({
      adapter: browserModule.adapter, host: host(), root: copies(), session: browserModule._session,
      pages: browserModule.pages, loaded: browserModule.adapter.loaded, highest: browserModule.adapter.page,
      ids: copyIds(copies()), sections: [...copies().querySelectorAll('section')].map(node => ({ node, html: node.innerHTML })),
    });
    const unchangedCopies = saved => copyIds(saved.root) === saved.ids
      && saved.root.querySelectorAll('section').length === saved.sections.length
      && saved.sections.every(({ node, html }, index) => saved.root.querySelectorAll('section')[index] === node && node.innerHTML === html);
    const assertPreserved = saved => assert('同一会话保留全部副本节点、内容、条数和最高已加载页',
      browserModule.adapter === saved.adapter && host() === saved.host && saved.host.isConnected
      && browserModule._session === saved.session && browserModule.pages === saved.pages
      && saved.adapter.loaded === saved.loaded && saved.adapter.page === saved.highest && unchangedCopies(saved));
    const assertEdit = (id, page, action = 'inspect', count = 1) => {
      const edit = controls.edits.at(-1);
      assert('只执行指定原按钮且业务看到正确 id/page/action：' + id + '/' + page + '/' + action,
        controls.edits.length === count && edit.id === id && edit.page === page && edit.action === action
        && edit.connected && edit.visible);
    };
    try {
      await browserReady;
      window.fetch = forbidNetwork;
      XMLHttpRequest.prototype.open = forbidNetwork;
      assert('现有 scripts 清单导出 ContinuousBrowseClickAdapter.detect', typeof ContinuousBrowseClickAdapter !== 'undefined'
        && typeof ContinuousBrowseClickAdapter.detect === 'function');
      await test('授权、暂停、异步累积、关闭及原生交互', async () => {
        await prepare();
        for (const settings of [{}, { continuousBrowseModuleEnabled: true }, { enabledContinuousBrowseSites: [location.hostname] }]) {
          window.fixtureData = settings;
          await initModule();
          await browserModule.command('start');
          assert('缺少任一显式许可均默认关闭', !browserModule.adapter && !host() && controls.clicks.length === 0);
        }
        const original = element, originalPager = pager, beforeStyle = style(element), pagerStyle = style(pager);
        await authorize();
        silence();
        const adapter = browserModule.adapter;
        assert('显式许可后 init 自动识别通用按钮分页', adapter?.name === '通用按钮分页（只读）' && browserModule.pages === 1);
        assert('原内容及分页隐藏，副本是只读', !adapter.hideOriginal && adapter.handlesMutations && !adapter.interactive
          && getComputedStyle(element).display === 'none' && getComputedStyle(pager).display === 'none');
        assert('首屏复制三条', copyIds(copies()) === '1,2,3');
        assertClean(copies().querySelector('section'), '1,2,3');
        const firstCopy = copies().querySelector('section'), firstHTML = firstCopy.innerHTML;
        await browserModule.command('pause');
        await browserModule._load();
        await delay(150);
        assert('暂停不点击且无请求', controls.clicks.length === 0 && controls.requests.length === 0 && browserModule.pages === 1);
        await browserModule.command('resume');
        silence();
        const loading = browserModule._load(), duplicate = browserModule._load();
        await waitFor(() => controls.busy);
        assert('并发触发只点一次，页码先变且原内容尚未变', controls.page === 2 && ids(element) === '1,2,3'
          && controls.clicks.length === 1 && controls.requests.length === 1);
        assert('页码提前变化不复制旧页或计为成功', copyIds(copies()) === '1,2,3' && browserModule.pages === 1 && adapter.loaded === 3);
        await bounded(Promise.all([loading, duplicate]));
        silence();
        assert('原生变化不误退出，重叠记录只保留一次', browserModule.adapter === adapter && adapter.isCurrent()
          && browserModule.pages === 2 && adapter.loaded === 5 && copyIds(copies()) === '1,2,3,4,5'
          && ids(element) === '3,4,5' && !controls.busy && controls.requests.length === 1 && firstCopy.innerHTML === firstHTML);
        for (const section of copies().querySelectorAll('section')) assertClean(section, ids(section));
        await bounded(browserModule._load());
        silence();
        assert('第三页末页禁用且累计七条', browserModule.state === 'done' && browserModule.pages === 3 && adapter.loaded === 7
          && !adapter.nextUrl && controls.next.disabled && copyIds(copies()) === '1,2,3,4,5,6,7' && ids(element) === '6,7');
        await browserModule._load();
        assert('末页不再点击', controls.clicks.length === 2 && controls.requests.length === 2);
        const lastHTML = element.innerHTML, nativeEdit = element.querySelector('button'), nativeInput = element.querySelector('input');
        await browserModule.command('stop');
        assert('关闭保留原 DOM、最后一页和 display 优先级，不偷点第一页', !host() && !browserModule.adapter && !adapter.isCurrent()
          && element === original && pager === originalPager && element.innerHTML === lastHTML && controls.page === 3
          && style(element) === beforeStyle && style(pager) === pagerStyle && controls.clicks.length === 2 && controls.requests.length === 2);
        nativeInput.click();
        nativeEdit.click();
        assert('恢复原页输入及原业务事件', nativeInput.checked && controls.edits.length === 1 && controls.edits[0].id === 6 && controls.edits[0].page === 3);
        controls.prev.click();
        await settle();
        assert('关闭后原生上一页仍可交互', controls.page === 2 && ids(element) === '3,4,5' && controls.clicks.length === 3);
        await initModule();
        assert('关闭撤销本站许可，下次初始化仍关闭', !fixtureData.enabledContinuousBrowseSites.includes(location.hostname) && !browserModule.adapter && !host());
      });
      for (const nextMode of ['semantic', 'fusion', 'antd', 'list', 'ol', 'role-list', 'grid']) {
        await test(nextMode + ' 纯 DOM 契约', async () => {
          const { adapter, root } = await direct(nextMode);
          assertClean(root, '1,2,3');
          const saved = root.innerHTML;
          const loading = request(adapter);
          await waitFor(() => controls.busy);
          await delay(30);
          assert(nextMode + ' 页码先变时等待内容', controls.page === 2 && ids(element) === '1,2,3' && !loading.settled && root.innerHTML === saved);
          const second = await loading.promise;
          assert(nextMode + ' 只点击一次且等到稳定才返回新记录', !second.error && !!second.fragment && !controls.busy
            && controls.clicks.length === 1 && controls.requests.length === 1 && ids(second.fragment) === '4,5');
          root.append(second.fragment);
          const third = await request(adapter).promise;
          assert(nextMode + ' 最后一页成功', !third.error && !!third.fragment && ids(third.fragment) === '6,7');
          root.append(third.fragment);
          assert(nextMode + ' 累积去重、保持原生单页并识别禁用末页', ids(root) === '1,2,3,4,5,6,7'
            && ids(element) === '6,7' && adapter.loaded === 7 && !adapter.nextUrl && controls.next.disabled && adapter.isCurrent());
          assertClean(root, '1,2,3,4,5,6,7');
          adapter.destroy();
          adapter.destroy();
          assert(nextMode + ' destroy 幂等且不回第一页', !adapter.isCurrent() && controls.page === 3 && controls.clicks.length === 2);
        });
      }
      await test('分阶段内容稳定后才复制', async () => {
        const { adapter, root } = await direct('semantic', 'staged');
        const loading = request(adapter);
        await waitFor(() => controls.requests[0]?.stage);
        assert('中间 DOM 已变化，但 busy 时不得返回半页', ids(element) === '3,4' && controls.busy && !loading.settled && adapter.loaded === 3);
        const outcome = await loading.promise;
        assert('等到最终内容及 busy 结束', !outcome.error && !!outcome.fragment && !controls.busy && ids(outcome.fragment) === '4,5');
        root.append(outcome.fragment);
        assert('不丢失分阶段追加的记录', ids(root) === '1,2,3,4,5');
      });
      for (const behavior of ['duplicate', 'noop', 'fail']) {
        await test(behavior + ' 不伪造成功且可提前取消', async () => {
          const { adapter, root } = await direct('semantic', behavior);
          const before = root.innerHTML;
          const loading = request(adapter, 500);
          await delay(40);
          assert(behavior + ' 不提前返回旧内容', !loading.settled && adapter.loaded === 3);
          if (behavior === 'noop') loading.controller.abort(); // Never wait for the production 15s deadline.
          const outcome = await loading.promise;
          assert(behavior + ' 明确失败而不是返回旧页', !!outcome.error && !outcome.fragment && adapter.loaded === 3 && root.innerHTML === before);
          if (behavior === 'noop') assert('AbortController 立即结束 no-op 等待', outcome.error.name === 'AbortError');
          await settle();
          assert(behavior + ' 仅一次点击且无自动重试或回滚点击', controls.clicks.length === 1 && controls.requests.length === (behavior === 'noop' ? 0 : 1)
            && ids(element) === '1,2,3' && controls.page === (behavior === 'noop' ? 1 : 2));
        });
      }
      for (const change of ['filter', 'content', 'structure', 'pager']) {
        await test('外部变化失效：' + change, async () => {
          const { adapter, root } = await direct('semantic');
          const before = root.innerHTML;
          if (change === 'filter') {
            query.value = '新筛选';
            query.dispatchEvent(new Event('input', { bubbles: true }));
            query.dispatchEvent(new Event('change', { bubbles: true }));
            apply.click();
          } else if (change === 'content') element.querySelector('a').textContent = '原内容已更新';
          else if (change === 'structure') element.replaceWith(element.cloneNode(true));
          else pager.replaceWith(pager.cloneNode(true));
          await waitFor(() => !adapter.isCurrent(), change + ' 未使旧会话失效');
          adapter.destroy();
          await settle();
          assert(change + ' 清理不覆盖外部变化，不追加旧内容', !adapter.isCurrent() && root.innerHTML === before && controls.clicks.length === 0);
          if (change === 'filter') assert('筛选保留新原生内容', ids(element) === '101,102,103' && element.textContent.includes('新筛选'));
          if (change === 'content') assert('原内容修改不会被旧副本覆盖', element.textContent.includes('原内容已更新'));
          if (change === 'structure') assert('保留替换后的新列表', !element.isConnected && !!scope.querySelector('table'));
          if (change === 'pager') assert('保留替换后的新分页器', !pager.isConnected && !!scope.querySelector('nav'));
        });
      }
      for (const cancel of ['stop', 'filter']) {
        await test('慢请求中' + cancel + ' 无迟到追加', async () => {
          await prepare();
          await authorize();
          silence();
          const adapter = browserModule.adapter;
          assert('慢请求前有活动会话', !!adapter);
          const oldCopies = copies(), before = copyIds(oldCopies);
          controls.behavior = 'slow';
          const loading = browserModule._load();
          await waitFor(() => controls.busy);
          if (cancel === 'stop') await browserModule.command('stop');
          else {
            query.value = '新筛选';
            query.dispatchEvent(new Event('input', { bubbles: true }));
            query.dispatchEvent(new Event('change', { bubbles: true }));
            apply.click();
            await waitFor(() => !adapter.isCurrent(), '在途筛选未中止会话');
            await browserModule.command('status'); // Existing context checking, no private adapter hooks.
          }
          assert(cancel + ' 在原请求未完成时终止旧会话', controls.pending > 0 && !adapter.isCurrent() && browserModule.adapter !== adapter);
          await bounded(loading);
          await settle();
          await delay(400);
          silence();
          assert(cancel + ' 晚到响应不计数或追加到旧副本', adapter.loaded === 3 && copyIds(oldCopies) === before && controls.clicks.length === 1);
          if (cancel === 'stop') assert('关闭后原生晚到第二页保持可用，不重启', controls.page === 2 && ids(element) === '3,4,5'
            && !host() && !browserModule.adapter && getComputedStyle(element).display !== 'none' && getComputedStyle(pager).display !== 'none');
          else assert('筛选后只显示新查询，旧响应不覆盖或混入', ids(element) === '101,102,103'
            && (!host() || copyIds(copies()) === '101,102,103') && controls.requests[0].applied === false);
        });
      }
      for (const shape of ['two-pagers', 'two-lists', 'two-pairs', 'two-next', 'no-current', 'orphan', 'no-list', 'submit', 'implicit-submit']) {
        await test('拒绝歧义或危险分页：' + shape, async () => {
          await prepare('semantic');
          if (shape === 'two-pagers') scope.append(pager.cloneNode(true));
          if (shape === 'two-lists') scope.prepend(element.cloneNode(true));
          if (shape === 'two-pairs') {
            const pair = document.createElement('section');
            pair.append(element.cloneNode(true), pager.cloneNode(true));
            scope.after(pair);
            // Remove this extra scope even when the rejection assertion fails.
            pair.dataset.clickTemporary = 'true';
          }
          if (shape === 'two-next') pager.append(next.cloneNode(true));
          if (shape === 'no-current') current.remove();
          if (shape === 'orphan') { scope.append(next); pager.remove(); }
          if (shape === 'no-list') element.remove();
          if (shape.endsWith('submit')) {
            const form = document.createElement('form');
            form.addEventListener('submit', event => { event.preventDefault(); controls.submits++; });
            pager.before(form);
            form.append(pager);
            if (shape === 'submit') next.type = 'submit';
            else next.removeAttribute('type');
          }
          try {
            const adapter = ContinuousBrowseClickAdapter.detect();
            if (adapter) adapters.add(adapter);
            if (shape.endsWith('submit')) {
              if (adapter && adapter.start() !== false) await request(adapter, 120).promise;
              assert(shape + ' 不点击表单提交按钮', controls.clicks.length === 0 && controls.requests.length === 0 && controls.submits === 0);
            } else assert(shape + ' 不检测', !adapter);
            assert(shape + ' detect 无点击副作用', controls.clicks.length === 0 && controls.requests.length === 0);
          } finally { document.querySelectorAll('[data-click-temporary]').forEach(node => node.remove()); }
        });
      }
      if (scroll) await test('真实滚动触发与暂停', async () => {
        await prepare();
        await authorize();
        silence();
        assert('滚动测试已自动开启', !!browserModule.adapter && !!copies());
        const sentinel = copies().querySelector('.sentinel');
        await browserModule.command('pause');
        sentinel.scrollIntoView({ block: 'end', behavior: 'instant' });
        await delay(150);
        assert('暂停后滚动也无请求', controls.clicks.length === 0);
        window.scrollTo(0, 0);
        await browserModule.command('resume');
        await delay(100);
        assert('观察点未进入视口不点击', controls.clicks.length === 0);
        sentinel.scrollIntoView({ block: 'end', behavior: 'instant' });
        await waitFor(() => controls.clicks.length > 0, '真实 IntersectionObserver 未触发');
        await browserModule.command('pause');
        await waitFor(() => browserModule.pages === 2, '滚动请求未追加');
        await delay(150);
        assert('真实 scroll 只触发一页，暂停阻止后续请求', controls.clicks.length === 1 && controls.requests.length === 1
          && browserModule.state === 'paused' && copyIds(copies()) === '1,2,3,4,5');
      });
      await interactionTest('同格双按钮与当前页无额外分页', async () => {
        const calls = await prepareInteraction();
        const nativeButtons = element.tBodies[0].rows[0].querySelectorAll('button');
        assert('每行同一格两个原按钮', nativeButtons.length === 2 && nativeButtons[0].parentElement === nativeButtons[1].parentElement);
        const saved = savedCopies();
        assertClean(saved.sections[0].node, '1,2,3');
        await finishInteraction(clickCopy(calls, 1));
        assertEdit(1, 1);
        assert('当前页第二按钮不分页且保持暂停，原表可见', controls.requests.length === 0 && controls.clicks.length === 0
          && browserModule.state === 'paused' && getComputedStyle(element).display !== 'none');
        assertPreserved(saved);
        await finishInteraction(clickCopy(calls, 1, '原生编辑'));
        assertEdit(1, 1, 'edit', 2);
        assert('两个副本分别对应两个原按钮，不借用整格首按钮', controls.edits.map(edit => edit.action).join() === 'inspect,edit'
          && controls.requests.length === 0 && browserModule.state === 'paused');
        assertPreserved(saved);
      });
      for (const reuseRows of [false, true]) {
        await interactionTest((reuseRows ? '复用行及按钮 / 数字分页' : '卸载旧 DOM / prev-next') + ' 回页后继续无重复', async () => {
          // A fourth page exists only in this opt-in case, so resuming from loaded page3 must append real new rows.
          const calls = await prepareInteraction({ reuseRows, numbered: reuseRows, maxPage: 4 });
          const original = element, oldRow = element.tBodies[0].rows[0], oldButton = oldRow.querySelectorAll('button')[1];
          await loadThrough(3);
          const saved = savedCopies();
          assert('已加载三页七条且原站在 page3', saved.ids === '1,2,3,4,5,6,7' && saved.loaded === 7
            && saved.pages === 3 && saved.highest === 3 && controls.page === 3 && ids(element) === '6,7');
          if (reuseRows) assert('相同位置行及按钮被复用，data-row-key 从1变6', element.tBodies[0].rows[0] === oldRow
            && oldRow.dataset.rowKey === '6' && oldRow.querySelectorAll('button')[1] === oldButton);
          else {
            assert('原 table 保留而旧行和旧按钮已卸载', element === original && !oldRow.isConnected && !oldButton.isConnected);
            oldButton.click();
            assert('脱离原 table 的旧按钮无法触发委托业务', controls.edits.length === 0);
          }
          const returning = clickCopy(calls, 1);
          await waitFor(() => controls.busy);
          const concurrent = clickCopy(calls, 2);
          await bounded(concurrent.promise);
          await browserModule.command('resume');
          await browserModule._load();
          assert('在途交互禁止并发点击及恢复加载', !concurrent.started && browserModule.state === 'paused'
            && controls.edits.length === 0 && controls.requests.length === 3);
          await finishInteraction(returning);
          assertEdit(1, 1);
          assert('旧副本恢复原 id1 而非位置上的新记录6，原表可见', controls.page === 1 && ids(element) === '1,2,3'
            && !controls.edits.some(edit => edit.id === 6) && saved.adapter.nativePage === 1
            && browserModule.state === 'paused' && getComputedStyle(element).display !== 'none');
          assert('通过原分页按钮回页', controls.requests.map(request => request.page).join() === (reuseRows ? '2,3,1' : '2,3,2,1'));
          assertPreserved(saved);
          await browserModule._load();
          assert('交互后暂停不偷偷追加', unchangedCopies(saved) && browserModule.pages === 3 && controls.page === 1);
          await browserModule.command('resume');
          silence();
          assert('继续时先隐藏原表及分页器', getComputedStyle(element).display === 'none' && getComputedStyle(pager).display === 'none');
          await loadThrough(4);
          assert('先回最高已加载页再追加第四页，旧页不重复', controls.requests.map(request => request.page).join()
            === (reuseRows ? '2,3,1,3,4' : '2,3,2,1,2,3,4'));
          assert('继续后仍为原会话、九条四页且末页完成', browserModule.adapter === saved.adapter && host() === saved.host
            && browserModule._session === saved.session && browserModule.pages === 4 && saved.adapter.page === 4
            && saved.adapter.nativePage === 4 && saved.adapter.loaded === 9 && browserModule.state === 'done'
            && copyIds(copies()) === '1,2,3,4,5,6,7,8,9' && copies().querySelectorAll('section').length === 4
            && saved.sections.every(({ node, html }, index) => copies().querySelectorAll('section')[index] === node && node.innerHTML === html)
            && controls.edits.length === 1);
          assert('继续加载完成后原表保持隐藏', getComputedStyle(element).display === 'none');
          for (const section of copies().querySelectorAll('section')) assertClean(section, ids(section));
        });
      }
      await interactionTest('加载中点击只提示等待，不排队迟到执行', async () => {
        const calls = await prepareInteraction();
        controls.delay = 250;
        const loading = browserModule._load();
        await waitFor(() => controls.busy);
        const blocked = clickCopy(calls, 1);
        await bounded(blocked.promise);
        assert('正在加载时不执行交互并提示完成后再点', !blocked.started && controls.edits.length === 0
          && browserModule.state === 'paused' && /等待|完成|再次|重试/.test(browserModule.status().message));
        await bounded(loading);
        silence();
        await settle();
        assert('加载完成保留两页并暂停，不迟到触发业务', browserModule.pages === 2 && browserModule.adapter.loaded === 5
          && copyIds(copies()) === '1,2,3,4,5' && browserModule.state === 'paused' && controls.edits.length === 0
          && controls.requests.map(request => request.page).join() === '2');
        const saved = savedCopies();
        await finishInteraction(clickCopy(calls, 1));
        assertEdit(1, 1);
        assertPreserved(saved);
      });
      for (const cancel of ['abort', 'filter']) {
        await interactionTest('load 在 await navigate 返回后 ' + cancel + ' 不发下一页', async () => {
          await prepareInteraction();
          const saved = savedCopies(), adapter = saved.adapter;
          const navigate = adapter.navigate, turnPage = adapter.turnPage;
          let navigated = false, turns = 0;
          // Keep real navigate/turnPage; inject only at the await boundary, before load resumes.
          adapter.navigate = async function (...args) {
            await navigate.apply(this, args);
            navigated = this.isCurrent() && !this.pending && this.nativePage === this.page && !controls.next.disabled;
            queueMicrotask(() => {
              if (cancel === 'abort') loading.controller.abort();
              else {
                query.value = 'navigate 后新筛选';
                query.dispatchEvent(new Event('input', { bubbles: true }));
                query.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          };
          adapter.turnPage = function (...args) { turns++; return turnPage.apply(this, args); };
          const loading = request(adapter);
          try {
            const outcome = await loading.promise;
            assert(cancel + ' 在真实 navigate 完成且下一页可用时拒绝 load', navigated && !!outcome.error && !outcome.fragment);
            assert(cancel + ' load 自身重校验，不依赖 turnPage preflight 阻止点击', turns === 0
              && controls.clicks.length === 0 && controls.requests.length === 0 && controls.edits.length === 0 && controls.page === 1);
            if (cancel === 'abort') assert('navigate 后取消保留 AbortError', outcome.error.name === 'AbortError' && loading.controller.signal.aborted);
            else assert('navigate 后筛选使旧 context 失效且保留新输入', !adapter.isCurrent() && query.value === 'navigate 后新筛选');
            assertPreserved(saved);
          } finally { adapter.navigate = navigate; adapter.turnPage = turnPage; }
        });
      }
      for (const cancel of ['stop', 'filter']) {
        await interactionTest('回页在途 ' + cancel + ' 不得迟到执行', async () => {
          const calls = await prepareInteraction({ numbered: true, maxPage: 4 });
          await loadThrough(3);
          const saved = savedCopies();
          controls.behavior = 'slow';
          const returning = clickCopy(calls, 1);
          await waitFor(() => controls.busy && controls.requests.length === 3);
          const request = controls.requests[2];
          assert('确实在请求回 page1，原 DOM 尚为 page3', request.page === 1 && !request.completed && ids(element) === '6,7'
            && returning.started && !returning.finished && controls.edits.length === 0);
          if (cancel === 'stop') await browserModule.command('stop');
          else {
            query.value = '交互中新筛选';
            query.dispatchEvent(new Event('input', { bubbles: true }));
            query.dispatchEvent(new Event('change', { bubbles: true }));
            apply.click();
            await browserModule.command('status');
          }
          assert(cancel + ' 在原响应到达前结束旧会话', controls.pending > 0 && !saved.adapter.isCurrent()
            && browserModule.adapter !== saved.adapter);
          await finishInteraction(returning, true);
          await delay(400); // Include delayed native completion and the module's auto-start debounce.
          browserModule._checkContext();
          silence();
          assert(cancel + ' 迟到响应不触发任何业务、不修改旧副本和计数', controls.edits.length === 0
            && saved.adapter.loaded === 7 && unchangedCopies(saved) && request.completed && controls.clicks.length === 3);
          if (cancel === 'stop') assert('关闭取消 signal 且仅恢复原站单页，不自动重启', returning.signal.aborted
            && controls.page === 1 && ids(element) === '1,2,3' && !host() && !browserModule.adapter
            && !fixtureData.enabledContinuousBrowseSites.includes(location.hostname)
            && getComputedStyle(element).display !== 'none' && getComputedStyle(pager).display !== 'none');
          else assert('新筛选胜出，旧回页响应被丢弃且不混入副本', !request.applied && ids(element) === '101,102,103'
            && (!host() || copyIds(copies()) === '101,102,103'));
        });
      }
      for (const change of ['disabled', 'aria-disabled', 'pointer-events', 'structure', 'target-signature', 'target-text', 'row-key', 'row-text']) {
        await interactionTest('回页核对拒绝：' + change, async () => {
          const calls = await prepareInteraction();
          await loadThrough(2);
          const saved = savedCopies();
          let mutated = false;
          // Mutate only the freshly returned original row, after its immutable copy was made.
          controls.mutateRow = (row, { id, page }) => {
            if (id !== 1 || page !== 1) return;
            mutated = true;
            const button = row.querySelectorAll('button')[1];
            if (change === 'disabled') button.disabled = true;
            if (change === 'aria-disabled') button.setAttribute('aria-disabled', 'true');
            if (change === 'pointer-events') button.style.pointerEvents = 'none';
            if (change === 'structure') {
              const wrapper = document.createElement('div');
              button.replaceWith(wrapper);
              wrapper.append(button);
            }
            if (change === 'target-signature') button.dataset.action = 'different-operation';
            if (change === 'target-text') button.textContent = '操作内容已变';
            if (change === 'row-key') row.dataset.rowKey = '901';
            if (change === 'row-text') row.querySelector('p').textContent = '记录正文已变化';
          };
          const call = clickCopy(calls, 1);
          await finishInteraction(call, true);
          assert(change + ' 真正回页后拒绝，不执行首按钮或变化后的操作', mutated && controls.requests.map(request => request.page).join() === '2,1'
            && controls.edits.length === 0 && saved.adapter.loaded === 5 && unchangedCopies(saved));
          if (change === 'pointer-events') assert('恢复可见后仍拒绝 pointer-events:none 的原按钮',
            /不可点击/.test(call.error.message) && getComputedStyle(element).display !== 'none'
            && getComputedStyle(element.querySelector('[data-action="inspect"]')).pointerEvents === 'none');
        });
      }
      await interactionTest('child span 不变而父按钮 data-action 改变也拒绝', async () => {
        const nest = row => {
          const button = row.querySelector('[data-action="inspect"]');
          const child = document.createElement('span');
          child.textContent = button.textContent;
          button.replaceChildren(child);
        };
        const calls = await prepareInteraction({ mutateRow: nest });
        const original = element.querySelector('[data-row-key="1"]');
        const rowText = original.textContent, leafHTML = original.querySelector('button[data-action="inspect"] span').outerHTML;
        await loadThrough(2);
        const saved = savedCopies();
        const copiedButton = copyControl(1), child = copiedButton.querySelector('span');
        assert('副本保留按钮内 child span 且有独立点击映射', !!child && child.parentElement === copiedButton
          && saved.adapter.copyTargets.has(child));
        let returned;
        controls.mutateRow = (row, context) => {
          nest(row);
          if (context.id !== 1 || context.page !== 1) return;
          row.querySelector('button[data-action="inspect"]').dataset.action = 'different-operation';
          returned = row;
        };
        const before = calls.length;
        child.click(); // Target the unchanged leaf, not the sanitized parent button span.
        assert('点击 child span 恰好经过一次真实交互入口', calls.length === before + 1);
        await finishInteraction(calls.at(-1), true);
        assert('仅父按钮签名变化，row key/text 与 leaf 均不变', returned?.dataset.rowKey === '1'
          && returned.textContent === rowText && returned.querySelector('button[data-action="different-operation"] span')?.outerHTML === leafHTML);
        assert('整条祖先 path 校验拒绝业务，不误用 leaf 或同格首按钮', controls.edits.length === 0
          && controls.requests.map(request => request.page).join() === '2,1' && controls.clicks.length === 2);
        assertPreserved(saved);
      });
      await interactionTest('旧页真实链接保留 href / _blank，不回页', async () => {
        const calls = await prepareInteraction();
        const href = element.querySelector('a').href;
        await loadThrough(3);
        const saved = savedCopies();
        const link = [...copies().querySelectorAll('section a[href]')].find(link => link.href === href);
        assert('真实链接保留原绝对 href 和新标签 target', !!link && href === location.origin + '/record/1'
          && link.getAttribute('href') === href && link.target === '_blank');
        let reached = false, prevented;
        const preventNavigation = event => {
          if (!event.composedPath().includes(link)) return;
          reached = true;
          prevented = event.defaultPrevented;
          event.preventDefault(); // Only suppress the browser's new tab; let the real adapter listener run first.
        };
        saved.host.addEventListener('click', preventNavigation);
        try { link.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })); }
        finally { saved.host.removeEventListener('click', preventNavigation); }
        await delay(50);
        assert('适配器不拦截链接、不调用交互或原分页', reached && !prevented && calls.length === 0 && controls.edits.length === 0
          && controls.page === 3 && controls.requests.length === 2 && controls.clicks.length === 2 && browserModule.state === 'done');
        assertPreserved(saved);
      });
      await interactionTest('Fusion 原生 inline 展开可见，保留累计副本并可继续', async () => {
        const calls = await prepareInteraction({ mode: 'fusion' });
        await loadThrough(2);
        const saved = savedCopies(), original = element;
        const row = element.querySelector('[data-row-key="4"]'), rowText = row.textContent;
        let expanded;
        // Simulate native Fusion expansion as a sibling, without rewriting the business row.
        element.addEventListener('click', event => {
          const button = event.target.closest('button[data-action="inspect"]');
          if (button?.closest('[data-row-key]') !== row) return;
          expanded = document.createElement('tr');
          expanded.className = 'next-table-expanded-row';
          const cell = expanded.insertCell();
          cell.colSpan = row.cells.length;
          cell.textContent = '条目 4 的原生展开详情';
          row.after(expanded);
        });
        await finishInteraction(clickCopy(calls, 4));
        assertEdit(4, 2);
        browserModule._checkContext();
        await delay(650); // Let mutation observers and periodic context checks see the expanded row.
        await browserModule._load();
        assert('inline 详情确实可见而非只存在于隐藏原表', expanded?.isConnected && expanded.previousElementSibling === row
          && expanded.textContent === '条目 4 的原生展开详情' && expanded.getBoundingClientRect().height > 0
          && getComputedStyle(expanded).display !== 'none' && getComputedStyle(expanded).visibility === 'visible'
          && getComputedStyle(element).display !== 'none');
        assert('展开不改变原表身份、业务行原文本或分页计数', element === original && row.isConnected
          && row.dataset.rowKey === '4' && row.textContent === rowText && ContinuousBrowseClickAdapter.rows(element).length === 3
          && browserModule.state === 'paused' && controls.page === 2 && controls.requests.length === 1
          && controls.clicks.length === 1 && controls.edits.length === 1);
        assertPreserved(saved);
        await browserModule.command('resume');
        silence();
        assert('继续时隐藏原表及 inline 详情', getComputedStyle(element).display === 'none' && expanded.getClientRects().length === 0);
        await loadThrough(3);
        assert('继续仅追加下一页，原累计副本节点及 snapshot 不变', browserModule.adapter === saved.adapter && host() === saved.host
          && browserModule._session === saved.session && browserModule.pages === 3 && saved.adapter.loaded === 7
          && saved.adapter.page === 3 && browserModule.state === 'done' && copyIds(copies()) === '1,2,3,4,5,6,7'
          && copies().querySelectorAll('section').length === 3
          && saved.sections.every(({ node, html }, index) => copies().querySelectorAll('section')[index] === node && node.innerHTML === html)
          && controls.requests.map(request => request.page).join() === '2,3' && controls.clicks.length === 2 && controls.edits.length === 1
          && element === original && getComputedStyle(element).display === 'none');
      });
      await interactionTest('hash 详情抽屉保留累计内容，当前页无额外分页', async () => {
        const calls = await prepareInteraction({ hashDetails: true });
        await loadThrough(2);
        const saved = savedCopies(), beforeUrl = location.href;
        await finishInteraction(clickCopy(calls, 4));
        assertEdit(4, 2);
        assert('原生详情打开并改变 hash，原表保持可见', !drawer.hidden && location.hash === '#click-detail-4'
          && getComputedStyle(element).display !== 'none' && browserModule.state === 'paused');
        browserModule._checkContext();
        assertPreserved(saved);
        await delay(650); // Exercise context polling and hashchange, not just the synchronous click stack.
        browserModule._checkContext();
        await browserModule._load();
        assertPreserved(saved);
        assert('抽屉期间保持暂停且没有额外原分页请求', browserModule.state === 'paused' && controls.page === 2
          && controls.requests.length === 1 && controls.clicks.length === 1 && controls.edits.length === 1);
        document.querySelector('#click-close-detail').click();
        await delay(0);
        browserModule._checkContext();
        assertPreserved(saved);
        assert('关闭抽屉恢复 URL，不重启、不丢前页且仍暂停', drawer.hidden && location.href === beforeUrl
          && browserModule.state === 'paused' && saved.adapter.isCurrent() && controls.requests.length === 1);
      });
      assert('所有模式均不猜测 URL、不调用 fetch/XHR API', networkCalls === 0);
    } catch (error) { checks.push({ error: error.message }); }
    finally {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      for (const controller of controllers) controller.abort();
      for (const adapter of adapters) adapter.destroy();
      browserModule.destroy();
      window.fixtureData = {};
      await settle();
      reset(options);
      window.scrollTo(0, 0);
      await initModule();
      running = false;
      runButton.disabled = false;
      window.clickRegressionResults = window.regressionResults = checks;
      result.textContent = checks.filter(check => check.pass).length + ' 项通过 / '
        + checks.filter(check => check.pass === false || check.error).length + ' 项失败；详见 clickRegressionResults';
    }
    return checks;
  };
  window.runClickInteractionRegression = () => window.runClickRegression({ interactionOnly: true });
  runButton.onclick = () => window.runClickRegression({ scroll: true });
}

const clickFixture = url => {
  const modes = ['semantic', 'fusion', 'antd', 'list', 'ol', 'role-list', 'grid'];
  const behaviors = ['normal', 'duplicate', 'noop', 'slow', 'fail', 'staged'];
  const options = {
    mode: modes.includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'semantic',
    behavior: behaviors.includes(url.searchParams.get('behavior')) ? url.searchParams.get('behavior') : 'normal',
    delay: Math.max(50, Math.min(1000, Number(url.searchParams.get('delay')) || 100)),
  };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>通用按钮分页回归</title>
<style>body{font:14px system-ui;margin:24px}header{position:sticky;top:0;background:white;padding:12px;z-index:2}button{padding:8px;margin:4px}table{width:100%;border-collapse:collapse}td,th{padding:16px;border:1px solid #ddd}#click-spacer{height:160vh;min-height:1200px}#click-scope>ul:not(.ant-pagination)>li,#click-scope>ol>li,[role=listitem],[role=row]{padding:24px;border-bottom:1px solid #ddd}.pagination,.next-pagination,.ant-pagination{align-items:center;gap:12px;list-style:none}output{display:block}</style></head>
<body><header><h1>通用按钮分页（只读）回归：${options.mode}</h1><p>默认关闭；点击显式许可后自动识别。仅原生异步点击，无接口或框架契约。</p>
<button id="click-start" type="button">显式许可并开启</button><button id="click-pause" type="button">暂停</button><button id="click-resume" type="button">继续</button><button id="click-stop" type="button">关闭并恢复原分页</button><button id="click-test" type="button">运行回归（含滚动）</button>
<label>筛选 <input id="click-query"></label><button id="click-filter" type="button">应用筛选</button><output id="click-result"></output></header>
<div id="click-spacer" aria-hidden="true"></div><main><section id="click-scope"></section></main>
<aside id="click-detail" role="dialog" aria-label="模拟详情" hidden style="position:fixed;inset:20% 0 0 60%;background:white;border:1px solid;z-index:3"><h2>本地模拟详情</h2><button id="click-close-detail" type="button">关闭详情</button></aside>
${scripts.map(src => `<script src="${src}"></script>`).join('')}<script>(${setupClickFixture.toString()})(${JSON.stringify(options)})</script></body></html>`;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8765');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/click') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(clickFixture(url));
    return;
  }
  if (url.pathname === '/table') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(tableFixture(url));
    return;
  }
  if (url.pathname === '/') {
    const key = url.search;
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    if (url.searchParams.get('page') === '2' && url.searchParams.get('mode') === 'error' && attempt === 1) {
      res.writeHead(503, {'Content-Type':'text/html'});res.end('temporary failure');return;
    }
    if (url.searchParams.get('page') === '2' && url.searchParams.get('mode') === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    const html = fixture(url);
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(url.searchParams.has('extension') ? html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '') : html);
    return;
  }
  if (scripts.includes(url.pathname) || /^\/popup\/[\w/.-]+\.(js|html|css)$/.test(url.pathname)
    || /^\/(shared|lib)\/[\w.-]+\.js$/.test(url.pathname)) {
    const file = path.resolve(root, `.${url.pathname}`);
    if (file.startsWith(root + path.sep) && fs.existsSync(file)) {
      res.writeHead(200, {'Content-Type':url.pathname.endsWith('.html') ? 'text/html; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8'});
      res.end(fs.readFileSync(file));return;
    }
  }
  res.writeHead(404);res.end();
});
async function testMessageRouting() {
  const assert = require('node:assert/strict');
  const vm = require('node:vm');
  const source = ['BaseModule', 'QrCodeTool', 'ContinuousBrowse']
    .map(name => fs.readFileSync(path.join(root, 'content/modules', `${name}.js`), 'utf8')).join('\n');
  const { QrCodeTool, ContinuousBrowse } = vm.runInNewContext(`${source}\n({ QrCodeTool, ContinuousBrowse })`);
  const qr = new QrCodeTool();
  const browse = new ContinuousBrowse();
  browse.detect = () => null;
  const calls = [];
  qr._generate = text => calls.push(['generate', text]);
  qr._decodeImageEntry = url => calls.push(['image', url]);
  qr._decodePageEntry = () => calls.push(['page']);

  for (const message of [null, {}, { action: 'continuousBrowse', command: 'status' }, { action: 'scanPageInputs' }, { type: 'unrelated' }]) {
    let replied = false;
    assert.equal(qr._onMessage(message, {}, () => { replied = true; }), undefined);
    assert.equal(replied, false, '二维码模块不得回复其他模块的消息');
  }
  for (const type of ['qr-generate', 'qr-decode-image', 'qr-decode-page']) {
    let response;
    qr._onMessage({ type, text: 'fixture', srcUrl: '/fixture.png' }, {}, value => { response = value; });
    assert.equal(response?.ok, true);
  }
  assert.deepEqual(calls, [['generate', 'fixture'], ['image', '/fixture.png'], ['page']]);
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连续浏览状态响应超时')), 1000);
    const sendResponse = value => { clearTimeout(timer); resolve(value); };
    const message = { action: 'continuousBrowse', command: 'status' };
    qr._onMessage(message, {}, sendResponse);
    assert.equal(browse._onMessage(message, {}, sendResponse), true);
  });
  assert.equal(response.state, 'unsupported');
  assert.equal(response.message, '当前页面暂未适配');
  assert.equal(response.active, false);
  console.log('PASS: unrelated messages ignored, 3 QR commands preserved, continuous-browse async response delivered');
}

async function testSettings() {
  const assert = require('node:assert/strict');
  const vm = require('node:vm');
  const sources = ['content/modules/BaseModule.js', 'content/modules/ContinuousBrowse.js', 'shared/storageState.js']
    .map(file => ({ file, source: fs.readFileSync(path.join(root, file), 'utf8') }));
  const hostname = 'example.com';
  const other = 'other.example';
  const allowed = { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [hostname] };
  const clone = value => JSON.parse(JSON.stringify(value));

  function harness(initial, cached, host = hostname) {
    const data = clone(initial);
    const listeners = new Set();
    const reads = [], writes = [];
    let mounts = 0;
    const local = {
      async get(keys) {
        reads.push(keys == null ? null : Array.from(keys));
        return clone(keys == null ? data : Object.fromEntries(keys
          .filter(key => Object.prototype.hasOwnProperty.call(data, key)).map(key => [key, data[key]])));
      },
      async set(values) {
        const copied = clone(values);
        writes.push(copied);
        const changes = Object.fromEntries(Object.entries(copied)
          .map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
        Object.assign(data, copied);
        for (const listener of listeners) listener(changes, 'local');
      },
    };
    const context = vm.createContext({
      console: { ...console, log() {} },
      location: { hostname: host, href: `https://${host}/items?page=1` },
      document: { documentElement: {} },
      chrome: {
        runtime: { onMessage: { addListener() {}, removeListener() {} } },
        storage: { local, onChanged: {
          addListener(listener) { listeners.add(listener); },
          removeListener(listener) { listeners.delete(listener); },
        } },
      },
      MutationObserver: class { observe() {} disconnect() {} },
      addEventListener() {}, removeEventListener() {},
      setInterval() { return 1; }, clearInterval() {},
      setTimeout() { return 1; }, clearTimeout() {},
    });
    context.window = context;
    context.top = context;
    for (const { file, source } of sources) {
      if (cached || file !== 'shared/storageState.js') vm.runInContext(source, context, { filename: file });
    }
    const { BaseContentModule, ContinuousBrowse } = vm.runInContext('({ BaseContentModule, ContinuousBrowse })', context);
    const modules = [];
    return {
      BaseContentModule, local, reads, writes,
      snapshot: () => clone(data),
      get mounts() { return mounts; },
      createBrowse() {
        const browse = new ContinuousBrowse();
        // Stub only adapter discovery and DOM mounting, not permission checks or commands.
        const adapter = {
          name: 'Settings fixture', interactive: true, nextUrl: false, loaded: 1, total: 1,
          element: { isConnected: true }, isCurrent: () => true, destroy() {},
        };
        browse.detect = () => adapter;
        browse._mount = function () {
          mounts++;
          this._host = { isConnected: true, remove() { this.isConnected = false; } };
        };
        modules.push(browse);
        return browse;
      },
      assertReadPath() {
        if (cached) {
          assert.deepEqual(reads, [null], '真实 StorageState 只初始化一次，此后从缓存读取');
          assert.equal(listeners.size, 1, '真实 StorageState 注册变更监听');
        } else {
          assert.ok(reads.length > 0 && reads.every(keys => Array.isArray(keys)), '无 StorageState 时直读存储键');
          assert.equal(listeners.size, 0);
        }
      },
      destroy() { for (const browse of modules) browse.destroy(); },
    };
  }

  const browseCases = [
    ['未设置时关闭', {}, false],
    ['只有总开关时关闭', { continuousBrowseModuleEnabled: true }, false],
    ['只有白名单时总开关仍默认关闭', { enabledContinuousBrowseSites: [hostname] }, false],
    ['空白名单不许可', { ...allowed, enabledContinuousBrowseSites: [] }, false],
    ['旧空黑名单不许可', { continuousBrowseModuleEnabled: true, disabledContinuousBrowseSites: [] }, false],
    ['旧其他域黑名单不许可', { continuousBrowseModuleEnabled: true, disabledContinuousBrowseSites: [other] }, false],
    ['旧当前域黑名单不许可', { continuousBrowseModuleEnabled: true, disabledContinuousBrowseSites: [hostname] }, false],
    ['显式许可当前域才启用', allowed, true],
    ['旧空黑名单不影响显式许可', { ...allowed, disabledContinuousBrowseSites: [] }, true],
    ['旧当前域黑名单不影响显式许可', { ...allowed, disabledContinuousBrowseSites: [hostname, other] }, true],
    ['多个许可域包含当前域即可', { ...allowed, enabledContinuousBrowseSites: [other, hostname] }, true],
    ['许可不扩散到子域', allowed, false, 'sub.example.com'],
    ['许可不扩散到其他域', allowed, false, other],
    ['许可不匹配域名后缀伪装', allowed, false, 'example.com.evil.test'],
    ['子域许可不扩散到父域', { ...allowed, enabledContinuousBrowseSites: ['sub.example.com'] }, false],
    ['子域单独许可可启用', { ...allowed, enabledContinuousBrowseSites: ['sub.example.com'] }, true, 'sub.example.com'],
    ['URL 不等于 hostname', { ...allowed, enabledContinuousBrowseSites: ['https://example.com'] }, false],
    ['通配域名不等于 hostname', { ...allowed, enabledContinuousBrowseSites: ['*.example.com'] }, false, 'sub.example.com'],
    ['总开关关闭优先于白名单', { ...allowed, continuousBrowseModuleEnabled: false }, false],
    ['非布尔总开关不能许可', { ...allowed, continuousBrowseModuleEnabled: 'true' }, false],
    ['全局禁用当前域优先于白名单', { ...allowed, globalDisabledSites: [hostname] }, false],
    ['全局禁用其他域不影响许可', { ...allowed, globalDisabledSites: [other] }, true],
  ];
  const baseCases = [
    ['其他模块默认允许', {}, true],
    ['其他模块空黑名单默认允许', { disabledPasswordSites: [] }, true],
    ['其他模块不需要白名单', { enabledPasswordSites: [], enabledContinuousBrowseSites: [] }, true],
    ['旧连续浏览黑名单不影响其他模块', { disabledContinuousBrowseSites: [hostname] }, true],
    ['其他模块仍尊重本站黑名单', { disabledPasswordSites: [hostname] }, false],
    ['其他模块的别站黑名单不影响本站', { disabledPasswordSites: [other] }, true],
    ['其他模块仍尊重总开关', { passwordModuleEnabled: false }, false],
    ['其他模块仍尊重全局禁用', { globalDisabledSites: [hostname] }, false],
  ];
  let passed = 0, failed = 0;
  for (const cached of [false, true]) {
    const label = cached ? 'StorageState' : 'direct storage';
    const test = async (name, initial, run, host) => {
      const fixture = harness(initial, cached, host);
      try {
        await run(fixture);
        passed++;
      } catch (error) {
        failed++;
        console.error(`FAIL [${label}] ${name}: ${error.message}`);
      } finally { fixture.destroy(); }
    };
    for (const [name, initial, enabled, host] of browseCases) {
      await test(name, initial, async fixture => {
        const browse = fixture.createBrowse();
        assert.equal(browse.defaultEnabled, false, '连续浏览总开关默认关闭');
        assert.equal(browse.defaultSiteEnabled, false, '连续浏览网站默认关闭');
        assert.equal(await browse.checkModuleEnabled(), enabled, 'checkModuleEnabled 返回值');
        assert.equal(browse.isEnabled, enabled, 'isEnabled 与读取结果一致');
        await browse.init();
        assert.equal(!!browse.adapter, enabled, '初始化只启动获准站点');
        assert.equal((await browse.command('start')).active, enabled, 'start 遵守现有许可');
        const direct = fixture.createBrowse();
        assert.equal((await direct.command('start')).active, enabled, '未经 init 的 start 也不能绕过许可');
        assert.equal(fixture.mounts, enabled ? 2 : 0, '实际 start 只为获准站点挂载，重复命令不重建');
        assert.deepEqual(fixture.writes, [], '读取、初始化和 start 均不写入或迁移授权');
        assert.deepEqual(fixture.snapshot(), initial, '包括旧黑名单在内的设置保持不变');
        fixture.assertReadPath();
      }, host);
    }
    for (const [name, initial, enabled] of baseCases) {
      await test(name, initial, async fixture => {
        const module = new fixture.BaseContentModule('password');
        assert.equal(module.defaultEnabled, true);
        assert.equal(module.defaultSiteEnabled, true, 'Base 其他模块网站仍默认允许');
        assert.equal(await module.checkModuleEnabled(), enabled);
        assert.equal(module.isEnabled, enabled);
        assert.deepEqual(fixture.writes, []);
        fixture.assertReadPath();
      });
    }
    await test('设置变更后重新检查许可', {}, async fixture => {
      const browse = fixture.createBrowse();
      assert.equal(await browse.checkModuleEnabled(), false);
      for (const [values, enabled] of [
        [{ continuousBrowseModuleEnabled: true }, false],
        [{ disabledContinuousBrowseSites: [] }, false],
        [{ enabledContinuousBrowseSites: [other] }, false],
        [{ enabledContinuousBrowseSites: [hostname, other] }, true],
        [{ globalDisabledSites: [hostname] }, false],
        [{ globalDisabledSites: [] }, true],
        [{ continuousBrowseModuleEnabled: false }, false],
        [{ continuousBrowseModuleEnabled: true }, true],
        [{ enabledContinuousBrowseSites: [] }, false],
      ]) {
        await fixture.local.set(values);
        const writes = fixture.writes.length;
        assert.equal(await browse.checkModuleEnabled(), enabled, JSON.stringify(values));
        assert.equal(browse.isEnabled, enabled);
        assert.equal(fixture.writes.length, writes, '重新检查不写入设置');
      }
      fixture.assertReadPath();
    });
    const initial = { ...allowed, enabledContinuousBrowseSites: [other, hostname, 'sub.example.com'], disabledContinuousBrowseSites: [hostname] };
    await test('stop 仅撤销当前域名，start 不能恢复授权', initial, async fixture => {
      const browse = fixture.createBrowse();
      await browse.init();
      assert.equal(!!browse.adapter, true);
      assert.equal((await browse.command('stop')).active, false);
      assert.equal(browse.isEnabled, false);
      const stopped = { ...initial, enabledContinuousBrowseSites: [other, 'sub.example.com'] };
      assert.deepEqual(fixture.snapshot(), stopped, '保留其他域名、总开关和旧键，不迁移');
      assert.equal(await browse.checkModuleEnabled(), false, 'stop 后读取路径立即看到撤销');
      const writes = fixture.writes.length;
      assert.equal((await browse.command('start')).active, false, 'stop 后 start 不能自我授权');
      const reloaded = fixture.createBrowse();
      await reloaded.init();
      assert.equal(reloaded.isEnabled, false);
      assert.equal(reloaded.adapter, null, '下次初始化仍关闭');
      assert.equal(fixture.mounts, 1);
      assert.equal(fixture.writes.length, writes, 'start 与重新初始化不写授权');
      assert.deepEqual(fixture.snapshot(), stopped);
      await fixture.local.set({ enabledContinuousBrowseSites: initial.enabledContinuousBrowseSites });
      const authorizedWrites = fixture.writes.length;
      assert.equal((await reloaded.command('start')).active, true, '必须重新显式许可才可运行');
      assert.equal(fixture.mounts, 2);
      assert.equal(fixture.writes.length, authorizedWrites, '获准后的 start 也不写授权');
      assert.deepEqual(fixture.snapshot(), initial);
    });
  }
  console.log(`${failed ? 'FAIL' : 'PASS'}: settings ${passed} passed, ${failed} failed (direct storage + real StorageState)`);
  if (failed) process.exitCode = 1;
}

if (process.argv.includes('--settings')) {
  testSettings().catch(error => { console.error(error); process.exitCode = 1; });
} else if (process.argv.includes('--messages')) {
  testMessageRouting().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  server.listen(8765, '127.0.0.1', () => console.log('Continuous browse fixtures: http://127.0.0.1:8765 (normal, nested, unsupported, error, slow via ?mode=...)'));
}
