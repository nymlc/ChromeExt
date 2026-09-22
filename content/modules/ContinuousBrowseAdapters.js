class ContinuousBrowseHtmlAdapter {
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

  static sanitize(node, base) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT'].includes(node.tagName)) {
      return document.createDocumentFragment();
    }
    const allowed = new Set(['A', 'IMG', 'P', 'DIV', 'SPAN', 'ARTICLE', 'SECTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'PRE', 'CODE', 'BLOCKQUOTE', 'STRONG', 'B', 'EM', 'I', 'S', 'DEL', 'SMALL', 'SUP', 'SUB', 'BR', 'HR', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'TIME']);
    if (!allowed.has(node.tagName)) {
      const fragment = document.createDocumentFragment();
      for (const child of node.childNodes) fragment.appendChild(this.sanitize(child, base));
      return fragment;
    }
    const clean = document.createElement(node.localName);
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
    for (const child of node.childNodes) clean.appendChild(this.sanitize(child, base));
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

  destroy() {
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
}
