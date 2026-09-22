(() => {
  'use strict';

  if (window !== window.top) return;
  const registration = Symbol.for('geek.continuous-table-bridge');
  if (window[registration]) return;
  Object.defineProperty(window, registration, { value: true });

  const sessions = new WeakMap();
  const inFlight = new WeakMap();
  const commands = new Set(['detect', 'start', 'status', 'next', 'stop']);
  const errors = {
    request: '连续浏览请求无效',
    inactive: '连续浏览会话已结束，请重新开启',
    changed: '页面状态已变化，连续浏览已停止',
    busy: '正在加载下一页，请稍后再试',
    load: '下一页加载失败，已保留最后成功页，请重试',
    operation: '连续浏览操作失败，请恢复原分页后重试',
  };
  class BridgeError extends Error {}
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const plain = value => value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
  const readonly = value => value !== null && typeof value === 'object'
    && (value.__v_isReadonly === true || Object.isFrozen(value));

  function writable(object, key) {
    if (!object || readonly(object) || !own(object, key)) return false;
    const raw = object.__v_raw || object;
    if (readonly(raw)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || ('value' in descriptor ? !descriptor.writable : !descriptor.set)) return false;
    return !readonly(descriptor.value) && !readonly(object[key]);
  }

  function filters(form) {
    try {
      const visited = new Set();
      let count = 0;
      const encode = (value, depth) => {
        if (++count > 4000 || depth > 16) throw new Error();
        if (value === undefined) return ['undefined'];
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return ['number', value];
        if (value instanceof Date) return ['date', Date.prototype.getTime.call(value)];
        if ((!Array.isArray(value) && !plain(value)) || visited.has(value)) throw new Error();
        visited.add(value);
        const result = Array.isArray(value)
          ? ['array', Array.from(value, item => encode(item, depth + 1))]
          : ['object', Object.keys(value).sort().map(key => [key, encode(value[key], depth + 1)])];
        visited.delete(value);
        return result;
      };
      const result = JSON.stringify(Object.keys(form).sort()
        .filter(key => !['pageNum', 'currentPage', 'pageSize', 'total'].includes(key))
        .map(key => [key, encode(form[key], 0)]));
      return result.length <= 131072 ? result : null;
    } catch (_) {
      return null;
    }
  }

  function visible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility);
  }

  function environment(table) {
    const tables = Array.from(document.querySelectorAll('.el-table, .el-table-v2')).filter(visible);
    const dialogs = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, [role="dialog"], [aria-modal="true"]')).filter(visible);
    if (tables.length !== 1 || tables[0] !== table) {
      console.debug('[table-bridge] environment FAIL: visible tables=' + tables.length + ', target=' + tables.includes(table) + ', dialogs=' + dialogs.length);
      return false;
    }
    if (dialogs.length) {
      console.debug('[table-bridge] environment FAIL: visible dialogs=' + dialogs.length);
      return false;
    }
    return true;
  }

  function ancestor(instance, owner) {
    const seen = new Set();
    for (let current = instance; current && !seen.has(current); current = current.parent) {
      if (current === owner) return true;
      seen.add(current);
    }
    return false;
  }

  function component(element, name) {
    const instance = element.__vueParentComponent;
    return instance && !instance.isUnmounted && (instance.type?.name || instance.type?.__name) === name ? instance : null;
  }

  function rowKey(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128
      && value.split('.').every(part => part && !['__proto__', 'prototype', 'constructor'].includes(part));
  }

  function detectRowKey(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const candidates = ['id', 'ID', 'Id', '_id', 'key', 'Key', 'clientId', 'userId', 'orderId'];
    for (const field of candidates) {
      if (!own(rows[0], field)) continue;
      const values = new Set();
      let valid = true;
      for (const row of rows) {
        if (!own(row, field)) { valid = false; break; }
        const value = row[field];
        if ((typeof value !== 'string' || !value.length) && (typeof value !== 'number' || !Number.isFinite(value))) { valid = false; break; }
        values.add(String(value));
      }
      if (valid && values.size === rows.length) return field;
    }
    return null;
  }

  function keyOf(row, key) {
    if (!row || typeof row !== 'object') throw new BridgeError(errors.load);
    let value = row;
    for (const part of key.split('.')) {
      if (!value || typeof value !== 'object' || !own(value, part)) throw new BridgeError(errors.load);
      value = value[part];
    }
    if ((typeof value !== 'string' || !value.length) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new BridgeError(errors.load);
    }
    return String(value);
  }

  function unsafeTable(table, props) {
    return props.lazy || typeof props.load === 'function' || props.virtualized || props.virtual
      || props.defaultExpandAll || props.expandRowKeys?.length
      || table.matches('.el-table-v2, .el-table--virtualized')
      || !!table.querySelector('.el-table-v2, .el-table__expanded-cell, .el-table__expand-column, th.ascending, th.descending, .el-table__column-filter-trigger.is-active');
  }

  function validateRows(rows, key, props) {
    if (!Array.isArray(rows) || readonly(rows)) throw new BridgeError(errors.load);
    const ids = new Set();
    const children = props.treeProps?.children || 'children';
    const hasChildren = props.treeProps?.hasChildren || 'hasChildren';
    for (const row of rows) {
      const id = keyOf(row, key);
      if (ids.has(id) || row[hasChildren] || (row[children] != null
        && (!Array.isArray(row[children]) || row[children].length))) throw new BridgeError(errors.load);
      ids.add(id);
    }
    return ids;
  }

  function domRows(table) {
    return Array.from(table.querySelectorAll('.el-table__row')).filter(row => row.closest('.el-table') === table);
  }

  function resolveDataState(state) {
    const tableDataWritable = writable(state, 'tableData');
    if (tableDataWritable && Array.isArray(state.tableData)) {
      return { dataKey: 'tableData', isClientSide: false, sourceData: state.tableData };
    }
    if (own(state, 'allData') && Array.isArray(state.allData)) {
      return { dataKey: 'allData', isClientSide: true, sourceData: state.allData };
    }
    return null;
  }

  function resolveLoadingKey(state) {
    if (own(state, 'loading') && state.loading === false) return 'loading';
    if (own(state, 'tableLoading') && state.tableLoading === false) return 'tableLoading';
    return null;
  }

  function resolvePagination(state) {
    const formData = state.formData;
    if (plain(formData) && writable(formData, 'pageNum')
      && integer(formData.pageNum, 1) && integer(formData.pageSize, 1) && integer(formData.total, 0)) {
      return { form: formData, pageNumKey: 'pageNum', formKey: 'formData' };
    }
    const pagination = state.pagination;
    if (plain(pagination) && writable(pagination, 'currentPage')
      && integer(pagination.currentPage, 1) && integer(pagination.pageSize, 1) && integer(pagination.total, 0)) {
      return { form: pagination, pageNumKey: 'currentPage', formKey: 'pagination' };
    }
    return null;
  }

  function querySignature(owner, state, form) {
    const parts = [filters(form), filters(owner.props || {})];
    if (state.formData !== form && plain(state.formData)) parts.push(filters(state.formData));
    return parts.includes(null) ? null : JSON.stringify(parts);
  }

  function nextButton(pager) {
    const button = pager.querySelector('.btn-next');
    return button instanceof HTMLButtonElement && !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      ? button : null;
  }

  function contract(table) {
    try {
      console.debug('[table-bridge] contract START');
      if (!environment(table)) return null;
      const instance = component(table, 'ElTable');
      if (!instance) {
        console.debug('[table-bridge] contract FAIL: no ElTable component');
        return null;
      }
      const props = instance.props;
      if (!props) {
        console.debug('[table-bridge] contract FAIL: no props');
        return null;
      }
      let effectiveRowKey = props.rowKey;
      if (!rowKey(props.rowKey)) {
        if (props.rowKey !== undefined) {
          console.debug('[table-bridge] contract FAIL: rowKey invalid');
          return null;
        }
        if (!Array.isArray(props.data) || !props.data.length) {
          console.debug('[table-bridge] contract FAIL: rowKey undefined and no data');
          return null;
        }
        effectiveRowKey = detectRowKey(props.data);
        if (!effectiveRowKey) {
          console.debug('[table-bridge] contract FAIL: auto-detect failed');
          return null;
        }
        console.debug('[table-bridge] contract: auto-detected rowKey=' + effectiveRowKey);
      }
      if (unsafeTable(table, props)) {
        console.debug('[table-bridge] contract FAIL: unsafeTable');
        return null;
      }
      const selection = instance.setupState;
      if (typeof selection?.getSelectionRows !== 'function' || typeof selection.toggleRowSelection !== 'function') {
        console.debug('[table-bridge] contract FAIL: no selection methods');
        return null;
      }
      const candidates = [];
      const visited = new Set();
      for (let owner = instance.parent; owner && !visited.has(owner); owner = owner.parent) {
        visited.add(owner);
        const state = owner.setupState;
        if (!state || !own(state, 'tableData') || state.tableData !== props.data) continue;
        const ownerName = owner.type?.name || owner.type?.__name || '?';
        if (owner.isUnmounted) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP unmounted'); continue; }
        if (inFlight.has(owner)) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP inFlight'); continue; }
        if (typeof owner.proxy?.$watch !== 'function' || typeof owner.proxy.$nextTick !== 'function') {
          console.debug('[table-bridge] contract: ' + ownerName + ' SKIP no $watch/$nextTick'); continue;
        }

        const loadingKey = resolveLoadingKey(state);
        if (!loadingKey) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP no valid loading'); continue; }

        const dataState = resolveDataState(state);
        if (!dataState) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP no valid data state'); continue; }

        const pagination = resolvePagination(state);
        if (!pagination) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP no valid pagination'); continue; }
        const { form, pageNumKey, formKey } = pagination;

        const signature = querySignature(owner, state, form);
        if (signature === null) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP filters null'); continue; }

        const sourceData = dataState.sourceData;
        const displayData = state.tableData;
        if (!Array.isArray(displayData)) { console.debug('[table-bridge] contract: ' + ownerName + ' SKIP tableData not array'); continue; }
        if (displayData.length > form.pageSize && !dataState.isClientSide) {
          console.debug('[table-bridge] contract: ' + ownerName + ' SKIP tableData.length=' + displayData.length + ' > pageSize=' + form.pageSize);
          continue;
        }

        if (dataState.isClientSide) {
          if (!writable(form, 'pageSize') || sourceData.length !== form.total) continue;
          const offset = (form[pageNumKey] - 1) * form.pageSize;
          const pageRows = sourceData.slice(offset, offset + form.pageSize);
          if (displayData.length !== pageRows.length || displayData.some((row, index) => row !== pageRows[index])) continue;
        }
        const ids = validateRows(sourceData, effectiveRowKey, props);
        if (domRows(table).length !== displayData.length) {
          console.debug('[table-bridge] contract: ' + ownerName + ' SKIP DOM rows=' + domRows(table).length + ' != displayData.length=' + displayData.length);
          continue;
        }

        console.debug('[table-bridge] contract: ' + ownerName + ' MATCH, dataKey=' + dataState.dataKey
          + ', isClientSide=' + dataState.isClientSide + ', loadingKey=' + loadingKey
          + ', pageNumKey=' + pageNumKey + ', formKey=' + formKey);
        candidates.push({
          table, instance, owner, state, form, pageNumKey, formKey,
          loadingKey, dataKey: dataState.dataKey, isClientSide: dataState.isClientSide,
          key: effectiveRowKey, signature, ids, sourceData,
        });
      }
      if (candidates.length !== 1) {
        console.debug('[table-bridge] contract FAIL: candidates=' + candidates.length + ', visited=' + visited.size);
        return null;
      }
      const found = candidates[0];
      const pagers = Array.from(document.querySelectorAll('.el-pagination')).filter(visible);
      if (pagers.length !== 1) {
        console.debug('[table-bridge] contract FAIL: visible pagers=' + pagers.length);
        return null;
      }
      const pager = component(pagers[0], 'ElPagination');
      if (!pager) {
        console.debug('[table-bridge] contract FAIL: no ElPagination component');
        return null;
      }
      if (!ancestor(pager, found.owner)) {
        console.debug('[table-bridge] contract FAIL: pager not descendant of owner');
        return null;
      }
      if (pager.props.currentPage !== found.form[found.pageNumKey] || pager.props.pageSize !== found.form.pageSize || pager.props.total !== found.form.total) {
        console.debug('[table-bridge] contract FAIL: pager props mismatch');
        return null;
      }
      if (!found.isClientSide && (pager.props.disabled
        || (found.form[found.pageNumKey] < Math.ceil(found.form.total / found.form.pageSize) && !nextButton(pagers[0])))) return null;
      console.debug('[table-bridge] contract SUCCESS');
      return { ...found, pager: pagers[0], pagerInstance: pager };
    } catch (error) {
      console.debug('[table-bridge] contract EXCEPTION:', error);
      return null;
    }
  }

  function context(session, requireQuery = true) {
    try {
      return location.href === session.url && !session.owner.isUnmounted && !session.instance.isUnmounted
        && session.table.__vueParentComponent === session.instance && session.owner.setupState === session.state
        && session.state[session.formKey] === session.form
        && (!requireQuery || (session.form.pageSize === session.size
          && querySignature(session.owner, session.state, session.form) === session.signature))
        && (!session.instance.props.rowKey || session.instance.props.rowKey === session.key)
        && (session.isClientSide ? writable(session.form, 'pageSize') : writable(session.state, session.dataKey))
        && writable(session.form, session.pageNumKey);
    } catch (_) {
      return false;
    }
  }

  function live(session, generation = session.generation) {
    return session.active && sessions.get(session.table) === session && session.generation === generation;
  }

  function readDisplayData(session) {
    return session.state.tableData;
  }

  function assign(session, rows, page, total) {
    session.writing = true;
    try {
      if (session.form[session.pageNumKey] !== page) session.form[session.pageNumKey] = page;
      if (total !== undefined && session.form.total !== total) session.form.total = total;
      session.state[session.dataKey] = rows;
      const source = session.state[session.dataKey];
      if (session.form[session.pageNumKey] !== page || (total !== undefined && session.form.total !== total)
        || !Array.isArray(source) || source.length !== rows.length
        || source.some((row, index) => row !== rows[index])) throw new BridgeError(errors.operation);
      return source;
    } finally {
      session.writing = false;
    }
  }

  function isLoading(session) {
    return session.state[session.loadingKey] !== false;
  }

  function end(session, restore = false, page = session.isClientSide ? session.initialPage : session.lastPage) {
    if (!live(session)) return;
    const settled = !session.pending || (session.pending.settled && session.pending.phase !== 'loading');
    const display = readDisplayData(session);
    const canRestore = restore && settled && session.pages.has(page) && context(session, false) && !isLoading(session)
      && display === session.mergedRows && session.form[session.pageNumKey] === session.lastPage;
    session.active = false;
    session.generation++;
    sessions.delete(session.table);
    for (const dispose of session.disposers.splice(0)) {
      try { dispose(); } catch (_) {}
    }
    if (session.isClientSide) {
      if (session.owner.setupState === session.state && session.state[session.formKey] === session.form
        && writable(session.form, 'pageSize') && session.form.pageSize === session.size) {
        session.form.pageSize = session.initialSize;
        if (canRestore) session.form[session.pageNumKey] = page;
      }
    } else if (canRestore) {
      assign(session, session.pages.get(page), page);
    }
  }

  function check(session) {
    if (!live(session)) return false;
    try {
      const stable = context(session) && environment(session.table) && session.pager.isConnected
        && session.pager.__vueParentComponent === session.pagerInstance
        && !session.pagerInstance.isUnmounted && !unsafeTable(session.table, session.instance.props);
      const display = readDisplayData(session);
      const expected = session.pending
        ? display === (session.pending.source || session.mergedRows)
          && session.form[session.pageNumKey] === (session.pending.pageChanged ? session.pending.page : session.lastPage)
        : display === session.mergedRows && session.form[session.pageNumKey] === session.lastPage
          && (!session.isClientSide || session.state[session.dataKey] === session.sourceData)
          && !isLoading(session) && session.form.total === session.total
          && (session.initializing || (session.instance.props.data === display && domRows(session.table).length === display.length
            && session.pagerInstance.props.currentPage === session.lastPage
            && session.pagerInstance.props.pageSize === session.size && session.pagerInstance.props.total === session.total));
      if (stable && expected) return true;
    } catch (_) {}
    end(session, true);
    return false;
  }

  function summary(session) {
    return {
      active: true,
      page: session.lastPage,
      total: session.total,
      loaded: session.mergedRows.length,
      next: !session.exhausted && session.lastPage < Math.ceil(session.total / session.size),
    };
  }

  function checkbox(target, table) {
    const control = target.closest('input[type="checkbox"], [role="checkbox"], .el-checkbox, .el-table-column--selection');
    return !!control && table.contains(control);
  }

  function clickable(target, row) {
    const cell = target.closest('td, [role="cell"]');
    if (!cell || cell.closest('.el-table__row') !== row) return false;
    for (let node = target; node && row.contains(node) && node !== row; node = node.parentElement) {
      if (node.matches('button, a, [role="button"], [role="link"], .el-link')
        || node.hasAttribute('onclick') || typeof node.onclick === 'function'
        || (node.hasAttribute('tabindex') && node.tabIndex >= 0)) return true;
      if (getComputedStyle(node).cursor === 'pointer'
        && (node.style.cursor === 'pointer' || getComputedStyle(node.parentElement).cursor !== 'pointer')) return true;
      if (node === cell) break;
    }
    return false;
  }

  function bind(session) {
    const dispose = session.disposers;
    const listen = (node, type, handler) => {
      node.addEventListener(type, handler, true);
      dispose.push(() => node.removeEventListener(type, handler, true));
    };
    const watch = (getter, callback, deep = false) => {
      const unwatch = session.owner.proxy.$watch(getter, (...args) => {
        if (!live(session) || session.writing) return;
        try { callback(...args); } catch (_) { end(session); }
      }, { flush: 'sync', deep });
      if (typeof unwatch !== 'function') throw new BridgeError(errors.operation);
      dispose.push(unwatch);
    };
    watch(() => readDisplayData(session), (rows, previous) => {
      const pending = session.pending;
      if (!pending || !['loading', 'restoring'].includes(pending.phase) || !context(session)
        || !pending.loadingStarted || rows === previous
        || session.form[session.pageNumKey] !== pending.page || !Array.isArray(rows)) return end(session);
      pending.source = rows;
    }, true);
    watch(() => session.form[session.pageNumKey], page => {
      const pending = session.pending;
      if (!pending || pending.phase !== 'loading' || pending.pageChanged || page !== pending.page || !context(session)) {
        return end(session);
      }
      pending.pageChanged = true;
    });
    watch(() => session.state[session.loadingKey], loading => {
      const pending = session.pending;
      if (!pending || !['loading', 'restoring'].includes(pending.phase) || !context(session)) return end(session, true);
      if (loading === true && !pending.loadingStarted) pending.loadingStarted = true;
      else if (loading === false && pending.loadingStarted && !pending.loadingEnded) pending.loadingEnded = true;
      else end(session);
    });
    watch(() => session.form.total, total => {
      if (!session.pending || !['loading', 'restoring'].includes(session.pending.phase) || !integer(total, 0)) end(session, true);
    });
    watch(() => session.state[session.formKey], () => end(session));
    watch(() => session.form.pageSize, () => end(session, true));
    watch(() => querySignature(session.owner, session.state, session.form), () => end(session, true));
    watch(() => session.instance.props.rowKey, () => end(session, true));

    const interaction = event => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target || !live(session) || checkbox(target, session.table)) return;
      if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
      if (target.closest('.el-table__header-wrapper, .el-table__footer-wrapper')) {
        end(session, true);
        return;
      }
      const row = target.closest('.el-table__row');
      if (!row || row.closest('.el-table') !== session.table || !clickable(target, row)) return;
      if (!check(session)) return;
      const rendered = domRows(session.table);
      const index = rendered.indexOf(row);
      if (index < 0 || rendered.length !== session.mergedRows.length
        || session.instance.props.data !== session.mergedRows) return end(session, true);
      const page = session.rowPages.get(keyOf(session.mergedRows[index], session.key));
      end(session, true, page);
    };
    listen(session.table, 'click', interaction);
    listen(session.table, 'keydown', interaction);
    const input = event => {
      const target = event.target;
      if (!(target instanceof Element) || checkbox(target, session.table)) return;
      if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) end(session, true);
    };
    listen(document, 'input', input);
    listen(document, 'change', input);
    listen(document, 'compositionstart', input);
    const navigation = () => end(session, true);
    for (const type of ['popstate', 'hashchange', 'pagehide']) listen(window, type, navigation);
    const observer = new MutationObserver(() => check(session));
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
    dispose.push(() => observer.disconnect());
    const timer = setInterval(() => check(session), 250);
    dispose.push(() => clearInterval(timer));
  }

  function start(found) {
    const { form, state, pageNumKey, isClientSide } = found;
    const displayData = state.tableData;
    const session = {
      ...found,
      url: location.href,
      initialPage: form[pageNumKey],
      initialSize: form.pageSize,
      size: isClientSide ? Math.max(form.pageSize, found.sourceData.length) : form.pageSize,
      lastPage: isClientSide ? 1 : form[pageNumKey],
      total: form.total,
      lastPageRows: displayData,
      mergedRows: displayData,
      pages: new Map([[form[pageNumKey], displayData]]),
      rowPages: new Map(Array.from(found.ids, id => [id, form[pageNumKey]])),
      seen: new Set(found.ids),
      active: true,
      exhausted: isClientSide || displayData.length === 0,
      initializing: isClientSide,
      pending: null,
      writing: false,
      generation: 0,
      disposers: [],
    };
    sessions.set(found.table, session);
    try {
      if (isClientSide) {
        const selected = found.instance.setupState.getSelectionRows().slice();
        for (let offset = 0; offset < found.sourceData.length; offset += session.initialSize) {
          const page = offset / session.initialSize + 1;
          const rows = found.sourceData.slice(offset, offset + session.initialSize);
          session.pages.set(page, rows);
          for (const row of rows) session.rowPages.set(keyOf(row, session.key), page);
        }
        form[pageNumKey] = 1;
        form.pageSize = session.size;
        session.mergedRows = readDisplayData(session);
        if (session.mergedRows.length !== found.sourceData.length
          || session.mergedRows.some((row, index) => row !== found.sourceData[index])) throw new BridgeError(errors.operation);
        bind(session);
        restoreSelection(session, selected, session.generation).then(() => {
          session.initializing = false;
          check(session);
        }, () => end(session, true));
      } else {
        bind(session);
      }
      return { supported: true, ...summary(session) };
    } catch (_) {
      end(session, true);
      return { supported: false };
    }
  }

  async function restoreSelection(session, selected, generation) {
    await session.owner.proxy.$nextTick();
    if (!live(session, generation) || !check(session)) throw new BridgeError(errors.changed);
    const api = session.instance.setupState;
    const current = api.getSelectionRows();
    if (!Array.isArray(current)) throw new BridgeError(errors.operation);
    const selectedIds = new Set(current.map(row => keyOf(row, session.key)));
    const byId = new Map(session.mergedRows.map(row => [keyOf(row, session.key), row]));
    for (const original of selected) {
      if (!live(session, generation) || !context(session)) throw new BridgeError(errors.changed);
      const id = keyOf(original, session.key);
      if (!selectedIds.has(id) && byId.has(id)) api.toggleRowSelection(byId.get(id), true);
    }
  }

  async function waitForLoad(session, pending, trigger, optional = false) {
    let started = false;
    let ended = false;
    let complete;
    let timer;
    const completion = new Promise(resolve => { complete = resolve; });
    const unwatch = session.owner.proxy.$watch(() => isLoading(session), loading => {
      if (loading) started = true;
      else if (started) { ended = true; complete(); }
    }, { flush: 'sync' });
    try {
      trigger();
      await session.owner.proxy.$nextTick();
      if (!started) {
        pending.settled = true;
        if (optional) return;
        throw new BridgeError(errors.load);
      }
      if (!ended) await Promise.race([completion, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new BridgeError(errors.load)), 16000);
      })]);
      await session.owner.proxy.$nextTick();
      pending.settled = true;
    } finally {
      clearTimeout(timer);
      unwatch();
    }
  }

  async function next(session) {
    if (!session || !check(session)) throw new BridgeError(errors.inactive);
    if (session.pending || inFlight.has(session.owner)) throw new BridgeError(errors.busy);
    if (!summary(session).next) return summary(session);
    const generation = session.generation;
    let selected;
    try {
      selected = session.instance.setupState.getSelectionRows();
      if (!Array.isArray(selected)) throw new Error();
      selected = selected.slice();
      selected.forEach(row => keyOf(row, session.key));
    } catch (_) {
      throw new BridgeError(errors.operation);
    }
    const pending = { page: session.lastPage + 1, phase: 'loading', source: null, pageChanged: false,
      loadingStarted: false, loadingEnded: false };
    session.pending = pending;
    inFlight.set(session.owner, pending);
    let committed = false;
    try {
      await waitForLoad(session, pending, () => {
        const button = nextButton(session.pager);
        if (!button || session.pagerInstance.props.disabled) throw new BridgeError(errors.load);
        button.click();
      });
      if (!live(session, generation) || !check(session)) throw new BridgeError(errors.changed);
      const rows = readDisplayData(session);
      if (!pending.pageChanged || !pending.loadingStarted || !pending.loadingEnded || isLoading(session)
        || session.form[session.pageNumKey] !== pending.page || !pending.source || rows !== pending.source
        || rows === session.mergedRows || rows.length > session.size || !integer(session.form.total, 0)) {
        throw new BridgeError(errors.load);
      }
      const ids = validateRows(rows, session.key, session.instance.props);
      const added = rows.filter(row => !session.seen.has(keyOf(row, session.key)));
      if (rows.length && !added.length) throw new BridgeError(errors.load);
      pending.phase = 'merging';
      const merged = assign(session, [...session.mergedRows, ...added], pending.page);
      session.lastPage = pending.page;
      session.lastPageRows = rows;
      session.pages.set(pending.page, rows);
      for (const id of ids) {
        if (!session.seen.has(id)) session.rowPages.set(id, pending.page);
        session.seen.add(id);
      }
      session.total = session.form.total;
      session.exhausted = rows.length === 0;
      session.mergedRows = merged;
      pending.source = merged;
      committed = true;
      await restoreSelection(session, selected, generation);
      if (!live(session, generation) || !check(session)) throw new BridgeError(errors.changed);
      return summary(session);
    } catch (_) {
      if (!live(session, generation) || !context(session)) {
        end(session);
        throw new BridgeError(errors.changed);
      }
      if (committed || isLoading(session)
        || session.form[session.pageNumKey] !== (pending.pageChanged ? pending.page : session.lastPage)
        || readDisplayData(session) !== (pending.source || session.mergedRows)) {
        if (committed && pending.settled) session.pending = null;
        end(session, committed);
        throw new BridgeError(errors.changed);
      }
      pending.phase = 'restoring';
      pending.page = session.lastPage;
      pending.pageChanged = true;
      pending.loadingStarted = false;
      pending.loadingEnded = false;
      pending.settled = false;
      try {
        await waitForLoad(session, pending, () => {
          session.mergedRows = assign(session, session.mergedRows, session.lastPage, session.total);
          pending.source = session.mergedRows;
        }, true);
        if (!live(session, generation) || !context(session) || isLoading(session) || session.form.total !== session.total) {
          throw new BridgeError(errors.changed);
        }
        session.mergedRows = assign(session, session.mergedRows, session.lastPage, session.total);
        pending.source = session.mergedRows;
        await restoreSelection(session, selected, generation);
      } catch (_) {
        end(session);
        throw new BridgeError(errors.changed);
      }
      throw new BridgeError(errors.load);
    } finally {
      if (inFlight.get(session.owner) === pending) {
        if (isLoading(session) && !session.owner.isUnmounted) {
          const unwatch = session.owner.proxy.$watch(() => isLoading(session), loading => {
            if (loading) return;
            unwatch();
            if (inFlight.get(session.owner) === pending) inFlight.delete(session.owner);
          }, { flush: 'sync' });
        } else {
          inFlight.delete(session.owner);
        }
      }
      if (session.pending === pending) session.pending = null;
    }
  }

  function respond(table, id, result, error) {
    table.dispatchEvent(new CustomEvent('geek-continuous-table-response', {
      detail: JSON.stringify(error ? { id, ok: false, error } : { id, ok: true, result }),
    }));
  }

  document.addEventListener('geek-continuous-table-request', event => {
    const table = event.target;
    if (!(table instanceof HTMLElement) || !table.matches('.el-table')) return;
    let id = '';
    try {
      if (typeof event.detail !== 'string' || event.detail.length > 4096) throw new BridgeError(errors.request);
      const request = JSON.parse(event.detail);
      if (!plain(request) || typeof request.id !== 'string' || request.id.length > 80) throw new BridgeError(errors.request);
      id = request.id;
      if (typeof request.command !== 'string' || !commands.has(request.command)) throw new BridgeError(errors.request);
      let session = sessions.get(table);
      if (session && !check(session)) session = null;
      if (request.command === 'next') {
        next(session).then(result => respond(table, id, result), error =>
          respond(table, id, null, error instanceof BridgeError ? error.message : errors.operation));
        return;
      }
      let result;
      if (request.command === 'stop') {
        if (session) end(session, true);
        result = { active: false };
      } else if (request.command === 'status') {
        result = session ? summary(session) : { active: false };
      } else if (session) {
        result = isLoading(session) ? { supported: false } : { supported: true, ...summary(session) };
        if (request.command === 'detect') delete result.active;
      } else {
        const found = contract(table);
        if (!found) result = { supported: false };
        else if (request.command === 'start') result = start(found);
        else result = { supported: true, page: found.form[found.pageNumKey], total: found.form.total,
          loaded: found.state.tableData.length,
          next: found.state.tableData.length > 0 && found.form[found.pageNumKey] < Math.ceil(found.form.total / found.form.pageSize) };
      }
      respond(table, id, result);
    } catch (error) {
      respond(table, id, null, error instanceof BridgeError ? error.message : errors.operation);
    }
  }, true);
})();
