class ContinuousBrowseHtmlAdapter {
  static hideElement(element) {
    if (!element || element.tagName === 'LINK') return null;
    const entry = [element, element.style.getPropertyValue('display'), element.style.getPropertyPriority('display')];
    element.style.setProperty('display', 'none', 'important');
    return entry;
  }

  static restoreElement(entry) {
    if (!entry) return;
    const [element, display, priority] = entry;
    if (display) element.style.setProperty('display', display, priority);
    else element.style.removeProperty('display');
  }

  static safeUrl(value, base) {
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch (_) {
      return null;
    }
  }

  static nextLink(doc, base, scope = doc) {
    const links = [...(scope.matches?.('a[href]') ? [scope] : []), ...scope.querySelectorAll('a[href], link[rel~="next"][href]')].filter(link => {
      if (link.closest('[aria-disabled="true"], .disabled') || link.hasAttribute('disabled')) return false;
      if (doc === document && link.tagName === 'A' && !link.getClientRects().length) return false;
      const label = (link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent).trim();
      return (link.getAttribute('rel') || '').split(/\s+/).includes('next')
        || /^(下一页|下页|后一页|next(?:\s+page)?)[\s›»>→]*$/i.test(label);
    });
    const urls = new Map();
    for (const link of links) {
      const url = this.safeUrl(link.getAttribute('href'), base);
      if (!url || url.origin !== new URL(base).origin) continue;
      url.hash = '';
      const current = new URL(base);
      current.hash = '';
      if (url.href !== current.href) urls.set(url.href, link);
    }
    if (urls.size > 1) return { ambiguous: true };
    if (!urls.size) return null;
    const [url, link] = urls.entries().next().value;
    return { url, link };
  }

  static selector(element) {
    const parts = [];
    while (element && element !== document.body) {
      if (element.id) {
        parts.unshift(`#${CSS.escape(element.id)}`);
        break;
      }
      const tag = element.localName;
      const classes = Array.from(element.classList).map(name => `.${CSS.escape(name)}`).join('');
      const segment = tag + classes;
      if (!element.parentElement || Array.from(element.parentElement.children).filter(el => el.matches(segment)).length !== 1) return null;
      parts.unshift(segment);
      element = element.parentElement;
    }
    return parts.join(' > ');
  }

  static detect() {
    const next = this.nextLink(document, location.href);
    if (!next?.url) return null;
    const pager = next.link.closest('nav, .pagination, .pager, .paging, .pages, [role="navigation"]') || next.link;
    const candidates = Array.from(document.querySelectorAll('main, [role="main"], article, ul, ol, tbody, .list, .posts, .results, .items'))
      .filter(el => el.getClientRects().length && !el.closest('nav, aside, header, footer, form')
        && !el.contains(pager) && !pager.contains(el)
        && !el.querySelector('input, select, textarea, button, [contenteditable="true"]'))
      .map(element => {
        const items = Array.from(element.children).filter(el => !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(el.tagName));
        const repeated = items.length >= 2 && items.every(el => el.tagName === items[0].tagName)
          && ['LI', 'TR', 'ARTICLE', 'DIV', 'SECTION'].includes(items[0].tagName);
        const article = element.tagName === 'ARTICLE' && element.querySelector('p');
        if (!repeated && !article) return null;
        let ancestor = element.parentElement;
        let distance = 0;
        while (ancestor && !ancestor.contains(pager)) { ancestor = ancestor.parentElement; distance++; }
        if (!ancestor || distance > 3) return null;
        if (pager.tagName !== 'LINK' && !(element.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
        return { element, score: (element.closest('main, [role="main"]') ? 10 : 0) - distance * 3, article };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) return null;
    const { element, article } = candidates[0];
    const selector = this.selector(element);
    if (!selector || document.querySelectorAll(selector).length !== 1) return null;
    return new ContinuousBrowseHtmlAdapter(element, pager, next.url, selector, article);
  }

  constructor(element, pager, nextUrl, selector, article) {
    this.name = '通用 HTML 分页';
    this.element = element;
    this.pager = pager;
    this.pagerSelector = pager.tagName === 'LINK' ? null : ContinuousBrowseHtmlAdapter.selector(pager);
    this.nextUrl = nextUrl;
    this.selector = selector;
    this.article = article;
    this.page = 1;
    this.total = null;
    this.hideOriginal = false;
    this.seen = new Set(this.items(element).map(item => this.key(item, location.href)));
    this.loaded = this.seen.size;
    this.visited = new Set([location.href.split('#')[0]]);
  }

  items(element) {
    return this.article ? [element] : Array.from(element.children).filter(el => !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(el.tagName));
  }

  key(item, base) {
    const link = item.matches('a[href]') ? item : item.querySelector('a[href]');
    const url = link && ContinuousBrowseHtmlAdapter.safeUrl(link.getAttribute('href'), base);
    const text = item.textContent.replace(/\s+/g, ' ').trim();
    const images = Array.from(item.querySelectorAll('img')).map(image =>
      ContinuousBrowseHtmlAdapter.safeUrl(image.getAttribute('data-src') || image.getAttribute('src'), base)?.href || '').join('\n');
    return url || text || images ? `${url?.href || ''}\n${text}\n${images}` : `${base}\n${item.outerHTML}`;
  }

  static sanitize(node, base, presentation = false, mapElement) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    const textButton = presentation && node.tagName === 'BUTTON';
    if (!textButton && ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT'].includes(node.tagName)) {
      return document.createDocumentFragment();
    }
    const allowed = new Set(['A', 'IMG', 'P', 'DIV', 'SPAN', 'ARTICLE', 'SECTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'PRE', 'CODE', 'BLOCKQUOTE', 'STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'SMALL', 'SUP', 'SUB', 'BR', 'HR', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'TIME']);
    if (!allowed.has(node.tagName) && !textButton) {
      const fragment = document.createDocumentFragment();
      for (const child of node.childNodes) fragment.appendChild(this.sanitize(child, base, presentation, mapElement));
      return fragment;
    }
    const clean = document.createElement(textButton ? 'span' : node.localName);
    if (presentation) {
      const style = getComputedStyle(node);
      for (const property of ['display', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
        'padding', 'margin', 'border', 'border-radius', 'color', 'background-color', 'font-family', 'font-size', 'font-weight',
        'font-style', 'line-height', 'text-align', 'text-decoration-line', 'text-overflow', 'white-space', 'overflow',
        'overflow-wrap', 'word-break', 'vertical-align', 'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap', 'object-fit']) {
        clean.style.setProperty(property, style.getPropertyValue(property));
      }
    }
    if (node.tagName === 'A') {
      const url = this.safeUrl(node.getAttribute('href'), base);
      if (url && node.hasAttribute('href')) {
        clean.href = url.href;
        clean.target = '_blank';
        clean.rel = 'noopener noreferrer';
      }
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('data-src') || node.getAttribute('src');
      const url = src && this.safeUrl(src, base);
      if (url) clean.src = url.href;
      clean.alt = node.getAttribute('alt') || '';
      clean.loading = 'lazy';
    }
    for (const child of node.childNodes) clean.appendChild(this.sanitize(child, base, presentation, mapElement));
    mapElement?.(node, clean);
    return clean;
  }

  initial() { return null; }

  async load(signal) {
    if (this.visited.has(this.nextUrl)) throw new Error('分页链接重复，已停止加载');
    const response = await fetch(this.nextUrl, { credentials: 'same-origin', redirect: 'error', signal });
    if (!response.ok) throw new Error(`加载失败（HTTP ${response.status}），请重试`);
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) {
      throw new Error('下一页不是 HTML，当前页面暂未适配');
    }
    if (Number(response.headers.get('content-length')) > 5 * 1024 * 1024) throw new Error('下一页内容过大，已停止加载');
    const html = await response.text();
    if (html.length > 5 * 1024 * 1024) throw new Error('下一页内容过大，已停止加载');
    signal.throwIfAborted();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const matches = doc.querySelectorAll(this.selector);
    const element = matches[0];
    if (matches.length !== 1 || element.localName !== this.element.localName
      || element.querySelector('input, select, textarea, button, [contenteditable="true"]')
      || (!this.article && this.items(element).some(item => item.tagName !== this.items(this.element)[0]?.tagName))) {
      throw new Error('下一页结构不匹配，当前页面暂未适配');
    }
    const pagers = this.pagerSelector ? doc.querySelectorAll(this.pagerSelector) : [];
    const next = ContinuousBrowseHtmlAdapter.nextLink(doc, response.url, pagers[0] || doc);
    if (pagers.length > 1 || next?.ambiguous) throw new Error('下一页分页规则不明确，当前页面暂未适配');
    const fragment = document.createDocumentFragment();
    const wrapper = document.createElement(this.article ? 'div' : this.element.localName);
    let added = 0;
    for (const item of this.items(element)) {
      const key = this.key(item, response.url);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      wrapper.appendChild(ContinuousBrowseHtmlAdapter.sanitize(item, response.url));
      added++;
    }
    if (!added) throw new Error('下一页没有新内容，已停止重复加载');
    if (wrapper.tagName === 'TBODY') {
      const table = document.createElement('table');
      const head = this.element.closest('table')?.querySelector('thead');
      if (head) table.appendChild(ContinuousBrowseHtmlAdapter.sanitize(head, location.href));
      table.appendChild(wrapper);
      fragment.appendChild(table);
    } else {
      fragment.appendChild(wrapper);
    }
    this.visited.add(this.nextUrl);
    this.nextUrl = next?.url || null;
    if (this.visited.has(this.nextUrl)) this.nextUrl = null;
    this.loaded += added;
    this.page++;
    return fragment;
  }

  hide() {
    this.hiddenEntry = ContinuousBrowseHtmlAdapter.hideElement(this.pager);
  }

  restore() {
    ContinuousBrowseHtmlAdapter.restoreElement(this.hiddenEntry);
    this.hiddenEntry = null;
  }

  destroy() {
    this.restore();
  }
}

class ContinuousBrowseTableAdapter {
  static requestId = 0;

  static send(element, command) {
    const id = `table-${Date.now()}-${++this.requestId}`;
    let response = null;
    const listener = event => {
      if (event.target !== element || typeof event.detail !== 'string') return;
      try {
        const data = JSON.parse(event.detail);
        if (data.id === id && data.ok === true) response = data.result;
      } catch (_) {}
    };
    element.addEventListener('geek-continuous-table-response', listener);
    try {
      element.dispatchEvent(new CustomEvent('geek-continuous-table-request', {
        detail: JSON.stringify({ id, command }), bubbles: true,
      }));
    } finally {
      element.removeEventListener('geek-continuous-table-response', listener);
    }
    return response;
  }

  static validStatus(value) {
    return value && Number.isInteger(value.page) && value.page > 0
      && Number.isInteger(value.loaded) && value.loaded >= 0
      && Number.isInteger(value.total) && value.total >= 0 && typeof value.next === 'boolean';
  }

  static detect() {
    const tables = Array.from(document.querySelectorAll('.el-table')).filter(el => el.getClientRects().length);
    if (tables.length !== 1) {
      console.debug('[table-adapter] detect FAIL: visible tables=' + tables.length);
      return null;
    }
    const element = tables[0];
    const mountTarget = element.querySelector('.el-table__body-wrapper .el-scrollbar__view');
    if (!mountTarget) {
      console.debug('[table-adapter] detect FAIL: no mountTarget (.el-table__body-wrapper .el-scrollbar__view)');
      return null;
    }
    let parent = element.parentElement;
    let pager;
    for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
      const pagers = Array.from(parent.querySelectorAll('.el-pagination')).filter(el => el.getClientRects().length);
      if (pagers.length > 1) {
        console.debug('[table-adapter] detect FAIL: multiple pagers at depth=' + depth);
        return null;
      }
      if (pagers.length === 1) { pager = pagers[0]; break; }
    }
    if (!pager) {
      console.debug('[table-adapter] detect FAIL: no pager within 5 ancestor levels');
      return null;
    }
    const result = this.send(element, 'detect');
    if (!result?.supported || !this.validStatus(result)) {
      console.debug('[table-adapter] detect FAIL: bridge result=', JSON.stringify(result));
      return null;
    }
    console.debug('[table-adapter] detect SUCCESS');
    return new ContinuousBrowseTableAdapter(element, pager, mountTarget, result);
  }

  constructor(element, pager, mountTarget, status) {
    this.name = 'Element Plus 表格（原生交互）';
    this.element = element;
    this.pager = pager;
    this.mountTarget = mountTarget;
    this.interactive = true;
    this.hideOriginal = false;
    this.started = false;
    this.update(status);
  }

  update(status) {
    this.page = status.page;
    this.loaded = status.loaded;
    this.total = status.total;
    this.nextUrl = status.next;
  }

  start() {
    const result = ContinuousBrowseTableAdapter.send(this.element, 'start');
    if (!result?.active || !ContinuousBrowseTableAdapter.validStatus(result)) return false;
    this.started = true;
    this.update(result);
    return true;
  }

  initial() { return null; }

  isCurrent() {
    return ContinuousBrowseTableAdapter.send(this.element, 'status')?.active === true;
  }

  async load(signal) {
    const id = `table-${Date.now()}-${++ContinuousBrowseTableAdapter.requestId}`;
    const result = await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.element.removeEventListener('geek-continuous-table-response', listener);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        this.destroy();
        reject(new DOMException('已取消表格加载', 'AbortError'));
      };
      const listener = event => {
        if (event.target !== this.element || typeof event.detail !== 'string') return;
        let data;
        try { data = JSON.parse(event.detail); } catch (_) { return; }
        if (data.id !== id) return;
        cleanup();
        if (data.ok !== true || !data.result?.active || !ContinuousBrowseTableAdapter.validStatus(data.result)) {
          reject(new Error('表格加载失败或页面已变化，请重新检测'));
        } else resolve(data.result);
      };
      if (signal.aborted) { abort(); return; }
      this.element.addEventListener('geek-continuous-table-response', listener);
      signal.addEventListener('abort', abort, { once: true });
      this.element.dispatchEvent(new CustomEvent('geek-continuous-table-request', {
        detail: JSON.stringify({ id, command: 'next' }), bubbles: true,
      }));
    });
    this.update(result);
    return null;
  }

  hide() {
    this.hiddenEntry = ContinuousBrowseHtmlAdapter.hideElement(this.pager);
  }

  restore() {
    ContinuousBrowseHtmlAdapter.restoreElement(this.hiddenEntry);
    this.hiddenEntry = null;
  }

  destroy() {
    this.restore();
    if (!this.started) return;
    this.started = false;
    ContinuousBrowseTableAdapter.send(this.element, 'stop');
  }
}

class ContinuousBrowseYApiAdapter {
  static detect() {
    const route = location.pathname.match(/^\/project\/(\d+)\/interface\/api\/cat_(\d+)\/?$/);
    const element = document.querySelector('.table-interfacelist');
    if (!route || !element || !element.getClientRects().length) return null;
    const rows = Array.from(element.querySelectorAll('tbody > tr'));
    const headers = Array.from(element.querySelectorAll('thead th')).map(el => el.textContent.trim());
    if (headers.join('|') !== '接口名称|接口路径|接口分类|状态|tag' || !rows.length
      || !rows.every(row => row.cells.length === 5 && row.querySelector(`a[href^="/project/${route[1]}/interface/api/"]`))) return null;
    const page = Number(element.querySelector('.ant-pagination-item-active')?.textContent);
    const next = element.querySelector('.ant-pagination-next');
    if (!Number.isInteger(page) || page < 1 || !next) return null;
    return new ContinuousBrowseYApiAdapter(element, route[1], route[2], rows, headers, page, next);
  }

  constructor(element, project, category, rows, headers, page, next) {
    this.name = 'YApi 接口分类（只读）';
    this.element = element;
    this.pager = null;
    this.hideOriginal = true;
    this.project = project;
    this.category = category;
    this.headers = headers;
    this.page = page;
    this.limit = rows.length;
    this.loaded = rows.length;
    this.total = null;
    this.nextUrl = next.getAttribute('aria-disabled') === 'true' || next.classList.contains('ant-pagination-disabled') ? null : true;
    this.rows = rows;
    this.categoryName = rows[0].cells[2].textContent.trim();
    this.seen = new Set(rows.map(row => row.querySelector('a[href]').getAttribute('href').split('/').pop()));
  }

  table() {
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const label of this.headers) {
      const cell = document.createElement('th');
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.createTBody();
    return table;
  }

  initial() {
    const table = this.table();
    for (const original of this.rows) {
      const row = table.tBodies[0].insertRow();
      Array.from(original.cells).forEach((cell, index) => {
        const target = row.insertCell();
        if (index === 0) {
          target.appendChild(ContinuousBrowseHtmlAdapter.sanitize(cell.querySelector('a[href]'), location.href));
        } else {
          target.textContent = cell.textContent.trim();
        }
      });
    }
    return table;
  }

  async load(signal) {
    const url = new URL('/api/interface/list_cat', location.origin);
    url.search = new URLSearchParams({ page: this.page + 1, limit: this.limit, catid: this.category });
    const response = await fetch(url.href, { credentials: 'same-origin', redirect: 'error', signal });
    if (!response.ok) throw new Error(`加载失败（HTTP ${response.status}），请重试`);
    const body = await response.json();
    signal.throwIfAborted();
    const data = body.data;
    if (body.errcode !== 0 || !Array.isArray(data?.list) || !Number.isInteger(data.count) || data.count < 0
      || !Number.isInteger(data.total) || data.total < 0 || !data.list.every(item => Number.isInteger(item._id)
        && String(item.catid) === this.category && String(item.project_id) === this.project && typeof item.title === 'string')) {
      throw new Error('YApi 返回异常，请确认登录状态后重试');
    }
    const table = this.table();
    let added = 0;
    for (const item of data.list) {
      if (this.seen.has(String(item._id))) continue;
      this.seen.add(String(item._id));
      const row = table.tBodies[0].insertRow();
      const link = document.createElement('a');
      link.href = `/project/${this.project}/interface/api/${item._id}`;
      link.textContent = item.title;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.insertCell().appendChild(link);
      for (const value of [item.path, this.categoryName, item.status === 'done' ? '已完成' : '未完成', Array.isArray(item.tag) ? item.tag.join('、') : '']) {
        row.insertCell().textContent = value == null ? '' : String(value);
      }
      added++;
    }
    if (!added && data.list.length) throw new Error('下一页没有新内容，已停止重复加载');
    this.page++;
    this.loaded += added;
    this.total = data.count;
    this.nextUrl = data.list.length && this.page < data.total ? true : null;
    return added ? table : null;
  }

  hide() {
    this.hiddenEntry = ContinuousBrowseHtmlAdapter.hideElement(this.element);
  }

  restore() {
    ContinuousBrowseHtmlAdapter.restoreElement(this.hiddenEntry);
    this.hiddenEntry = null;
  }

  destroy() {
    this.restore();
  }
}

class ContinuousBrowseClickAdapter {
  static pagerSelector = '.pagination, .pager, .paging, .pages, .next-pagination, .ant-pagination, .el-pagination, nav[aria-label], [role="navigation"][aria-label]';
  static currentSelector = '[aria-current="page"], .next-current, .ant-pagination-item-active, .el-pager .is-active, .active, .current';

  static visible(element) {
    return element.isConnected && element.getClientRects().length > 0
      && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility);
  }

  static currentPage(pager) {
    const values = new Set(Array.from(pager.querySelectorAll(this.currentSelector))
      .map(el => el.textContent.trim()).filter(text => /^\d+$/.test(text)).map(Number));
    const page = values.size === 1 ? [...values][0] : null;
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  }

  static nextButton(pager) {
    const candidates = Array.from(pager.querySelectorAll('button, a, [role="button"], .ant-pagination-next')).filter(el => {
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim();
      return /^(下一页|下页|后一页|next(?:\s+page)?)(?:$|[\s，,›»>→])/i.test(label)
        || el.matches('.next-next, .ant-pagination-next, .btn-next, [rel~="next"]');
    });
    const buttons = [...new Set(candidates.map(el => el.matches('button, a, [role="button"]') ? el : el.querySelector('button, a, [role="button"]')))].filter(Boolean);
    if (buttons.length !== 1) return null;
    const button = buttons[0];
    if (button instanceof HTMLButtonElement && button.type === 'submit' && button.form) return null;
    if (button.tagName === 'A' && button.hasAttribute('href')) {
      const href = button.getAttribute('href');
      if (href && href !== '#' && href !== location.href) return null;
    }
    return button;
  }

  static disabled(button) {
    return !button || button.matches(':disabled, [disabled]')
      || !!button.closest('[aria-disabled="true"], .disabled, .is-disabled, .ant-pagination-disabled');
  }

  static pageButton(pager, target, current) {
    const safe = button => {
      if (!(button instanceof HTMLElement) || this.disabled(button)) return false;
      if (button instanceof HTMLButtonElement && button.type === 'submit' && button.form) return false;
      return button.tagName !== 'A' || !button.getAttribute('href')
        || ['#', location.href].includes(button.getAttribute('href'));
    };
    const numbered = Array.from(pager.querySelectorAll('button, a, [role="button"], .ant-pagination-item, .el-pager li'))
      .filter(button => button.textContent.trim() === String(target) && safe(button));
    const outer = numbered.filter(button => !numbered.some(other => other !== button && other.contains(button)));
    if (outer.length === 1) return { button: outer[0], page: target };
    if (target > current) {
      const button = this.nextButton(pager);
      return safe(button) ? { button, page: current + 1 } : null;
    }
    const previous = Array.from(pager.querySelectorAll('button, a, [role="button"], .ant-pagination-prev')).filter(button => {
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent.trim();
      return /^(上一页|上页|前一页|previous(?:\s+page)?|prev)(?:$|[\s，,‹«<←])/i.test(label)
        || button.matches('.next-prev, .ant-pagination-prev, .btn-prev, [rel~="prev"]');
    });
    const buttons = [...new Set(previous.map(button => button.matches('button, a, [role="button"]')
      ? button : button.querySelector('button, a, [role="button"]')))].filter(safe);
    return buttons.length === 1 ? { button: buttons[0], page: current - 1 } : null;
  }

  static rows(element) {
    if (element.matches('table, .next-table, .ant-table, .el-table, [role="table"], [role="grid"]')) {
      return Array.from(element.querySelectorAll('tbody > tr, [role="row"]')).filter(row =>
        row.querySelector('td, [role="cell"], [role="gridcell"]') && !row.closest('thead')
        && !row.matches('[aria-hidden="true"], .next-table-expanded-row, .ant-table-expanded-row'));
    }
    return Array.from(element.children).filter(el => !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(el.tagName));
  }

  static detect() {
    const visible = element => this.visible(element);
    if (Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .el-dialog, .el-drawer')).some(visible)) return null;
    const allPagers = Array.from(document.querySelectorAll(this.pagerSelector)).filter(visible);
    const pagers = allPagers.filter(pager => !allPagers.some(other => other !== pager && pager.contains(other)));
    if (pagers.length !== 1) return null;
    const pager = pagers[0];
    const page = this.currentPage(pager);
    const button = this.nextButton(pager);
    if (!page || !button) return null;
    const elements = [...new Set(Array.from(document.querySelectorAll('table, [role="table"], [role="grid"], ul, ol, [role="list"], .list, .results, .items'))
      .map(el => el.closest('.next-table, .ant-table, .el-table') || el))].filter(el => {
      if (!visible(el) || el.contains(pager) || pager.contains(el) || el.closest('nav, aside, header, footer, [data-geek-continuous-browse]')) return false;
      if (el.matches('.el-table-v2, [aria-rowcount]') || el.querySelector('.next-virtual-scroller, .ant-table-tbody-virtual, .el-table-v2')) return false;
      const rows = this.rows(el);
      return rows.length >= 2 && rows.every(row => row.tagName === rows[0].tagName)
        && ['TR', 'LI', 'DIV', 'ARTICLE', 'SECTION'].includes(rows[0].tagName);
    });
    const candidates = elements.filter(el => !elements.some(other => el !== other && el.contains(other)));
    for (let scope = pager.parentElement, depth = 0; scope && depth < 6; scope = scope.parentElement, depth++) {
      const matches = candidates.filter(el => scope.contains(el));
      if (!matches.length) continue;
      if (matches.length !== 1 || !(matches[0].compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
      const adapter = new ContinuousBrowseClickAdapter(matches[0], pager, scope, page);
      return adapter.busy() ? null : adapter;
    }
    return null;
  }

  constructor(element, pager, scope, page) {
    this.name = '通用按钮分页（只读）';
    this.element = scope;
    this.source = element;
    this.pager = pager;
    this.scope = scope;
    this.mountTarget = scope;
    this.page = page;
    this.total = null;
    this.hideOriginal = false;
    this.hidePager = false;
    this.handlesMutations = true;
    this.hidden = new Map();
    this.sourceSelector = ['.next-table', '.ant-table', '.el-table'].find(selector => element.matches(selector))
      || (element.id ? `#${CSS.escape(element.id)}` : element.localName + (element.getAttribute('role') ? `[role="${CSS.escape(element.getAttribute('role'))}"]` : ''));
    this.note = '连续浏览 · 点击副本会暂停加载，自动翻回该记录所在分页并核对后执行；操作期间原表格保持隐藏，事件代理到原行触发，点击继续可恢复连续浏览。详情链接在新标签页打开。';
    this.url = location.href;
    this.schema = this.structure();
    this.signature = this.fingerprint();
    this.nativePage = page;
    this.pageSignatures = new Map([[page, this.signature]]);
    this.seen = new Set(ContinuousBrowseClickAdapter.rows(element).map(row => this.key(row)));
    this.loaded = this.seen.size;
    this.copyTargets = new WeakMap();
    this.host = null;
    this.nextUrl = !ContinuousBrowseClickAdapter.disabled(ContinuousBrowseClickAdapter.nextButton(pager));
    const rect = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (/(hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        this.viewportHeight = Math.max(120, Math.min(rect.height, parent.getBoundingClientRect().bottom - rect.top));
        break;
      }
    }
  }

  key(row) {
    const id = row.getAttribute('data-row-key') || row.getAttribute('data-id') || row.getAttribute('data-key') || row.id;
    if (id) return `id:${id}`;
    return ContinuousBrowseHtmlAdapter.prototype.key.call(null, row, this.url);
  }

  fingerprint() {
    return JSON.stringify(ContinuousBrowseClickAdapter.rows(this.source).map(row => [this.key(row), row.textContent]));
  }

  structure() {
    return JSON.stringify([
      Array.from(this.source.querySelectorAll('thead th, [role="columnheader"]')).map(el => el.textContent.trim()),
      ContinuousBrowseClickAdapter.rows(this.source).slice(0, 1).map(row => [row.tagName, row.querySelectorAll('td, [role="cell"], [role="gridcell"]').length]),
    ]);
  }

  busy() {
    return this.scope.matches('[aria-busy="true"]') || !!this.scope.querySelector('[aria-busy="true"]')
      || Array.from(this.scope.querySelectorAll('.next-loading, .ant-spin-spinning, .el-loading-mask, [role="progressbar"]'))
        .some(el => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
  }

  refresh() {
    const sources = Array.from(this.scope.querySelectorAll(this.sourceSelector));
    const pagers = Array.from(this.scope.querySelectorAll(ContinuousBrowseClickAdapter.pagerSelector));
    const innerPagers = pagers.filter(pager => !pagers.some(other => other !== pager && pager.contains(other)));
    if (sources.length !== 1 || innerPagers.length !== 1) return false;
    this.source = sources[0];
    this.pager = innerPagers[0];
    return true;
  }

  hide() {
    for (let element of [this.source, this.pager]) {
      while (element.parentElement !== this.scope && element.parentElement) element = element.parentElement;
      if (!this.hidden.has(element)) this.hidden.set(element, [element.style.getPropertyValue('visibility'), element.style.getPropertyPriority('visibility')]);
      if (element.style.getPropertyValue('visibility') !== 'hidden' || element.style.getPropertyPriority('visibility') !== 'important') {
        element.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }

  context() {
    return !this.invalid && !this.destroyed && location.href === this.url && this.scope.isConnected
      && !Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(el => ContinuousBrowseClickAdapter.visible(el));
  }

  isCurrent() {
    if (!this.context()) return false;
    if (this.pending) return true;
    if (!this.source.isConnected || !this.pager.isConnected) return false;
    return this.refresh() && !this.busy() && this.structure() === this.schema && this.fingerprint() === this.signature
      && ContinuousBrowseClickAdapter.currentPage(this.pager) === this.nativePage;
  }

  contentIntact() {
    if (this.invalid || this.destroyed || !this.scope.isConnected) return false;
    if (this.pending) {
      const before = new URL(this.url);
      const now = new URL(location.href);
      return before.origin === now.origin && before.pathname === now.pathname && before.search === now.search;
    }
    if (!this.source.isConnected || !this.pager.isConnected) return false;
    const before = new URL(this.url);
    const now = new URL(location.href);
    if (before.origin !== now.origin || before.pathname !== now.pathname || before.search !== now.search) return false;
    return this.refresh() && this.structure() === this.schema && this.fingerprint() === this.signature
      && ContinuousBrowseClickAdapter.currentPage(this.pager) === this.nativePage;
  }

  start() {
    if (!this.isCurrent()) return false;
    const rows = ContinuousBrowseClickAdapter.rows(this.source);
    if (rows[0]?.matches('tr, [role="row"]')) {
      const cells = rows[0].querySelectorAll('td, [role="cell"], [role="gridcell"]');
      this.columnWidths = Array.from(cells, cell => cell.getBoundingClientRect().width);
    }
    this.onInteraction = event => {
      if (this.triggering || event.composedPath().some(el => el instanceof HTMLElement && el.dataset.geekContinuousBrowse)) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target) return;
      if (['input', 'change'].includes(event.type) && target.closest('input, select, textarea, [contenteditable]')) {
        this.invalid = true;
        this.pending?.(new Error('原页面筛选或输入已变化，请恢复原分页后重试'));
        return;
      }
      const pager = this.pager;
      if (pager && (target === pager || pager.contains(target))) {
        this.invalid = true;
        this.pending?.(new Error('原页面分页已变化，请恢复原分页后重试'));
        return;
      }
      const button = target.closest('button, [role="button"], a[href]');
      if (button) {
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim();
        if (/^(筛选|过滤|搜索|重置|清空|导出|批量|排序|filter|search|reset|export|sort)/i.test(label)) {
          this.invalid = true;
          this.pending?.(new Error('原页面筛选或操作已变化，请恢复原分页后重试'));
          return;
        }
      }
      if (this.source.contains(target) && target.closest('th, [role="columnheader"]')) {
        this.invalid = true;
        this.pending?.(new Error('原页面排序已变化，请恢复原分页后重试'));
        return;
      }
    };
    for (const type of ['click', 'input', 'change']) document.addEventListener(type, this.onInteraction, true);
    return true;
  }

  bindHost(host, runInteraction) {
    this.host = host;
    this.onCopyClick = event => {
      const path = event.composedPath();
      if (path.some(node => node instanceof HTMLAnchorElement && node.getAttribute('href'))) return;
      const copy = path.find(node => this.copyTargets.has(node));
      if (!copy) return;
      event.preventDefault();
      event.stopPropagation();
      const descriptor = this.copyTargets.get(copy);
      const copyRect = copy.getBoundingClientRect();
      runInteraction(signal => this.activate(descriptor, signal, copyRect));
    };
    host.addEventListener('click', this.onCopyClick);
  }

  initial() {
    const rows = ContinuousBrowseClickAdapter.rows(this.source);
    return rows.length ? this.snapshot(rows) : null;
  }

  targetSignature(element) {
    return JSON.stringify([element.tagName, element.textContent,
      ...['role', 'type', 'name', 'aria-label', 'title', 'href', 'data-action'].map(name => element.getAttribute(name))]);
  }

  async activate(descriptor, signal, copyRect) {
    signal.throwIfAborted();
    if (!this.isCurrent() || this.pending) throw new Error('原页面已变化，请恢复原分页后重试');
    await this.navigate(descriptor.row.page, signal);
    signal.throwIfAborted();
    const matches = ContinuousBrowseClickAdapter.rows(this.source).filter(row => this.key(row) === descriptor.row.key);
    if (!this.isCurrent() || matches.length !== 1 || matches[0].textContent !== descriptor.row.text) {
      throw new Error('原记录已变化，已取消点击，请恢复原分页后操作');
    }
    let target = matches[0];
    const signatures = [this.targetSignature(target)];
    for (const index of descriptor.path) {
      target = target?.children[index];
      if (target) signatures.push(this.targetSignature(target));
    }
    if (!(target instanceof HTMLElement) || JSON.stringify(signatures) !== descriptor.signature
      || target.closest(':disabled, [disabled], [aria-disabled="true"]')) {
      throw new Error('原操作已变化或不可用，已取消点击，请恢复原分页后操作');
    }
    this.triggering = true;
    try {
      if (!target.isConnected || target.closest(':disabled, [disabled]')) {
        throw new Error('原操作不可用，已取消点击');
      }
      // 原表格保持隐藏（visibility:hidden 仍保留布局与有效矩形，浮层可正常锚定），
      // 用 transform 把原按钮平移到副本行的视口位置，使浮层出现在用户点击处；
      // transform 不移出文档流，不会引起副本列表偏移。
      let wrapper = this.source;
      while (wrapper.parentElement !== this.scope && wrapper.parentElement) wrapper = wrapper.parentElement;
      if (copyRect) {
        const targetRect = target.getBoundingClientRect();
        const savedTransform = wrapper.style.transform;
        wrapper.style.transform = `translate(${copyRect.left - targetRect.left}px, ${copyRect.top - targetRect.top}px)`;
        target.click();
        await new Promise(resolve => setTimeout(resolve, 350));
        wrapper.style.transform = savedTransform;
      } else {
        target.scrollIntoView({ block: 'center', behavior: 'instant' });
        target.click();
        await new Promise(resolve => setTimeout(resolve, 350));
      }
      this.hide();
    } finally {
      this.triggering = false;
    }
  }

  async navigate(page, signal) {
    while (this.nativePage !== page) {
      signal.throwIfAborted();
      if (!this.isCurrent() || this.pending) throw new Error('原页面已变化，已取消点击');
      const step = ContinuousBrowseClickAdapter.pageButton(this.pager, page, this.nativePage);
      if (!step) throw new Error('无法恢复目标分页，请关闭连续浏览后在原页操作');
      await this.turnPage(step.button, step.page, signal);
    }
    if (this.pageSignatures.has(page) && this.fingerprint() !== this.pageSignatures.get(page)) {
      this.invalid = true;
      throw new Error('目标分页内容已变化，已取消点击，请恢复原分页后重试');
    }
  }

  snapshot(rows, page = this.page) {
    const tableRows = rows[0]?.matches('tr, [role="row"]');
    const result = document.createElement(tableRows ? 'table' : this.source.matches('ul, ol') ? this.source.localName : 'div');
    const copyCell = (cell, target, mapElement) => {
      const content = ContinuousBrowseHtmlAdapter.sanitize(cell, this.url, true, mapElement);
      mapElement?.(cell, target);
      target.style.cssText = content.style.cssText;
      target.style.display = 'table-cell';
      target.style.boxSizing = 'border-box';
      target.style.minWidth = '0';
      target.style.width = '';
      target.title = cell.textContent.trim();
      target.append(...content.childNodes);
    };
    if (tableRows) {
      const columns = document.createElement('colgroup');
      for (const width of this.columnWidths) {
        const column = document.createElement('col');
        column.style.width = `${width}px`;
        columns.appendChild(column);
      }
      result.appendChild(columns);
      result.style.tableLayout = 'fixed';
      result.style.width = `${this.columnWidths.reduce((sum, width) => sum + width, 0)}px`;
      const header = result.createTHead().insertRow();
      for (const cell of this.source.querySelectorAll('thead th, [role="columnheader"]')) {
        const th = document.createElement('th');
        copyCell(cell, th);
        header.appendChild(th);
      }
      result.createTBody();
    }
    for (const source of rows) {
      const identity = { key: this.key(source), page, text: source.textContent };
      const mapElement = (original, copy) => {
        const path = [];
        const signatures = [this.targetSignature(original)];
        for (let node = original; node !== source; node = node.parentElement) {
          path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
          signatures.unshift(this.targetSignature(node.parentElement));
        }
        this.copyTargets.set(copy, { row: identity, path, signature: JSON.stringify(signatures) });
        if (copy instanceof HTMLAnchorElement && ['', '#'].includes(original.getAttribute('href'))) copy.removeAttribute('href');
      };
      if (tableRows) {
        const row = result.tBodies[0].insertRow();
        row.dataset.geekRow = identity.key;
        mapElement(source, row);
        for (const cell of source.querySelectorAll('td, [role="cell"], [role="gridcell"]')) copyCell(cell, row.insertCell(), mapElement);
      } else {
        const copy = ContinuousBrowseHtmlAdapter.sanitize(source, this.url, true, mapElement);
        if (copy instanceof HTMLElement) copy.dataset.geekRow = identity.key;
        result.appendChild(copy);
      }
    }
    return result;
  }

  async load(signal) {
    signal.throwIfAborted();
    if (!this.isCurrent() || this.pending) throw new Error('原页面已变化，请恢复原分页后重试');
    await this.navigate(this.page, signal);
    signal.throwIfAborted();
    if (!this.isCurrent() || this.pending) throw new Error('原页面已变化，请恢复原分页后重试');
    const button = ContinuousBrowseClickAdapter.nextButton(this.pager);
    if (ContinuousBrowseClickAdapter.disabled(button)) throw new Error('未找到可用的下一页按钮');
    const expected = this.page + 1;
    await this.turnPage(button, expected, signal);
    const keys = new Set(this.seen);
    const added = ContinuousBrowseClickAdapter.rows(this.source).filter(row => {
      const key = this.key(row);
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    if (!added.length) {
      this.invalid = true;
      throw new Error('下一页没有新内容，已停止重复加载');
    }
    const result = this.snapshot(added, expected);
    this.seen = keys;
    this.page = expected;
    this.pageSignatures.set(expected, this.signature);
    this.loaded += added.length;
    this.nextUrl = !ContinuousBrowseClickAdapter.disabled(ContinuousBrowseClickAdapter.nextButton(this.pager));
    return result;
  }

  async turnPage(button, expected, signal) {
    signal.throwIfAborted();
    if (!this.isCurrent() || this.pending || !this.pager.contains(button) || ContinuousBrowseClickAdapter.disabled(button)) {
      throw new Error('原页面已变化，请恢复原分页后重试');
    }
    return new Promise((resolve, reject) => {
      let stable = '';
      let stableSince = 0;
      let timer;
      let timeout;
      let observer;
      let finished = false;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        clearTimeout(timeout);
        observer?.disconnect();
        signal.removeEventListener('abort', abort);
        this.pending = null;
        if (error) { this.invalid = true; reject(error); }
        else resolve(result);
      };
      const abort = () => finish(new DOMException('已停止等待；原站请求可能仍在完成，请恢复分页后重试', 'AbortError'));
      const check = () => {
        if (!this.context()) { finish(new Error('页面状态已变化，连续浏览已停止')); return; }
        if (this.busy() || !this.refresh()) { stable = ''; return; }
        this.hide();
        const page = ContinuousBrowseClickAdapter.currentPage(this.pager);
        if (page !== this.nativePage && page !== expected && page !== null) { finish(new Error('页码跳转异常，请恢复原分页后重试')); return; }
        const signature = this.fingerprint();
        if (page !== expected || signature === this.signature) { stable = ''; return; }
        if (stable !== signature) { stable = signature; stableSince = Date.now(); return; }
        if (Date.now() - stableSince < 500) return;
        const next = ContinuousBrowseClickAdapter.nextButton(this.pager);
        if (this.structure() !== this.schema || !next) { finish(new Error('下一页结构已变化，请恢复原分页后重试')); return; }
        this.signature = signature;
        this.nativePage = expected;
        finish(null);
      };
      this.pending = error => finish(error);
      signal.addEventListener('abort', abort, { once: true });
      observer = new MutationObserver(check);
      observer.observe(this.scope, { childList: true, subtree: true, characterData: true, attributes: true });
      timer = setInterval(check, 100);
      timeout = setTimeout(() => finish(new Error('无法确认下一页加载完成，已保留内容；请恢复原分页后重试')), 12000);
      this.triggering = true;
      try { button.click(); } catch (_) { finish(new Error('原站翻页失败，请恢复原分页后重试')); }
      finally { this.triggering = false; }
    });
  }

  restore() {
    for (const [element, style] of this.hidden) {
      if (style[0]) element.style.setProperty('visibility', style[0], style[1]);
      else element.style.removeProperty('visibility');
    }
    this.hidden.clear();
  }

  destroy() {
    this.destroyed = true;
    this.restore();
    this.pending?.(new DOMException('已停止连续浏览', 'AbortError'));
    if (this.onInteraction) {
      for (const type of ['click', 'input', 'change']) document.removeEventListener(type, this.onInteraction, true);
    }
    if (this.host && this.onCopyClick) this.host.removeEventListener('click', this.onCopyClick);
    this.onCopyClick = null;
    this.host = null;
    this.copyTargets = new WeakMap();
    this.pageSignatures.clear();
  }
}
