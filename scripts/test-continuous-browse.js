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
  window.fixtureData = {};
  window.chrome = {runtime:{onMessage:{addListener(){},removeListener(){}}},storage:{local:{async get(){return {...fixtureData}},async set(values){Object.assign(fixtureData,values)}}}};
  window.browserModule = new ContinuousBrowse();
  window.browserReady = browserModule.init();
  ['pause','resume','stop'].forEach(command=>document.getElementById(command).onclick=()=>browserModule.command(command));
  document.getElementById('start').onclick=async()=>{await chrome.storage.local.set({disabledContinuousBrowseSites:[]});browserModule.destroy();window.browserModule=new ContinuousBrowse();await browserModule.init()};
  document.getElementById('test').onclick=()=>runRegression();
  async function runRegression(){
    const checks=[];
    const assert=(name,ok)=>{checks.push({name,pass:!!ok});if(!ok)throw new Error(name)};
    const waitFor=async(test)=>{const end=Date.now()+3000;while(!test()){if(Date.now()>end)throw new Error('自动开启超时');await new Promise(resolve=>setTimeout(resolve,25))}};
    try {
      await browserReady;
      assert('识别通用HTML分页',browserModule.status().adapter==='通用 HTML 分页');
      assert('支持页面默认自动开启',!!browserModule.adapter && browserModule.pages===1);
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
      assert('关闭记录当前域名',fixtureData.disabledContinuousBrowseSites.includes(location.hostname));
      browserModule.destroy();
      window.browserModule=new ContinuousBrowse();await browserModule.init();
      assert('下次初始化仍保持关闭',!browserModule.adapter && !browserModule.isEnabled);
      await chrome.storage.local.set({disabledContinuousBrowseSites:[]});
      browserModule.destroy();
      window.browserModule=new ContinuousBrowse();await browserModule.init();
      assert('恢复网站开关后自动开启',!!browserModule.adapter);
      await browserModule.command('pause');
      history.pushState({},'', '?mode=normal&page=1&changed=1');browserModule._checkContext();
      assert('路由变化退出',!browserModule.adapter);
      await waitFor(()=>browserModule.adapter);
      assert('路由变化后自动开启且不关闭域名',browserModule.pages===1 && !fixtureData.disabledContinuousBrowseSites.includes(location.hostname));
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
      assert('暂停不记录域名关闭',!fixtureData.disabledContinuousBrowseSites.includes(location.hostname));
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
  window.fixtureData = {};
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
        window.fixtureData = {};
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
          && pager.style.display === '' && fixtureData.disabledContinuousBrowseSites.includes(location.hostname));
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
        window.fixtureData = {};
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
          && fixtureData.disabledContinuousBrowseSites.includes(location.hostname));
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
      window.fixtureData = {};
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
      assert('关闭记忆不丢失',fixtureData.disabledContinuousBrowseSites.includes(location.hostname));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8765');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
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

if (process.argv.includes('--messages')) {
  testMessageRouting().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  server.listen(8765, '127.0.0.1', () => console.log('Continuous browse fixtures: http://127.0.0.1:8765 (normal, nested, unsupported, error, slow via ?mode=...)'));
}
