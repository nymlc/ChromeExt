const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '..');
const instrument = `
const originalInit = PopupManager.prototype.init;
PopupManager.prototype.init = async function (...args) {
  window.popupManager = this;
  window.initStarted = performance.now();
  await originalInit.apply(this, args);
  window.initFinished = performance.now();
};
`;

function setupFixture({ delay, data, tab }) {
  window.fixtureCalls = [];
  window.fixtureData = data;
  const listeners = new Set();
  const wait = () => new Promise(resolve => setTimeout(resolve, delay));
  window.chrome = {
    runtime: { getManifest: () => ({ version: '1.0.76' }), getURL: value => location.origin + '/' + value },
    tabs: {
      async query() {
        fixtureCalls.push({ type: 'tabs' });
        await wait();
        return tab ? [tab] : [];
      },
      async sendMessage(tabId, request) {
        fixtureCalls.push({ type: 'message', tabId, request });
        return { state: 'unsupported', active: false, adapter: '', message: '', loaded: 0, pages: 0, total: null };
      },
    },
    storage: {
      onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
      local: {
        async get(keys) {
          fixtureCalls.push({ type: 'storage', keys });
          await wait();
          return structuredClone(Object.fromEntries(keys.filter(key => key in fixtureData).map(key => [key, fixtureData[key]])));
        },
        async set(values) {
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: fixtureData[key], newValue: value }]));
          Object.assign(fixtureData, structuredClone(values));
          for (const listener of listeners) listener(changes, 'local');
        },
        async remove(key) {
          const changes = { [key]: { oldValue: fixtureData[key] } };
          delete fixtureData[key];
          for (const listener of listeners) listener(changes, 'local');
        },
      },
    },
  };
}

async function main() {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!['popup', 'shared', 'lib', 'icons'].some(dir => file.startsWith(path.join(root, dir) + path.sep))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    async function open({ delay = 0, data = {}, tab = { id: 1, title: '测试页面', url: 'http://localhost:5173/' } } = {}) {
      const context = await browser.newContext({ viewport: { width: 360, height: 500 } });
      await context.addInitScript(setupFixture, { delay, data, tab });
      await context.route('**/popup/popup.js', route => {
        const source = fs.readFileSync(path.join(root, 'popup/popup.js'), 'utf8');
        return route.fulfill({ contentType: 'application/javascript', body: source.replace('// 初始化\ndocument.addEventListener', instrument + '\n// 初始化\ndocument.addEventListener') });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(baseUrl + '/popup/popup.html');
      await page.waitForFunction(() => window.initFinished);
      return page;
    }
    async function enter(page, id) {
      await page.locator(`#${id}ModuleEntry h2`).click();
      await page.waitForFunction(id => popupManager.activeSubpageModule === id, id);
    }
    async function back(page) {
      await page.locator('#subpageBackBtn').click();
      await page.waitForFunction(() => popupManager.activeSubpageModule === null);
    }

    const page = await open({ delay: 100, data: {
      credentialProjects: Array.from({ length: 200 }, (_, i) => ({ id: 'p' + i, name: '测试项目 ' + i, credentials: [] })),
      mastergoNavNodes: [{ id: 'project', name: '测试导航', children: [] }],
    } });
    const startup = await page.evaluate(() => ({
      duration: initFinished - initStarted,
      tabs: fixtureCalls.filter(call => call.type === 'tabs').length,
      storage: fixtureCalls.filter(call => call.type === 'storage').length,
      credentialNodes: document.querySelector('#credentialModuleContent').childElementCount,
      navigationNodes: document.querySelector('#masterGoNavModuleContent').childElementCount,
      libraries: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/lib/')).length,
      defaultEnabled: document.querySelector('#continuousBrowseModuleEnabled').checked,
    }));
    assert.equal(startup.tabs, 1);
    assert.equal(startup.storage, 15);
    assert.ok(startup.duration < 800, `串行等待回归: ${startup.duration} ms`);
    assert.equal(startup.credentialNodes, 0);
    assert.equal(startup.navigationNodes, 0);
    assert.equal(startup.libraries, 0);
    assert.equal(startup.defaultEnabled, false);
    assert.equal(await page.locator('#continuousBrowseSiteEnabled').isChecked(), false);
    console.log('Startup:', startup);

    await enter(page, 'credential');
    assert.equal(await page.locator('.credential-project-card').count(), 200);
    await back(page);
    await page.evaluate(() => chrome.storage.local.set({ credentialProjects: [{ id: 'updated', name: '存储更新项目', credentials: [] }] }));
    await page.waitForFunction(() => popupManager.modules.credential.projects.length === 1);
    assert.equal(await page.locator('.credential-project-card').count(), 200);
    await enter(page, 'credential');
    assert.equal(await page.locator('.credential-project-card').count(), 1);
    assert.ok((await page.locator('#credentialModuleContent').textContent()).includes('存储更新项目'));
    await back(page);
    await enter(page, 'masterGoNav');
    assert.ok((await page.locator('#masterGoNavModuleContent').textContent()).includes('测试导航'));
    await back(page);

    for (const id of ['password', 'timestampFormatter', 'imagePreview', 'continuousBrowse', 'jsonFormatter']) {
      await enter(page, id);
      assert.ok(await page.locator(`#${id}ModuleContent`).isVisible());
      await back(page);
    }
    await page.locator('label:has(#continuousBrowseModuleEnabled)').click();
    assert.equal(await page.evaluate(() => fixtureData.continuousBrowseModuleEnabled), true);
    assert.equal(await page.evaluate(() => fixtureData.enabledContinuousBrowseSites), undefined);
    await enter(page, 'continuousBrowse');
    await page.waitForFunction(() => !popupManager.modules.continuousBrowse.opening);
    assert.equal(await page.locator('#continuousBrowseSiteEnabled').isChecked(), false);
    assert.equal(await page.locator('#continuousBrowseStart').isDisabled(), true);
    assert.equal(await page.evaluate(() => fixtureCalls.filter(call => call.type === 'message').length), 0);
    assert.ok((await page.locator('#continuousBrowseMessage').textContent()).includes('所有网站默认关闭'));
    await page.locator('label:has(#continuousBrowseSiteEnabled)').click();
    await page.waitForFunction(() => !popupManager.modules.continuousBrowse.saving);
    assert.deepEqual(await page.evaluate(() => fixtureData.enabledContinuousBrowseSites), ['localhost']);
    assert.ok(await page.locator('#continuousBrowseSiteEnabled').isChecked());
    await back(page);
    assert.deepEqual(await page.evaluate(() => fixtureData.enabledContinuousBrowseSites), ['localhost']);
    await page.locator('label:has(#continuousBrowseModuleEnabled)').click();
    assert.equal(await page.evaluate(() => fixtureData.continuousBrowseModuleEnabled), false);
    assert.deepEqual(await page.evaluate(() => fixtureData.enabledContinuousBrowseSites), ['localhost']);
    await page.locator('label:has(#continuousBrowseModuleEnabled)').click();
    await page.evaluate(() => chrome.storage.local.set({ enabledContinuousBrowseSites: ['other.example', 'localhost'] }));
    await enter(page, 'continuousBrowse');
    await page.waitForFunction(() => !popupManager.modules.continuousBrowse.opening);
    assert.ok(await page.locator('#continuousBrowseSiteEnabled').isChecked());
    await page.locator('label:has(#continuousBrowseSiteEnabled)').click();
    await page.waitForFunction(() => !popupManager.modules.continuousBrowse.saving);
    assert.deepEqual(await page.evaluate(() => fixtureData.enabledContinuousBrowseSites), ['other.example']);
    await page.locator('label:has(#continuousBrowseSiteEnabled)').click();
    await page.waitForFunction(() => !popupManager.modules.continuousBrowse.saving);
    await page.evaluate(() => chrome.storage.local.remove('enabledContinuousBrowseSites'));
    assert.equal(await page.locator('#continuousBrowseSiteEnabled').isChecked(), false);
    assert.equal(await page.locator('#continuousBrowseStart').isDisabled(), true);
    await back(page);

    for (const disabledContinuousBrowseSites of [undefined, [], ['localhost']]) {
      const legacy = await open({ data: { continuousBrowseModuleEnabled: true, disabledContinuousBrowseSites } });
      assert.equal(await legacy.locator('#continuousBrowseSiteEnabled').isChecked(), false);
      assert.equal(await legacy.evaluate(() => fixtureData.enabledContinuousBrowseSites), undefined);
      await legacy.context().close();
    }
    for (const hostname of ['localhost', 'other.example', 'sub.localhost']) {
      const remembered = await open({
        data: { continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: ['localhost'] },
        tab: { id: 1, title: '网站许可', url: 'https://' + hostname + '/' },
      });
      assert.equal(await remembered.locator('#continuousBrowseSiteEnabled').isChecked(), hostname === 'localhost');
      await remembered.context().close();
    }
    assert.ok(await page.evaluate(() => GEEK_ALL_DATA_KEYS.includes('enabledContinuousBrowseSites')));
    assert.equal(await page.evaluate(() => GEEK_ALL_DATA_KEYS.includes('disabledContinuousBrowseSites')), false);
    await page.evaluate(() => popupManager.doImport({ data: {
      continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: ['localhost'],
    } }, { continuousBrowse: true }));
    assert.ok(await page.locator('#continuousBrowseSiteEnabled').isChecked());
    await page.evaluate(() => popupManager.doImport({ data: {
      continuousBrowseModuleEnabled: true, enabledContinuousBrowseSites: [],
    } }, { continuousBrowse: true }));
    assert.equal(await page.locator('#continuousBrowseSiteEnabled').isChecked(), false);

    await enter(page, 'qrCodeTool');
    let libraryAttempts = 0;
    await page.route('**/lib/qrcode.min.js', route => ++libraryAttempts === 1 ? route.abort() : route.continue());
    await page.locator('#qrcodeGenInput').fill('首次加载失败');
    await page.waitForFunction(() => document.querySelector('#qrcodeGenStatus').textContent.includes('加载失败'));
    await page.locator('#qrcodeGenInput').fill('popup QR regression');
    await page.waitForFunction(() => popupManager.modules.qrCodeTool._lastGenText === 'popup QR regression');
    assert.equal(libraryAttempts, 2);
    const png = await page.locator('#qrcodeGenCanvas').evaluate(canvas => canvas.toDataURL().split(',')[1]);
    await page.locator('#qrcodeDecodeFile').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction(() => document.querySelector('#qrcodeDecodeResult').textContent === 'popup QR regression');
    await page.locator('#qrcodeGenInput').fill('');
    await page.waitForFunction(() => document.querySelector('#qrcodeGenCanvas').style.display === 'none');
    await page.locator('#qrcodeGenInput').fill('cached library');
    await page.waitForFunction(() => popupManager.modules.qrCodeTool._lastGenText === 'cached library');
    assert.equal(libraryAttempts, 2);
    await back(page);

    const racing = await open();
    let release;
    const requested = new Promise(resolve => { release = resolve; });
    let pendingRoute;
    let requests = 0;
    await racing.route('**/lib/qrcode.min.js', route => { requests++; pendingRoute = route; release(); });
    await enter(racing, 'qrCodeTool');
    await racing.locator('#qrcodeGenInput').fill('过期输入');
    await requested;
    await racing.locator('#qrcodeGenInput').fill('');
    await pendingRoute.continue();
    await racing.waitForFunction(() => typeof QRCode !== 'undefined');
    assert.equal(await racing.evaluate(() => popupManager.modules.qrCodeTool._lastGenText), '');
    await racing.locator('#qrcodeGenInput').fill('最新输入');
    await racing.waitForFunction(() => popupManager.modules.qrCodeTool._lastGenText === '最新输入');
    assert.equal(requests, 1);

    const saved = await open({ data: {
      moduleOrder: ['jsonFormatter', 'credential', 'masterGoNav', 'password', 'timestampFormatter', 'imagePreview', 'continuousBrowse', 'qrCodeTool'],
      hiddenModules: ['imagePreview'],
      globalDisabledSites: ['localhost'],
      credentialProjects: [{ id: 'bound', name: '手动绑定项目', credentials: [] }],
      titleProjectBindings: { '测试页面': 'bound' },
      credentialViewMode: 'list', suppressNativeAutofill: false,
      continuousBrowseModuleEnabled: true,
    } });
    assert.equal(await saved.locator('#modulesContainer > .feature-module').first().getAttribute('data-module-id'), 'jsonFormatter');
    assert.equal(await saved.locator('#imagePreviewModuleEntry').isVisible(), false);
    const settings = await saved.evaluate(() => ({
      global: popupManager.globalEnabled,
      project: popupManager.modules.credential.currentProject?.id,
      view: popupManager.modules.credential.currentView,
      mode: popupManager.modules.credential.credentialViewMode,
      suppress: popupManager.modules.credential.suppressNativeAutofill,
      continuous: popupManager.modules.continuousBrowse.moduleEnabled,
    }));
    assert.deepEqual(settings, { global: false, project: 'bound', view: 'detail', mode: 'list', suppress: false, continuous: true });

    for (const tab of [null, { id: 2, title: '新标签页', url: 'chrome://newtab/' }, { id: 3, title: '未知页面', url: 'invalid' }]) {
      const restricted = await open({ tab });
      assert.equal(await restricted.evaluate(() => popupManager.modules.continuousBrowse.pageAvailable), false);
      await restricted.context().close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: 启动性能、延迟渲染、全部模块导航、开关/偏好、二维码按需生成/解码/重试/竞态、受限页面');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
