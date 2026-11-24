// A fast static site generator whose output matches the makefun-site 1.0.0
// reference build byte for byte. run(input) takes one case's input,
// { site, templates, files }, and returns the output tree as an object of
// path -> text. The semantics (front matter, Markdown subset, template
// dialect, slug rule, link resolution, collections, report) follow the
// reference exactly; the machinery is built for speed: single-pass scanners
// instead of per-line regex stacks, bulk HTML escaping instead of a call per
// character, and a per-build slug cache.

// ---------------------------------------------------------------- text rules

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' replaced by their HTML entities. */
function escapeHtml(text) {
  // most pieces hold nothing to escape: a test scan is cheaper than replace
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]) : text;
}

const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD-normalised, combining marks dropped, A-Z lowered,
 * each run of characters outside a-z and 0-9 folded to one "-", no "-" at
 * either end, cut to SLUG_MAX characters (a "-" left at the cut dropped), and
 * "untitled" when nothing is left. Pure-ASCII text is unchanged by NFKD and
 * holds no combining marks, so it takes the direct loop.
 */
function slugify(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The \s class as a lookup table over UTF-16 code units (the whitespace ranges of the class). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s class). */
function isWsCode(code) {
  return WS_TABLE[code] === 1;
}

/** The number of words in `text`: its runs of characters other than whitespace. */
function countWords(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." (only \" and \\ escapes) or bare (never opening on " or [). */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The scan walks line
 * offsets instead of splitting the whole text, so the body is never copied
 * line by line.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  const fmLines = [];
  let body = '';
  let closed = false;
  if (firstNl !== -1) {
    let pos = firstNl + 1;
    for (;;) {
      const nl = text.indexOf('\n', pos);
      const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
      if (line === '---') {
        closed = true;
        body = nl === -1 ? '' : text.slice(nl + 1);
        break;
      }
      fmLines.push(line);
      if (nl === -1) break;
      pos = nl + 1;
    }
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** A fence opening line's language, or null: three backticks, language characters, blanks. */
function fenceOpenLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A fence closing line: three backticks, then blanks only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null: 1-6 "#", blanks, then non-empty text. */
function headingOf(line) {
  let n = 0;
  while (line.charCodeAt(n) === 35) n++;
  if (n < 1 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** A thematic break: "---" or "***", then blanks only. */
function isBreak(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet item line's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered item line's { start, text } after "<digits>. ", or null (1-9 digits). */
function orderedOf(line) {
  let n = 0;
  while (n < line.length) {
    const c = line.charCodeAt(n);
    if (c < 48 || c > 57) break;
    n++;
  }
  if (n < 1 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** A list continuation line: two or more spaces, then a non-whitespace character. */
function isContinuation(line) {
  let n = 0;
  while (line.charCodeAt(n) === 32) n++;
  return n >= 2 && n < line.length && !isWsCode(line.charCodeAt(n));
}

/** Whether `line` ends a paragraph: blank, a fence opening, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpenLang(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** The characters a backslash escapes, by code unit: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE_CODE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_CODE[ch.charCodeAt(0)] = 1;

function isEscapable(code) {
  return code < 128 && ESCAPABLE_CODE[code] === 1;
}

/**
 * Shared scan patterns for the inline renderer's searches. Each use assigns
 * lastIndex before exec, so the recursion in renderInline (which re-enters
 * these scans) cannot disturb an outer scan: an outer scan always re-seeks
 * from its own position.
 */
const SCAN_STRONG = /\\|\*/g;
const SCAN_BRACKET = /\\|\]/g;
const SCAN_SPECIAL = /[\\`*\[]/g;

/**
 * The first unescaped "**" from `from`, or -1: the scan walks the only
 * characters that matter (a backslash, which may escape what follows, and a
 * star) instead of every character.
 */
function findStrongClose(s, from) {
  const n = s.length;
  SCAN_STRONG.lastIndex = from;
  let m;
  while ((m = SCAN_STRONG.exec(s)) !== null) {
    if (m[0] === '\\') {
      if (m.index + 1 < n && isEscapable(s.charCodeAt(m.index + 1))) SCAN_STRONG.lastIndex = m.index + 2;
    } else if (s.charCodeAt(m.index + 1) === 42) return m.index;
  }
  return -1;
}

/** The first unescaped "]" from `from`, or -1 (the same hopping scan). */
function findBracketClose(s, from) {
  const n = s.length;
  SCAN_BRACKET.lastIndex = from;
  let m;
  while ((m = SCAN_BRACKET.exec(s)) !== null) {
    if (m[0] === '\\') {
      if (m.index + 1 < n && isEscapable(s.charCodeAt(m.index + 1))) SCAN_BRACKET.lastIndex = m.index + 2;
    } else return m.index;
  }
  return -1;
}

/** The first single "*" from `from` (one not part of a "**"), unescaped, or -1. */
function findEmClose(s, from) {
  const n = s.length;
  SCAN_STRONG.lastIndex = from;
  let m;
  while ((m = SCAN_STRONG.exec(s)) !== null) {
    if (m[0] === '\\') {
      if (m.index + 1 < n && isEscapable(s.charCodeAt(m.index + 1))) SCAN_STRONG.lastIndex = m.index + 2;
    } else if (s.charCodeAt(m.index + 1) === 42) {
      SCAN_STRONG.lastIndex = m.index + 2; // a "**" pair is skipped whole
    } else return m.index;
  }
  return -1;
}

/** Whether `s` holds any whitespace character. */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

/**
 * `s` rendered inline. Plain runs between the special characters (\ ` * [)
 * are escaped in one pass; code spans, strong, emphasis and links follow the
 * reference's left-to-right rules exactly.
 */
function renderInline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        out += escapeHtml(s[i + 1]);
        i += 2;
      } else {
        out += '\\';
        i += 1;
      }
      continue;
    }
    if (c === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else {
        out += '`';
        i += 1;
      }
      continue;
    }
    if (c === 42) { // *
      if (s.charCodeAt(i + 1) === 42) {
        const j = findStrongClose(s, i + 2);
        if (j > i + 2) {
          out += '<strong>' + renderInline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j = findEmClose(s, i + 1);
        if (j > i + 1) {
          out += '<em>' + renderInline(s.slice(i + 1, j), link) + '</em>';
          i = j + 1;
        } else {
          out += '*';
          i += 1;
        }
      }
      continue;
    }
    if (c === 91) { // [
      const k = findBracketClose(s, i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWhitespace(target)) {
        out += '<a href="' + escapeHtml(link(target)) + '">' + renderInline(s.slice(i + 1, k), link) + '</a>';
        i = m + 1;
      } else {
        out += '[';
        i += 1;
      }
      continue;
    }
    // a plain run, up to the next special character (\ ` * [): one
    // shared-pattern scan finds its end in native code
    SCAN_SPECIAL.lastIndex = i;
    const m = SCAN_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    out += escapeHtml(s.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * `src` rendered in one pass over its lines: { html, toc, excerpt } — the
 * HTML (each block followed by "\n"), the level 2 and 3 headings ({ level,
 * id, html }) and the first paragraph's inline HTML (or "").
 */
function renderMarkdown(src, link, slugOf) {
  const lines = src.split('\n');
  const n = lines.length;
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let haveExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceOpenLang(line);
    if (lang !== null) {
      let body = '';
      i++;
      while (i < n && !isFenceClose(lines[i])) { body += escapeHtml(lines[i]) + '\n'; i++; }
      i++;
      parts.push('<pre><code' + (lang === '' ? '' : ` class="language-${lang}"`) + '>' + body + '</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugOf(heading.text), ids);
      const html = renderInline(heading.text, link);
      parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) { parts.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // >
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') kept.push(l);
        i++;
      }
      parts.push(kept.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${renderInline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let cur = null;
      while (i < n) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          cur = [trimLine(m.text)];
          items.push(cur);
          i++;
        } else if (cur !== null && isContinuation(lines[i])) {
          cur.push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let block = open + '\n';
      for (const item of items) block += `<li>${renderInline(item.join('\n'), link)}</li>\n`;
      parts.push(block + `</${tag}>\n`);
      continue;
    }
    const plines = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) { plines.push(trimLine(lines[i])); i++; }
    const html = renderInline(plines.join('\n'), link);
    if (!haveExcerpt) { excerpt = html; haveExcerpt = true; }
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why, as one message. */
class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a..b] is nothing but spaces and tabs. */
function isBlankSpan(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, var, raw and tag; a standalone {% %} tag's line is taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = isBlankSpan(src, lineStart, open) && isBlankSpan(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not
 * parse). Node kinds are small integers (0 text, 1 var, 2 raw, 3 if, 4 for,
 * 5 include) so the renderer's dispatch is a numeric switch; `skind` keeps
 * the word the parse stack and its error messages use.
 */
function parseTemplate(name, src) {
  const root = { skind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 0, text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t === 'var' ? 1 : 2, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = { kind: 4, skind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = { kind: 3, skind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.skind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.skind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.skind === 'root' ? parent.body : parent.skind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
      body.push({ kind: 5, name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].skind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  if (path.length === 1) return v;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array joined by ", ", else "". */
function textOfValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOfValue).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into the `out` array of string pieces, in `scope`, with `ctx.templates` for includes. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case 0: // text
        out.push(nd.text);
        break;
      case 1: // var
        out.push(escapeHtml(textOfValue(lookupPath(scope, nd.path))));
        break;
      case 2: // raw
        out.push(textOfValue(lookupPath(scope, nd.path)));
        break;
      case 3: { // if
        const v = isTruthy(lookupPath(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: { // for
        const xs = lookupPath(scope, nd.path);
        if (Array.isArray(xs)) {
          for (let k = 0; k < xs.length; k++) {
            const vars = {
              [nd.name]: xs[k],
              loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
            };
            renderNodes(nd.body, { vars, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case 5: { // include
        const t = ctx.templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no root page slug may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` resolved from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One case's output tree: path -> text. */
function build(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // slug results repeat across titles, headings and tag names: cache them per build
  const slugCache = new Map();
  const slugOf = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugify(text);
      slugCache.set(text, v);
    }
    return v;
  };

  // sources in code-unit order of path; .md files are sources, the rest static
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // line ends normalised; the rewrite is skipped when no \r occurs
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    }
    else statics.push({ path: f.path, content: f.content });
  }

  // front matter: refused sources and drafts are reported and dropped, checks in order
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) { report.push(`refused ${s.path}: tags/ is the generator's own`); continue; }
    if (s.path.startsWith('page/')) { report.push(`refused ${s.path}: page/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // permalinks: each page's slug, unique in its directory, in source order
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, with each source's links resolved against the built pages and static files
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const sourcePath = s.path;
    // a source's links repeat (navigation, footers): resolve each target once
    const linkCache = new Map();
    const link = (target) => {
      const hit = linkCache.get(target);
      if (hit !== undefined) return hit;
      let result;
      if (LINK_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) {
        result = target;
      } else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && bySource.has(path)) result = bySource.get(path).url + frag;
        else if (path !== null && staticPaths.has(path)) result = `${base}/${path}${frag}`;
        else {
          broken.add(`broken-link ${sourcePath} -> ${target}`);
          result = target;
        }
      }
      linkCache.set(target, result);
      return result;
    };
    const md = renderMarkdown(s.body, link, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // the posts, newest date first, equal dates by slug; each post's newer and older
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // tags: grouped by slug, named as first met in the posts' order, ordered by count then slug
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugOf(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards, computed once per source
  for (const s of kept) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // layouts: every page, the index pages, the tag pages, then the static files
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const ctx = { templates };
  // the root scope is shared by every render of this build; each render's own
  // values sit in a child scope in front of it (their keys — page, posts,
  // pager, tag — never collide with site, tags or recent, so lookups resolve
  // exactly as they would in one merged scope)
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // the report: every reported line sorted in code-unit order, then the counts
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}

/** makefun-site's answer for one case's input, built faster. */
export function run(input) {
  return build(input);
}
