/*
 * 凭证标签工具 - note 为兼容字段名，语义是多值标签数组。
 */
(function (global) {
  const keyOf = (value) => String(value).trim().toLocaleLowerCase();

  function normalizeTags(value) {
    const source = Array.isArray(value) ? value : (value == null ? [] : [value]);
    const seen = new Set();
    return source.reduce((tags, item) => {
      const tag = String(item == null ? '' : item).trim();
      const key = keyOf(tag);
      if (!tag || seen.has(key)) return tags;
      seen.add(key);
      tags.push(tag);
      return tags;
    }, []);
  }

  function tagsEqual(a, b) {
    const left = normalizeTags(a).map(keyOf).sort();
    const right = normalizeTags(b).map(keyOf).sort();
    return left.length === right.length && left.every((tag, index) => tag === right[index]);
  }

  function hasTag(tags, tag) {
    const key = keyOf(tag);
    return normalizeTags(tags).some(item => keyOf(item) === key);
  }

  global.CredentialTagUtils = { normalizeTags, tagsEqual, hasTag, keyOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
