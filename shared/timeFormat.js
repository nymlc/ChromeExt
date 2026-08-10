/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-08-06
 * @FilePath: /ChromeExt/shared/timeFormat.js
 * @Description: 时间戳解析 / 格式化纯函数库。
 *   以经典脚本形式注入到 isolated world（浮层版）与 MAIN world（控制台版），
 *   各自挂到所在世界的 window.__geekTime，互不干扰，保证算法唯一来源。
 */
(function () {
  'use strict';

  function pad(x) { return String(x).padStart(2, '0'); }

  function intToMs(s) {
    const n = Number(s);
    if (!isFinite(n)) return null;
    let candidates;
    if (s.length === 10) candidates = [n * 1000, n];   // 秒
    else if (s.length === 13) candidates = [n];        // 毫秒
    else if (s.length === 16) candidates = [n / 1000];  // 微秒
    else candidates = [n / 1e6];                        // 纳秒（19 位）
    for (const ms of candidates) {
      const d = new Date(ms);
      if (!isNaN(d.getTime()) && d.getUTCFullYear() >= 1970 && d.getUTCFullYear() <= 2100) {
        return ms;
      }
    }
    return null;
  }

  function stringToMs(s) {
    const variants = [
      s,
      s.replace(/\//g, '-'),
      s.replace(' ', 'T'),
      s.replace(/\//g, '-').replace(' ', 'T'),
    ];
    for (const v of variants) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        const yr = d.getUTCFullYear();
        if (yr >= 1970 && yr <= 2100) return d.getTime();
      }
    }
    return null;
  }

  /** 解析任意输入为毫秒时间戳；无法识别返回 null */
  function parse(raw) {
    if (raw == null) return null;
    if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw.getTime();
    const s = String(raw).trim().replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
    if (!s) return null;
    // 纯整数时间戳：仅接受规范长度，避免误触普通数字（如手机号）
    if (/^\d{10}$|^\d{13}$|^\d{16}$|^\d{19}$/.test(s)) {
      const ms = intToMs(s);
      if (ms != null) return ms;
    }
    // 日期 / 时间字符串（ISO 或常见分隔格式）
    return stringToMs(s);
  }

  /** 将毫秒时间戳格式化为多视图对象 */
  function format(ms, opts) {
    opts = opts || {};
    const showUTC = opts.showUTC !== false;
    const showRelative = opts.showRelative !== false;
    const d = new Date(ms);

    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const utc = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    const tz = `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? ':' + pad(abs % 60) : ''}`;

    const diff = Date.now() - d.getTime();
    const absd = Math.abs(diff);
    const min = 60000, hr = 3600000, day = 86400000;
    let rel;
    if (absd < min) rel = '刚刚';
    else if (absd < hr) rel = Math.round(absd / min) + ' 分钟';
    else if (absd < day) rel = Math.round(absd / hr) + ' 小时';
    else if (absd < 30 * day) rel = Math.round(absd / day) + ' 天';
    else if (absd < 365 * day) rel = Math.round(absd / (30 * day)) + ' 个月';
    else rel = Math.round(absd / (365 * day)) + ' 年';
    rel = diff >= 0 ? rel + '前' : rel + '后';

    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];

    const result = {
      input: opts.input != null ? opts.input : ms,
      ms,
      local,
      tz,
      weekday,
    };
    if (showUTC) result.utc = utc;
    if (showRelative) result.relative = rel;
    return result;
  }

  /** 便捷封装：直接吃原始输入，返回格式化对象或 null */
  function formatInput(raw, opts) {
    const ms = parse(raw);
    if (ms == null) return null;
    return format(ms, Object.assign({}, opts, { input: raw }));
  }

  window.__geekTime = { parse, format, intToMs, stringToMs, formatInput };
})();
