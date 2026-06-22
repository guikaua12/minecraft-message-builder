/* =============================================================================
 * spigot-boot Message Builder — functional engine + WYSIWYG editor
 *
 * Output target: the markup string consumed by spigot-boot's ChatMarkup parser
 *   - &a / §a legacy colours, #rrggbb hex (version-gated)
 *   - [click=run:/cmd]…[/click], [hover=<markup>]…[/hover]
 *   - \ escapes, %key% placeholders (opaque)
 * All semantics mirror chat-markup-frontend-spec.md (the parser source of truth).
 * ========================================================================== */
'use strict';

/* ----------------------------------------------------------------------------
 * 1. Constants (spec §4.1 — exact RGB so the ≤1.15 downsample matches the server)
 * ------------------------------------------------------------------------- */
const LEGACY = [
  { code: '0', name: 'Black',        rgb: [0, 0, 0] },
  { code: '1', name: 'Dark Blue',    rgb: [0, 0, 170] },
  { code: '2', name: 'Dark Green',   rgb: [0, 170, 0] },
  { code: '3', name: 'Dark Aqua',    rgb: [0, 170, 170] },
  { code: '4', name: 'Dark Red',     rgb: [170, 0, 0] },
  { code: '5', name: 'Dark Purple',  rgb: [170, 0, 170] },
  { code: '6', name: 'Gold',         rgb: [255, 170, 0] },
  { code: '7', name: 'Gray',         rgb: [170, 170, 170] },
  { code: '8', name: 'Dark Gray',    rgb: [85, 85, 85] },
  { code: '9', name: 'Blue',         rgb: [85, 85, 255] },
  { code: 'a', name: 'Green',        rgb: [85, 255, 85] },
  { code: 'b', name: 'Aqua',         rgb: [85, 255, 255] },
  { code: 'c', name: 'Red',          rgb: [255, 85, 85] },
  { code: 'd', name: 'Light Purple', rgb: [255, 85, 255] },
  { code: 'e', name: 'Yellow',       rgb: [255, 255, 85] },
  { code: 'f', name: 'White',        rgb: [255, 255, 255] },
];
const LEGACY_BY_CODE = Object.fromEntries(LEGACY.map(c => [c.code, c]));
const COLOR_CODES = '0123456789abcdef';
const ALL_CODES   = '0123456789abcdefklmnor';
const STYLE_CODE  = { l: 'bold', o: 'italic', n: 'underline', m: 'strikethrough', k: 'obfuscated' };
const STYLE_ORDER = [['bold', 'l'], ['italic', 'o'], ['underline', 'n'], ['strikethrough', 'm'], ['obfuscated', 'k']];
const ACTION_ICON = { run: '⚡', suggest: '💭', url: '🔗', hover: '💬' };

const isColorCode = c => COLOR_CODES.indexOf(c) !== -1;
const isAnyCode   = c => ALL_CODES.indexOf(c) !== -1;

function hexToRgb(h) { return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function nearestLegacy([r, g, b]) {
  let best = LEGACY[0], bestD = Infinity;
  for (const c of LEGACY) {
    const [Lr, Lg, Lb] = c.rgb;
    const d = (r - Lr) ** 2 + (g - Lg) ** 2 + (b - Lb) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/* ----------------------------------------------------------------------------
 * 2. Run model helpers
 *   run = { text, color, bold, italic, underline, strikethrough, obfuscated,
 *           click:{kind,value}|null, hover:<markup string>|null }
 *   color = null | {type:'legacy',code} | {type:'hex',value:'rrggbb'}
 * ------------------------------------------------------------------------- */
function blankAttrs() {
  return { color: null, bold: false, italic: false, underline: false, strikethrough: false, obfuscated: false, click: null, hover: null };
}
function mkRun(text, attrs) {
  // `text` is applied LAST so an `attrs` object that itself carries a `text`
  // property (e.g. an existing run passed in by splitAt/applyGradient) cannot
  // clobber the slice we actually want.
  return Object.assign({}, blankAttrs(), attrs || {}, { text });
}
function colorEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === 'legacy' ? a.code === b.code : a.value === b.value;
}
function clickEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.value === b.value;
}
function attrsEq(a, b) {
  return colorEq(a.color, b.color) && a.bold === b.bold && a.italic === b.italic &&
    a.underline === b.underline && a.strikethrough === b.strikethrough && a.obfuscated === b.obfuscated &&
    clickEq(a.click, b.click) && (a.hover || null) === (b.hover || null);
}
function cloneColor(c) { return c ? Object.assign({}, c) : null; }

/* ----------------------------------------------------------------------------
 * 3. Serializer — model → ChatMarkup string (spec §7.2)
 * ------------------------------------------------------------------------- */
function escapeRunText(s) {
  // Escape chars that would otherwise tokenize. % is left literal (placeholder passthrough).
  // ] is harmless in plain text (only dangerous inside tag bodies, handled separately).
  return s.replace(/[\\&§#[]/g, m => '\\' + m);
}

function serializeRuns(runs) {
  let out = '';
  const state = { color: null, bold: false, italic: false, underline: false, strikethrough: false, obfuscated: false };
  let openClick = null, openHover = null;

  for (const run of runs) {
    if (run.text === '') continue; // empty runs carry no output

    /* 1. hover/click open-close (LIFO: open hover then click; close click then hover) */
    if (!clickEq(openClick, run.click) && openClick) { out += '[/click]'; openClick = null; }
    if ((run.hover || null) !== (openHover || null)) {
      if (openHover) { out += '[/hover]'; openHover = null; }
      if (run.hover) { out += '[hover=' + run.hover + ']'; openHover = run.hover; }
    }
    if (!clickEq(openClick, run.click) && run.click) {
      out += '[click=' + run.click.kind + ':' + run.click.value + ']';
      openClick = run.click;
    }

    /* 2. colour + styles. A colour / #hex / &r token resets ALL styles, and there is no
       token that turns a single style OFF. So emit a clearing token whenever the colour
       changes OR any active style must be turned off, then (re)assert the needed styles. */
    const colorChanged = !colorEq(run.color, state.color);
    const styleNeedsOff = (state.bold && !run.bold) || (state.italic && !run.italic) ||
      (state.underline && !run.underline) || (state.strikethrough && !run.strikethrough) || (state.obfuscated && !run.obfuscated);
    if (colorChanged || styleNeedsOff) {
      if (!run.color) { out += '&r'; state.color = null; }
      else { out += run.color.type === 'hex' ? ('#' + run.color.value) : ('&' + run.color.code); state.color = run.color; }
      state.bold = state.italic = state.underline = state.strikethrough = state.obfuscated = false;
    }
    for (const [flag, code] of STYLE_ORDER) if (run[flag] && !state[flag]) { out += '&' + code; state[flag] = true; }
    state.bold = run.bold; state.italic = run.italic; state.underline = run.underline;
    state.strikethrough = run.strikethrough; state.obfuscated = run.obfuscated;

    /* 3. escaped text */
    out += escapeRunText(run.text);
  }

  if (openClick) out += '[/click]';
  if (openHover) out += '[/hover]';

  /* trailing-hex guard (spec §3.3): a real #rrggbb at end-of-string would be emitted literally */
  if (/(^|[^\\])#[0-9a-fA-F]{6}$/.test(out)) out += ' ';
  return out;
}

/* ----------------------------------------------------------------------------
 * 4. Parser — mirror ChatMarkup.parse exactly (spec §3, §6)  string → runs
 * ------------------------------------------------------------------------- */
function parseMarkup(str) {
  const runs = [];
  let buf = '';
  let color = null, bold = false, italic = false, underline = false, strike = false, obf = false;
  const clicks = [], hovers = [];
  const n = str.length;
  let i = 0;

  function flush() {
    if (buf.length === 0) return;
    runs.push({
      text: buf, color: cloneColor(color), bold, italic, underline, strikethrough: strike, obfuscated: obf,
      click: clicks.length ? clicks[clicks.length - 1] : null,
      hover: hovers.length ? hovers[hovers.length - 1] : null,
    });
    buf = '';
  }

  while (i < n) {
    const ch = str[i];

    if (ch === '\\') { if (i + 1 < n) { buf += str[i + 1]; i += 2; } else { i += 1; } continue; }

    if (ch === '&' || ch === '§') {
      const c = i + 1 < n ? str[i + 1].toLowerCase() : '';
      if (c && isAnyCode(c)) {
        flush();
        if (isColorCode(c)) { color = { type: 'legacy', code: c }; bold = italic = underline = strike = obf = false; }
        else if (c === 'r') { color = null; bold = italic = underline = strike = obf = false; }
        else if (c === 'l') bold = true;
        else if (c === 'o') italic = true;
        else if (c === 'n') underline = true;
        else if (c === 'm') strike = true;
        else if (c === 'k') obf = true;
        i += 2; continue;
      }
      buf += ch; i += 1; continue;
    }

    if (ch === '#') {
      if (i + 6 < n) {                       // guard requires a char after the 6 digits
        const hex = str.substr(i + 1, 6);
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          flush();
          color = { type: 'hex', value: hex.toLowerCase() };
          bold = italic = underline = strike = obf = false;
          i += 7; continue;
        }
      }
      buf += '#'; i += 1; continue;
    }

    if (ch === '[') {
      const j = str.indexOf(']', i);
      if (j !== -1) {
        const content = str.substring(i + 1, j);
        if (content.startsWith('click=')) {
          flush();
          const body = content.substring(6);
          const ci = body.indexOf(':');
          const kindRaw = ci === -1 ? body : body.substring(0, ci);
          const value = ci === -1 ? '' : body.substring(ci + 1);
          const k = kindRaw.toLowerCase();
          const kind = k === 'run' ? 'run' : k === 'suggest' ? 'suggest' : 'url'; // else → OPEN_URL
          clicks.push({ kind, value });
          i = j + 1; continue;
        }
        if (content.startsWith('hover=')) { flush(); hovers.push(content.substring(6)); i = j + 1; continue; }
        if (content === '/click') { flush(); if (clicks.length) clicks.pop(); i = j + 1; continue; }
        if (content === '/hover') { flush(); if (hovers.length) hovers.pop(); i = j + 1; continue; }
      }
      buf += '['; i += 1; continue;          // not a tag → literal '[', re-tokenize the rest
    }

    buf += ch; i += 1;
  }

  flush();
  if (runs.length === 0) runs.push(mkRun('', {}));
  return runs;
}

/* ----------------------------------------------------------------------------
 * 5. Validation (spec §10)
 * ------------------------------------------------------------------------- */
function validateRuns(runs) {
  const msgs = [];
  const seen = new Set();
  const add = (level, msg) => { const k = level + msg; if (!seen.has(k)) { seen.add(k); msgs.push({ level, msg }); } };

  for (const run of runs) {
    if (run.color && run.color.type === 'hex' && !/^[0-9a-fA-F]{6}$/.test(run.color.value)) {
      add('error', 'Hex colour "#' + run.color.value + '" is not 6 hex digits.');
    }
    if (run.click) {
      const { kind, value } = run.click;
      if (value.includes(']')) add('error', 'Click value contains "]" — there is no escape for it; it will truncate the tag.');
      if (kind === 'url') {
        if (!/^https?:\/\//i.test(value)) add('error', 'URL "' + value + '" must start with http:// or https://.');
      } else {
        if (value.trim() === '') add('warn', (kind === 'run' ? 'Run' : 'Suggest') + ' command is empty.');
        else if (!value.startsWith('/')) add('warn', (kind === 'run' ? 'Run' : 'Suggest') + ' command "' + value + '" usually starts with "/".');
      }
    }
    if (run.hover && run.hover.includes(']')) {
      add('error', 'Hover tooltip contains "]" — there is no escape for it; it will truncate the tag.');
    }
  }
  return msgs;
}

/* ============================================================================
 * 6. EDITOR  (model-driven contenteditable; beforeinput-controlled)
 * ========================================================================== */
// Reusable editor contexts. All editor functions operate on the *active* context E;
// each input handler / toolbar command sets E to its instance first, so the same engine
// drives both the main message editor and the hover-tooltip mini-editor.
let currentColor = { type: 'legacy', code: 'a' };  // colour the picker will apply (default Green)
const COALESCE = new Set(['type', 'delete']);      // edits with these tags coalesce into one undo step
const HISTORY_LIMIT = 300;

const $ = id => document.getElementById(id);
const chatPreview = $('chat-preview');

const EDITORS = [];           // all live editor contexts (for selection routing)
let E = null;                 // the active editor context
let MAIN = null;              // the main message editor (set in init)
let HOVER = null;             // the hover-tooltip mini-editor (set in init)

let rawMode = false;          // main editor showing the raw markup textarea instead of the WYSIWYG view
let rawEl = null;             // the raw-markup <textarea> (set in init)
let editorWrap = null, toolbarEl = null;   // cached containers toggled with raw mode (set in init)

function makeCtx(el, opts) {
  const cx = {
    el,
    doc: [], sel: { start: 0, end: 0 }, pending: null, lines: [],
    undoStack: [], redoStack: [], coalesceTag: null,
    commit: opts.commit || (() => {}),     // run after a mutation (refresh outputs / preview)
    reflect: opts.reflect || (() => {}),   // reflect active formatting on this editor's toolbar
    onSel: opts.onSel || (() => {}),       // extra work on selection change (e.g. status bar)
  };
  el.addEventListener('beforeinput', e => { E = cx; handleBeforeInput(e); });
  el.addEventListener('keydown', e => { E = cx; handleKeydown(e); });
  EDITORS.push(cx);
  return cx;
}

function docText() { return E.doc.map(r => r.text).join(''); }
function docLen() { return E.doc.reduce((a, r) => a + r.text.length, 0); }
function ordered() { return [Math.min(E.sel.start, E.sel.end), Math.max(E.sel.start, E.sel.end)]; }

/* ---- model mutation primitives (work on character offsets) ---- */
function findRunAt(offset) {           // returns {idx, local} for the run containing char `offset`
  let acc = 0;
  for (let k = 0; k < E.doc.length; k++) {
    const len = E.doc[k].text.length;
    if (offset < acc + len) return { idx: k, local: offset - acc };
    acc += len;
  }
  return { idx: E.doc.length, local: 0 };
}
function splitAt(offset) {              // ensure a run boundary at `offset`; returns index of run starting there
  if (offset <= 0) return 0;
  let acc = 0;
  for (let k = 0; k < E.doc.length; k++) {
    const len = E.doc[k].text.length;
    if (offset === acc) return k;
    if (offset < acc + len) {
      const r = E.doc[k];
      const left = mkRun(r.text.slice(0, offset - acc), r);
      const right = mkRun(r.text.slice(offset - acc), r);
      E.doc.splice(k, 1, left, right);
      return k + 1;
    }
    acc += len;
  }
  return E.doc.length;
}
function normalize() {
  const out = [];
  for (const r of E.doc) {
    if (r.text === '') continue;
    const last = out[out.length - 1];
    if (last && attrsEq(last, r)) last.text += r.text;
    else out.push(r);
  }
  E.doc = out.length ? out : [mkRun('', {})];
}
function insertIntoDoc(offset, text, attrs) {
  const at = splitAt(offset);
  E.doc.splice(at, 0, mkRun(text, attrs));
}
function deleteFromDoc(start, end) {
  if (start >= end) return;
  const a = splitAt(start);
  const b = splitAt(end);
  E.doc.splice(a, b - a);
}
function applyAttrRange(start, end, mutator) {
  if (start >= end) return;
  const a = splitAt(start);
  const b = splitAt(end);
  for (let k = a; k < b; k++) mutator(E.doc[k]);
}
function runsInRange(start, end) {
  const a = splitAt(start), b = splitAt(end);
  return E.doc.slice(a, b);
}

/* ---- attrs of the caret (char before caret, else char after) ---- */
function caretAttrs(off) {
  const probe = off > 0 ? off - 1 : off;
  const { idx } = findRunAt(probe);
  const r = E.doc[idx] || E.doc[E.doc.length - 1];
  if (!r) return blankAttrs();
  return {
    color: cloneColor(r.color), bold: r.bold, italic: r.italic, underline: r.underline,
    strikethrough: r.strikethrough, obfuscated: r.obfuscated,
    click: r.click ? Object.assign({}, r.click) : null, hover: r.hover || null,
  };
}
function attrsOfCharAt(i) {
  const { idx } = findRunAt(i);
  const r = E.doc[idx];
  if (!r) return blankAttrs();
  return {
    color: cloneColor(r.color), bold: r.bold, italic: r.italic, underline: r.underline,
    strikethrough: r.strikethrough, obfuscated: r.obfuscated, click: null, hover: null, // typed text never extends an action
  };
}
function typingAttrs() {
  if (E.pending) {
    const p = E.pending;
    return {
      color: cloneColor(p.color), bold: p.bold, italic: p.italic, underline: p.underline,
      strikethrough: p.strikethrough, obfuscated: p.obfuscated, click: null, hover: null,
    };
  }
  const [s] = ordered();
  const text = docText();
  // Inherit formatting from the preceding character, but NEVER across a line break — so a
  // new line below a coloured line starts with default formatting. Fall back to the
  // following character on the same line, else default.
  if (s > 0 && text[s - 1] !== '\n') return attrsOfCharAt(s - 1);
  if (s < text.length && text[s] !== '\n') return attrsOfCharAt(s);
  return blankAttrs();
}

/* ---- finalize a mutation: normalize, render, restore caret, refresh outputs ---- */
function finalize(caretOffset, caretEnd) {
  normalize();
  renderEditor();
  setSelection(caretOffset, caretEnd === undefined ? caretOffset : caretEnd);
  E.commit();
  E.reflect(computeActiveAttrs());
}

/* ---- undo / redo ---- */
function cloneDoc(d) {
  return d.map(r => ({
    text: r.text, color: r.color ? Object.assign({}, r.color) : null,
    bold: r.bold, italic: r.italic, underline: r.underline, strikethrough: r.strikethrough, obfuscated: r.obfuscated,
    click: r.click ? Object.assign({}, r.click) : null, hover: r.hover || null,
  }));
}
function snapshot() { return { doc: cloneDoc(E.doc), start: E.sel.start, end: E.sel.end }; }
function restoreSnapshot(snap) {
  E.doc = cloneDoc(snap.doc);
  renderEditor();
  setSelection(snap.start, snap.end);
  E.commit();
  E.reflect(computeActiveAttrs());
}
// Call BEFORE applying a mutation. Captures the pre-edit state for undo. Consecutive
// edits sharing a coalescable tag ('type'/'delete') collapse into a single undo step.
function beginEdit(tag) {
  if (tag && COALESCE.has(tag) && tag === E.coalesceTag) return;
  E.undoStack.push(snapshot());
  if (E.undoStack.length > HISTORY_LIMIT) E.undoStack.shift();
  E.redoStack.length = 0;
  E.coalesceTag = tag || null;
}
function resetHistory() { E.undoStack.length = 0; E.redoStack.length = 0; E.coalesceTag = null; }
function undo() {
  if (!E.undoStack.length) return;
  E.redoStack.push(snapshot());
  restoreSnapshot(E.undoStack.pop());
  E.coalesceTag = null;
  E.el.focus();
}
function redo() {
  if (!E.redoStack.length) return;
  E.undoStack.push(snapshot());
  restoreSnapshot(E.redoStack.pop());
  E.coalesceTag = null;
  E.el.focus();
}

/* ---- render doc → editor DOM, building the caret index ---- */
function makeEditorSpan(run, txt) {
  const span = document.createElement('span');
  span.className = 'ed-seg';
  styleSpan(span, run, true);   // editor always shows true colours
  span.appendChild(document.createTextNode(txt));
  const kind = run.click ? run.click.kind : (run.hover ? 'hover' : null);
  if (kind) {
    span.classList.add('act-' + kind);
    const parts = [];
    if (run.click) parts.push(ACTION_ICON[run.click.kind] + ' ' + run.click.value);
    if (run.hover) parts.push('💬');
    span.dataset.badge = parts.join('  ');
  }
  return span;
}
function renderEditor() {
  E.el.innerHTML = '';
  E.lines = [];
  if (docLen() === 0) { return; }     // empty → CSS :empty placeholder shows

  let off = 0;
  let cur = { start: 0, len: 0, div: null, segs: [] };
  function openLine() {
    const div = document.createElement('div');
    div.className = 'ed-line';
    E.el.appendChild(div);
    cur = { start: off, len: 0, div, segs: [] };
    E.lines.push(cur);
  }
  openLine();

  for (const run of E.doc) {
    const parts = run.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        if (cur.len === 0) cur.div.appendChild(document.createElement('br'));
        off += 1;                       // the '\n' occupies one offset
        openLine();
      }
      const txt = parts[p];
      if (txt.length === 0) continue;
      const span = makeEditorSpan(run, txt);
      cur.div.appendChild(span);
      cur.segs.push({ start: off, end: off + txt.length, node: span.firstChild });
      cur.len += txt.length;
      off += txt.length;
    }
  }
  for (const ln of E.lines) if (ln.len === 0 && !ln.div.firstChild) ln.div.appendChild(document.createElement('br'));
}

/* ---- caret offset ⇄ DOM position ---- */
function offsetToDom(offset) {
  if (docLen() === 0) return { node: E.el, offset: 0 };
  offset = Math.max(0, Math.min(offset, docLen()));
  for (const ln of E.lines) {
    if (offset <= ln.start + ln.len) {
      if (ln.len === 0) return { node: ln.div, offset: 0 };
      for (const seg of ln.segs) if (offset <= seg.end) return { node: seg.node, offset: offset - seg.start };
      const last = ln.segs[ln.segs.length - 1];
      return { node: last.node, offset: last.node.length };
    }
  }
  const last = E.lines[E.lines.length - 1];
  if (last.len === 0) return { node: last.div, offset: 0 };
  const seg = last.segs[last.segs.length - 1];
  return { node: seg.node, offset: seg.node.length };
}
function domToOffset(node, nodeOffset) {
  if (docLen() === 0) return 0;
  // editor element: nodeOffset indexes its child line-divs. An index at/past the last
  // child (as Ctrl+A's end produces) maps to the very end of the document.
  if (node === E.el) {
    return nodeOffset < E.lines.length ? E.lines[nodeOffset].start : docLen();
  }
  // a text node inside a seg
  for (const ln of E.lines) {
    for (const seg of ln.segs) if (seg.node === node) return seg.start + Math.min(nodeOffset, seg.node.length);
  }
  // a line div: nodeOffset indexes its child spans (or a lone <br> for empty lines)
  for (const ln of E.lines) {
    if (ln.div === node) {
      if (nodeOffset >= ln.segs.length) return ln.start + ln.len; // at/after last span → end of line
      return ln.segs[nodeOffset].start;
    }
  }
  // a seg span element: offset 0 = before its text, >0 = after it
  for (const ln of E.lines) {
    for (const seg of ln.segs) {
      if (seg.node.parentNode === node) return nodeOffset > 0 ? seg.end : seg.start;
    }
    if (ln.div.contains(node)) return ln.start + ln.len;
  }
  return docLen();
}
function setSelection(start, end) {
  const a = offsetToDom(start), b = offsetToDom(end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(range);
  E.sel.start = start; E.sel.end = end;
}
function syncSelFromDom() {
  const s = window.getSelection();
  if (!s.rangeCount) return;
  const r = s.getRangeAt(0);
  if (!E.el.contains(r.startContainer)) return;
  E.sel.start = domToOffset(r.startContainer, r.startOffset);
  E.sel.end = domToOffset(r.endContainer, r.endOffset);
}

/* ---- shared inline styling (used by editor and preview) ---- */
function colorRgb(color, native) {
  if (!color) return [255, 255, 255];
  if (color.type === 'legacy') return (LEGACY_BY_CODE[color.code] || LEGACY_BY_CODE.f).rgb;
  const rgb = hexToRgb(color.value);
  return native ? rgb : nearestLegacy(rgb).rgb;
}
function styleSpan(span, run, native) {
  const [r, g, b] = colorRgb(run.color, native);
  span.style.color = `rgb(${r},${g},${b})`;
  if (run.bold) span.style.fontWeight = '700';
  if (run.italic) span.style.fontStyle = 'italic';
  const deco = [];
  if (run.underline) deco.push('underline');
  if (run.strikethrough) deco.push('line-through');
  if (deco.length) span.style.textDecoration = deco.join(' ');
}

/* ============================================================================
 * 7. Preview rendering (round-trip: model → serialize → parse → render)
 * ========================================================================== */
const OBF_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789?#@%&!';
function scramble(s) {
  let o = '';
  for (const ch of s) o += ch === ' ' ? ' ' : OBF_CHARS[Math.floor(Math.random() * OBF_CHARS.length)];
  return o;
}
setInterval(() => { document.querySelectorAll('.mc-obf').forEach(el => { el.textContent = scramble(el.dataset.obf || ''); }); }, 80);

function makePreviewSeg(run, txt, native) {
  const span = document.createElement('span');
  span.className = 'mc-seg';
  const [r, g, b] = colorRgb(run.color, native);
  span.style.color = `rgb(${r},${g},${b})`;
  span.style.textShadow = `2px 2px 0 rgb(${Math.round(r * 0.25)},${Math.round(g * 0.25)},${Math.round(b * 0.25)})`;
  if (run.bold) span.style.fontWeight = '700';
  if (run.italic) span.style.fontStyle = 'italic';
  const deco = [];
  if (run.underline) deco.push('underline');
  if (run.strikethrough) deco.push('line-through');
  if (deco.length) span.style.textDecoration = deco.join(' ');
  if (run.obfuscated) { span.classList.add('mc-obf'); span.dataset.obf = txt; span.textContent = scramble(txt); }
  else span.textContent = txt;
  if (run.click || run.hover) {
    span.classList.add('interactive');
    if (run.hover) span.dataset.hover = run.hover;
    if (run.click) span.dataset.click = run.click.kind + ': ' + run.click.value;
  }
  return span;
}
function buildPreviewInto(container, runs, native) {
  container.innerHTML = '';
  let line = document.createElement('div'); line.className = 'mc-line'; container.appendChild(line);
  for (const run of runs) {
    const parts = run.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) { line = document.createElement('div'); line.className = 'mc-line'; container.appendChild(line); }
      if (parts[p].length) line.appendChild(makePreviewSeg(run, parts[p], native));
    }
  }
  container.querySelectorAll('.mc-line').forEach(l => { if (!l.childNodes.length) l.appendChild(document.createElement('br')); });
}

/* tooltip + click hint (event delegation on the preview) */
const tooltip = $('mc-tooltip');
const clickHint = $('click-hint');
function currentNative() {
  const opt = $('version-select').selectedOptions[0];
  return opt ? opt.dataset.native === '1' : true;
}
chatPreview.addEventListener('mousemove', e => {
  const seg = e.target.closest('.mc-seg.interactive');
  if (seg && seg.dataset.hover) {
    buildPreviewInto(tooltip, parseMarkup(seg.dataset.hover), currentNative());
    tooltip.style.display = 'block';
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    if (x + w > window.innerWidth) x = e.clientX - w - pad;
    if (y + h > window.innerHeight) y = e.clientY - h - pad;
    tooltip.style.left = x + 'px'; tooltip.style.top = y + 'px';
  } else { tooltip.style.display = 'none'; }

  if (seg && seg.dataset.click) {
    const [kind, ...rest] = seg.dataset.click.split(': ');
    const label = kind === 'run' ? 'Runs' : kind === 'suggest' ? 'Suggests' : 'Opens';
    clickHint.textContent = '▸ ' + label + ' ' + rest.join(': ');
    clickHint.classList.add('show');
  } else { clickHint.classList.remove('show'); }
});
chatPreview.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; clickHint.classList.remove('show'); });

/* ============================================================================
 * 8. DSL output rendering (syntax-highlight the markup string)
 * ========================================================================== */
function escapeHtml(s) { return s.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
function highlightMarkup(str) {
  let out = '', i = 0;
  const n = str.length;
  const push = (cls, text) => { out += `<span class="${cls}">${escapeHtml(text)}</span>`; };
  while (i < n) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < n) { push('tok-esc', str.substr(i, 2)); i += 2; continue; }
    if ((ch === '&' || ch === '§') && i + 1 < n && isAnyCode(str[i + 1].toLowerCase())) { push('tok-amp', str.substr(i, 2)); i += 2; continue; }
    if (ch === '#' && /^[0-9a-fA-F]{6}/.test(str.substr(i + 1, 6))) { push('tok-hex', str.substr(i, 7)); i += 7; continue; }
    if (ch === '[') {
      const j = str.indexOf(']', i);
      if (j !== -1) {
        const content = str.substring(i + 1, j);
        if (/^(click=|hover=|\/click|\/hover)/.test(content)) { push('tok-tag', str.substring(i, j + 1)); i = j + 1; continue; }
      }
    }
    if (ch === '%') {
      const j = str.indexOf('%', i + 1);
      if (j !== -1 && /^[A-Za-z0-9_]+$/.test(str.substring(i + 1, j))) { push('tok-ph', str.substring(i, j + 1)); i = j + 1; continue; }
    }
    out += escapeHtml(ch); i += 1;
  }
  return out;
}

/* ============================================================================
 * 9. Outputs: DSL + preview + validation + status bar
 * ========================================================================== */
let lastMarkup = '';
function refreshOutputs() {
  const markup = serializeRuns(MAIN.doc);
  lastMarkup = markup;
  $('output-dsl').innerHTML = markup ? highlightMarkup(markup) : '<span class="tok-esc">(empty message)</span>';
  buildPreviewInto(chatPreview, parseMarkup(markup), currentNative());
  renderValidation(validateRuns(MAIN.doc));
  updateStatusBar();
}
function renderValidation(msgs) {
  const box = $('validation');
  if (!msgs.length) { box.classList.remove('show'); box.innerHTML = ''; return; }
  box.classList.add('show');
  box.innerHTML = msgs.map(m => `<div class="v-item ${m.level}">${m.level === 'error' ? '✕' : '⚠'} ${escapeHtml(m.msg)}</div>`).join('');
}
function updateStatusBar() {
  const d = MAIN.doc;
  const text = d.map(r => r.text).join('');
  const lineCount = text.length ? text.split('\n').length : 1;
  const comps = d.filter(r => r.text).length;
  $('status-counts').textContent = `${lineCount} line${lineCount !== 1 ? 's' : ''} · ${comps} component${comps !== 1 ? 's' : ''}`;
  // action group counts
  let run = 0, sug = 0, url = 0, hov = 0, prev = null, prevHover = null;
  for (const r of d) {
    if (!r.text) continue;
    const key = r.click ? r.click.kind + '|' + r.click.value : null;
    if (key && key !== prev) { if (r.click.kind === 'run') run++; else if (r.click.kind === 'suggest') sug++; else url++; }
    prev = key;
    const hKey = r.hover || null;
    if (hKey && hKey !== prevHover) hov++;
    prevHover = hKey;
  }
  $('status-clicks').textContent = `● ${run} click${run !== 1 ? 's' : ''}`;
  $('status-suggest').textContent = `● ${sug} suggest`;
  $('status-url').textContent = `● ${url} url`;
  $('status-hover').textContent = `● ${hov} hover`;
  // Ln/Col from caret
  const off = MAIN.sel.start;
  const before = text.slice(0, off);
  const ln = before.split('\n').length;
  const col = off - (before.lastIndexOf('\n') + 1) + 1;
  $('status-lncol').textContent = `Ln ${ln}, Col ${col}`;
}

/* ============================================================================
 * 10. Toolbar / command handlers
 * ========================================================================== */
function applyStyleCmd(name) {
  if (rawMode && E === MAIN) return;   // formatting is unavailable while editing raw markup
  const [s, e] = ordered();
  if (s === e) { E.pending = E.pending || caretAttrs(s); E.pending[name] = !E.pending[name]; E.reflect(computeActiveAttrs()); E.el.focus(); return; }
  beginEdit('format');
  const runs = runsInRange(s, e);
  const allOn = runs.every(r => r[name]);
  applyAttrRange(s, e, r => { r[name] = !allOn; });
  finalize(s, e);
}
function applyColorCmd(color) {
  if (rawMode && E === MAIN) return;
  const [s, e] = ordered();
  if (s === e) { E.pending = E.pending || caretAttrs(s); E.pending.color = color ? Object.assign({}, color) : null; E.reflect(computeActiveAttrs()); E.el.focus(); return; }
  beginEdit('color');
  applyAttrRange(s, e, r => { r.color = color ? Object.assign({}, color) : null; });
  finalize(s, e);
}
async function applyActionCmd(kind) {
  if (rawMode) return;                  // click/hover actions are unavailable while editing raw markup
  const main = E;                       // actions always target the main editor
  const [s, e] = ordered();
  if (kind === 'clear-action') {
    if (s === e) { toast('Select text to clear its action'); return; }
    beginEdit('action');
    applyAttrRange(s, e, r => { r.click = null; r.hover = null; });
    finalize(s, e); return;
  }
  if (s === e) { toast('Select some text first'); return; }

  if (kind === 'hover') {
    const existing = (runsInRange(s, e)[0] || {}).hover || '';
    const val = await openHoverEditor(existing);   // mini WYSIWYG editor; sets E to the hover ctx
    E = main;                                       // restore active context to the main editor
    if (val === null) return;
    beginEdit('action');
    applyAttrRange(s, e, r => { r.hover = val; });
    finalize(s, e); return;
  }

  const cfg = {
    run:     { title: 'Run command', label: 'Command to run when clicked', def: '/', ph: '/spawn', hint: 'RUN_COMMAND — executed as the player.' },
    suggest: { title: 'Suggest command', label: 'Command to pre-fill in chat', def: '/', ph: '/help', hint: 'SUGGEST_COMMAND — placed in the chat box, not run.' },
    url:     { title: 'Open URL', label: 'URL to open', def: 'https://', ph: 'https://example.com', hint: 'OPEN_URL — only http/https links open in the vanilla client.' },
  }[kind];
  const existing = (runsInRange(s, e)[0] || {}).click;
  const val = await askInput({
    title: cfg.title, label: cfg.label, value: existing && existing.kind === kind ? existing.value : cfg.def,
    placeholder: cfg.ph, hint: cfg.hint,
    validate: v => {
      if (v.includes(']')) return 'Value cannot contain "]"';
      if (kind === 'url' && !/^https?:\/\//i.test(v)) return 'URL must start with http:// or https://';
      return null;
    },
  });
  E = main;
  if (val === null) return;
  beginEdit('action');
  applyAttrRange(s, e, r => { r.click = { kind, value: val }; });
  finalize(s, e);
}
function applyGradient(fromHex, toHex) {
  if (rawMode && E === MAIN) return;
  const [s, e] = ordered();
  if (s === e) { toast('Select text to apply a gradient'); return; }
  beginEdit('gradient');
  const from = hexToRgb(fromHex.replace('#', '')), to = hexToRgb(toHex.replace('#', ''));
  // operate per-character across the selection (skip newlines)
  const a = splitAt(s), b = splitAt(e);
  const chars = [];
  for (let k = a; k < b; k++) { for (const ch of E.doc[k].text) chars.push({ ch, run: E.doc[k] }); }
  const visible = chars.filter(c => c.ch !== '\n');
  let vi = 0;
  const total = Math.max(1, visible.length - 1);
  const newRuns = [];
  for (const c of chars) {
    if (c.ch === '\n') { newRuns.push(mkRun('\n', c.run)); continue; }
    const t = visible.length === 1 ? 0 : vi / total;
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const bl = Math.round(from[2] + (to[2] - from[2]) * t);
    const value = [r, g, bl].map(x => x.toString(16).padStart(2, '0')).join('');
    newRuns.push(mkRun(c.ch, Object.assign({}, c.run, { color: { type: 'hex', value } })));
    vi++;
  }
  E.doc.splice(a, b - a, ...newRuns);
  finalize(s, e);
}
function insertAtCaret(text) {
  if (rawMode && E === MAIN) return;
  const [s, e] = ordered();
  beginEdit('insert');
  if (s !== e) deleteFromDoc(s, e);
  insertIntoDoc(s, text, typingAttrs());
  finalize(s + text.length);
}

/* compute the formatting state to show as "active" on a toolbar (for the active editor E) */
function computeActiveAttrs() {
  const [s, e] = ordered();
  if (s === e) return E.pending || caretAttrs(s);
  const runs = runsInRange(s, e).filter(r => r.text);
  const attrs = blankAttrs();
  if (runs.length) {
    for (const [flag] of STYLE_ORDER) attrs[flag] = runs.every(r => r[flag]);
    if (runs.every(r => colorEq(r.color, runs[0].color))) attrs.color = cloneColor(runs[0].color);
  }
  return attrs;
}
// Reflect formatting state onto a toolbar: `root` scopes the format buttons; swatch/name optional.
function reflectToolbar(root, swatchEl, nameEl, attrs) {
  root.querySelectorAll('.tbtn[data-fmt]').forEach(btn => btn.classList.toggle('active', !!attrs[btn.dataset.fmt]));
  if (attrs.color && swatchEl) setColorSwatch(swatchEl, nameEl, attrs.color);
}
function setColorSwatch(sw, nm, color) {
  if (!color) { sw.style.background = '#888'; if (nm) nm.textContent = 'None'; return; }
  if (color.type === 'legacy') { const c = LEGACY_BY_CODE[color.code]; sw.style.background = `rgb(${c.rgb.join(',')})`; if (nm) nm.textContent = c.name; }
  else { sw.style.background = '#' + color.value; if (nm) nm.textContent = '#' + color.value; }
}

/* ============================================================================
 * 11. beforeinput — full control over editing
 * ========================================================================== */
function handleBeforeInput(e) {
  const t = e.inputType;
  // allow nothing to fall through to native contenteditable
  e.preventDefault();

  // Native history events (Chromium may fire these); route them to our own stacks.
  if (t === 'historyUndo') { undo(); return; }
  if (t === 'historyRedo') { redo(); return; }

  syncSelFromDom();
  const [s, en] = ordered();

  // Deletions: route EVERY delete* inputType (Backspace/Delete, word, line, cut, drag).
  // Browsers fire `deleteContent` — not `deleteContentBackward` — when removing a
  // selection, and since we preventDefault above, any unrouted delete type would be a
  // silent no-op. A non-collapsed selection is always removed wholesale.
  if (t.startsWith('delete')) {
    if (s !== en) { beginEdit('delete-sel'); deleteFromDoc(s, en); finalize(s); return; }
    if (t.indexOf('Forward') !== -1) {
      const e2 = t.indexOf('Word') !== -1 ? wordBoundaryFwd(en) : t.indexOf('Line') !== -1 ? lineEndFwd(en) : en + 1;
      if (e2 > en) { beginEdit('delete'); deleteFromDoc(en, Math.min(e2, docLen())); finalize(en); }
    } else {
      const s2 = t.indexOf('Word') !== -1 ? wordBoundaryBack(s) : t.indexOf('Line') !== -1 ? lineStartBack(s) : s - 1;
      if (s2 < s && s2 >= 0) { beginEdit('delete'); deleteFromDoc(s2, s); finalize(s2); }
    }
    return;
  }

  switch (t) {
    case 'insertText':
    case 'insertReplacementText':
    case 'insertFromComposition':
    case 'insertCompositionText': {
      const data = e.data != null ? e.data : '';
      if (!data && s === en) break;
      // coalesce consecutive single-character typing into one undo step (break on whitespace / replace)
      beginEdit(s === en && data.length === 1 && !/\s/.test(data) ? 'type' : 'type-break');
      if (s !== en) deleteFromDoc(s, en);
      if (data) insertIntoDoc(s, data, typingAttrs());
      finalize(s + data.length);
      break;
    }
    case 'insertParagraph':
    case 'insertLineBreak': {
      beginEdit('newline');
      if (s !== en) deleteFromDoc(s, en);
      insertIntoDoc(s, '\n', typingAttrs());
      finalize(s + 1);
      break;
    }
    case 'insertFromPaste':
    case 'insertFromDrop': {
      const txt = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
      if (!txt && s === en) break;
      beginEdit('paste');
      if (s !== en) deleteFromDoc(s, en);
      if (txt) insertIntoDoc(s, txt, typingAttrs());
      finalize(s + txt.length);
      break;
    }
    default: break; // other input types (formatting, deletes & history handled above)
  }
}

// Undo / redo keyboard shortcuts (native history is empty because we suppress it).
function handleKeydown(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
}
function wordBoundaryBack(off) {
  const text = docText();
  let i = off;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}
function wordBoundaryFwd(off) {
  const text = docText();
  let i = off;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}
function lineStartBack(off) { const t = docText(); const nl = t.lastIndexOf('\n', off - 1); return nl === -1 ? 0 : nl + 1; }
function lineEndFwd(off) { const t = docText(); const nl = t.indexOf('\n', off); return nl === -1 ? t.length : nl; }

/* track selection across all editors; route to whichever context contains it */
document.addEventListener('selectionchange', () => {
  const a = window.getSelection();
  if (!a.rangeCount) return;
  const node = a.getRangeAt(0).startContainer;
  const cx = EDITORS.find(c => c.el.contains(node));
  if (!cx) return;
  E = cx;
  syncSelFromDom();
  E.pending = null;
  E.reflect(computeActiveAttrs());
  E.onSel();
});

/* ============================================================================
 * 12. Modal (replaces window.prompt — works inside sandboxed previews)
 * ========================================================================== */
let modalEls = null;
function buildModal() {
  const overlay = document.createElement('div'); overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-h" id="m-title"></div>
      <div class="modal-b">
        <label id="m-label"></label>
        <div id="m-input-wrap"></div>
        <div class="modal-hint" id="m-hint"></div>
        <div class="modal-err" id="m-err"></div>
      </div>
      <div class="modal-f">
        <button class="mini-btn ghost" id="m-cancel">Cancel</button>
        <button class="mini-btn" id="m-ok">OK</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  modalEls = {
    overlay, title: overlay.querySelector('#m-title'), label: overlay.querySelector('#m-label'),
    wrap: overlay.querySelector('#m-input-wrap'), hint: overlay.querySelector('#m-hint'),
    err: overlay.querySelector('#m-err'), ok: overlay.querySelector('#m-ok'), cancel: overlay.querySelector('#m-cancel'),
  };
  overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) modalEls.cancel.click(); });
}
function askInput(opts) {
  if (!modalEls) buildModal();
  const { title, label, value = '', placeholder = '', hint = '', multiline = false, validate } = opts;
  modalEls.title.textContent = title;
  modalEls.label.textContent = label;
  modalEls.hint.textContent = hint;
  modalEls.err.textContent = '';
  modalEls.wrap.innerHTML = '';
  const input = document.createElement(multiline ? 'textarea' : 'input');
  if (multiline) input.rows = 3; else input.type = 'text';
  input.value = value; input.placeholder = placeholder;
  modalEls.wrap.appendChild(input);
  modalEls.overlay.classList.add('open');
  setTimeout(() => { input.focus(); input.select && input.select(); }, 0);

  return new Promise(resolve => {
    const close = result => {
      modalEls.overlay.classList.remove('open');
      modalEls.ok.onclick = modalEls.cancel.onclick = input.onkeydown = null;
      resolve(result);
      if (MAIN) MAIN.el.focus();
    };
    const submit = () => {
      const v = input.value;
      const err = validate ? validate(v) : null;
      if (err) { modalEls.err.textContent = err; return; }
      close(v);
    };
    modalEls.ok.onclick = submit;
    modalEls.cancel.onclick = () => close(null);
    input.onkeydown = ev => {
      if (ev.key === 'Enter' && !(multiline && ev.shiftKey)) { ev.preventDefault(); submit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(null); }
    };
  });
}

/* ============================================================================
 * 13. Menus, buttons, init
 * ========================================================================== */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea'); ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
      ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (__) { return false; }
  }
}

/* dropdown open/close */
function closeAllMenus(except) {
  document.querySelectorAll('.menu.open').forEach(m => { if (m !== except) m.classList.remove('open'); });
}
function wireDropdown(btnId, menuId) {
  const btn = $(btnId), menu = $(menuId);
  btn.addEventListener('click', e => {
    if (e.target.closest('.menu')) return;   // clicks inside the menu don't toggle
    e.stopPropagation();
    const willOpen = !menu.classList.contains('open');
    closeAllMenus();
    if (willOpen) menu.classList.add('open');
  });
}
document.addEventListener('click', () => closeAllMenus());

const PLACEHOLDERS = [
  ['%player%', 'player name'], ['%displayname%', 'display name'], ['%world%', 'world'],
  ['%balance%', 'money balance'], ['%online%', 'online count'], ['%max%', 'max players'],
  ['%rank%', 'rank'], ['%x%', 'X'], ['%y%', 'Y'], ['%z%', 'Z'],
];
const SYMBOLS = ['⚔', '★', '☆', '❤', '✦', '✪', '➜', '➤', '▶', '●', '◆', '⬛', '⛏', '☠', '⚡', '✔', '✖', '➥', '»', '«', '✚', '⭐'];

const SAMPLE = [
  '&6&l⚔ Welcome to SkyBlock! ⚔',
  '&fClick [hover=&7Click to teleport to spawn island][click=run:/warp skyblock]&a&l&nhere[/click][/hover]&f to begin your adventure',
  '&7&oType [click=suggest:/help]&e&o/help[/click]&7&o for a list of commands',
  '&fVisit our [click=url:https://wiki.skyblock.net]&b&nwiki[/click]&f for more guides',
].join('\n');

const TEMPLATES = [
  { name: 'SkyBlock Welcome', markup: SAMPLE },
  { name: 'Server Broadcast', markup: '&8[&c&lALERT&8] &fThe server will restart in &e5 minutes&f. Save your progress!' },
  { name: 'Rank Purchase', markup: '&aThank you &6%player% &afor purchasing &b&lVIP&a! Enjoy your perks.' },
  { name: 'Clear (empty)', markup: '' },
];

function loadMarkup(markup, opts) {
  opts = opts || {};
  if (!opts.resetHistory) beginEdit('load');   // New / template loads are undoable
  E.doc = parseMarkup(markup);
  if (docLen() === 0) E.doc = [mkRun('', {})];
  E.pending = null;
  finalize(docLen());
  if (opts.resetHistory) resetHistory();        // initial load starts with a clean history
  E.el.focus();
}

/* Wire the shared Format / Colour / Gradient controls of a toolbar to an editor context. */
function wireToolbar(ctx, ids) {
  const tb = document.querySelector(ids.toolbar);
  const grid = $(ids.grid);
  LEGACY.forEach(c => {
    const cell = document.createElement('div');
    cell.className = 'color-cell';
    cell.style.background = `rgb(${c.rgb.join(',')})`;
    cell.title = `${c.name} (&${c.code})`;
    cell.addEventListener('mousedown', e => e.preventDefault());
    cell.addEventListener('click', () => {
      E = ctx; const col = { type: 'legacy', code: c.code };
      currentColor = col; setColorSwatch($(ids.swatch), $(ids.name), col);
      applyColorCmd(col); closeAllMenus();
    });
    grid.appendChild(cell);
  });
  $(ids.applyHex).addEventListener('mousedown', e => e.preventDefault());
  $(ids.applyHex).addEventListener('click', () => {
    const v = $(ids.hex).value.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(v)) { toast('Enter a 6-digit hex like #1a2b3c'); return; }
    E = ctx; const col = { type: 'hex', value: v.toLowerCase() };
    currentColor = col; setColorSwatch($(ids.swatch), $(ids.name), col);
    applyColorCmd(col); closeAllMenus();
  });
  $(ids.hex).addEventListener('keydown', e => { if (e.key === 'Enter') $(ids.applyHex).click(); });
  $(ids.clearColor).addEventListener('mousedown', e => e.preventDefault());
  $(ids.clearColor).addEventListener('click', () => { E = ctx; applyColorCmd(null); closeAllMenus(); });
  $(ids.applyGrad).addEventListener('mousedown', e => e.preventDefault());
  $(ids.applyGrad).addEventListener('click', () => { E = ctx; applyGradient($(ids.gradFrom).value, $(ids.gradTo).value); closeAllMenus(); });
  tb.querySelectorAll('.tbtn[data-fmt]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => { E = ctx; applyStyleCmd(btn.dataset.fmt); });
  });
  wireDropdown(ids.colorBtn, ids.colorMenu);
  wireDropdown(ids.gradBtn, ids.gradMenu);
  [ids.colorMenu, ids.gradMenu].forEach(id => $(id).addEventListener('click', e => e.stopPropagation()));
  tb.addEventListener('mousedown', e => {
    if (e.target.closest('input, textarea, .menu')) return;
    if (e.target.closest('.tbtn, .pill, .color-cell, .sym-cell, .mini-btn, .menu-item')) return;
    e.preventDefault();
  });
}

/* Hover-tooltip mini-editor: live preview + "]" validation */
function updateHoverPreview() {
  const markup = serializeRuns(HOVER.doc);
  buildPreviewInto($('hover-preview'), parseMarkup(markup), currentNative());
  $('hover-err').textContent = markup.includes(']') ? '⚠ "]" will truncate the tooltip tag — please remove it.' : '';
}
function openHoverEditor(existing) {
  return new Promise(resolve => {
    $('hover-overlay').classList.add('open');
    E = HOVER;
    loadMarkup(existing || '', { resetHistory: true });   // load into the hover editor
    setTimeout(() => HOVER.el.focus(), 0);
    const close = result => {
      $('hover-overlay').classList.remove('open');
      $('hover-ok').onclick = $('hover-cancel').onclick = null;
      resolve(result);
    };
    $('hover-ok').onclick = () => {
      const markup = serializeRuns(HOVER.doc);
      if (markup.includes(']')) { $('hover-err').textContent = '⚠ Tooltip cannot contain "]" — it would truncate the tag.'; return; }
      close(markup);
    };
    $('hover-cancel').onclick = () => close(null);
  });
}

/* ----------------------------------------------------------------------------
 * Raw-markup mode — toggle the main editor between the rendered WYSIWYG view and
 * a plain <textarea> holding the literal ChatMarkup string. Lets the user paste a
 * raw markup string and flip back to see it rendered. MAIN.doc is kept live so the
 * chat preview / DSL output / validation update as they type; the whole raw-editing
 * session collapses into a single undo step (the 'raw' coalesce tag below).
 * ------------------------------------------------------------------------- */
COALESCE.add('raw');                    // raw edits coalesce into one undo step (see syncFromRaw)
function lenOfDoc(d) { return d.reduce((a, r) => a + r.text.length, 0); }

function syncFromRaw() {                 // raw textarea text → MAIN.doc + outputs (no #editor re-render)
  E = MAIN;
  let newDoc = parseMarkup(rawEl.value);
  if (lenOfDoc(newDoc) === 0) newDoc = [mkRun('', {})];
  if (serializeRuns(newDoc) === serializeRuns(MAIN.doc)) { refreshOutputs(); return; }
  beginEdit('raw');
  MAIN.doc = newDoc;
  MAIN.pending = null;
  refreshOutputs();                     // DSL output + chat preview + validation + status bar
}

function updateRawToggleBtn() {
  const btn = $('btn-raw-toggle');
  if (!btn) return;
  btn.classList.toggle('active', rawMode);
  btn.title = rawMode ? 'Back to the visual editor'
                      : 'Edit the raw markup string directly (paste markup here)';
}

function enterRawMode() {
  if (rawMode) return;
  E = MAIN;
  rawMode = true;
  rawEl.value = serializeRuns(MAIN.doc);
  editorWrap.classList.add('raw');
  toolbarEl.classList.add('raw-disabled');
  closeAllMenus();
  updateRawToggleBtn();
  rawEl.focus();
  const end = rawEl.value.length;
  rawEl.setSelectionRange(end, end);
}

function exitRawMode() {
  if (!rawMode) return;
  syncFromRaw();                        // commit the final raw text into the model (sets E = MAIN)
  rawMode = false;
  editorWrap.classList.remove('raw');
  toolbarEl.classList.remove('raw-disabled');
  updateRawToggleBtn();
  finalize(docLen());                   // rebuild #editor from the model, caret to end, refresh
  MAIN.coalesceTag = null;              // close the coalesced raw-edit undo group
  MAIN.el.focus();
}

function toggleRawMode() { rawMode ? exitRawMode() : enterRawMode(); }

// New / Templates / SBMB.loadMarkup, made raw-aware: in raw mode the textarea is the
// surface the user sees, so load the markup there and re-sync; otherwise load normally.
function externalLoad(markup, opts) {
  E = MAIN;
  markup = markup || '';
  if (rawMode) {
    rawEl.value = markup;
    syncFromRaw();
    rawEl.focus();
    rawEl.setSelectionRange(markup.length, markup.length);
  } else {
    loadMarkup(markup, opts);
  }
}

function init() {
  /* create the two editor contexts */
  MAIN = makeCtx($('editor'), {
    commit: refreshOutputs,
    reflect: a => reflectToolbar(document.querySelector('.toolbar'), $('color-swatch'), $('color-name'), a),
    onSel: updateStatusBar,
  });
  HOVER = makeCtx($('hover-editor'), {
    commit: updateHoverPreview,
    reflect: a => reflectToolbar(document.querySelector('.hov-toolbar'), $('hov-color-swatch'), $('hov-color-name'), a),
  });
  E = MAIN;

  /* shared Format / Colour / Gradient controls for both toolbars */
  wireToolbar(MAIN, { toolbar: '.toolbar', grid: 'color-grid', hex: 'custom-hex', applyHex: 'apply-hex',
    clearColor: 'clear-color', gradFrom: 'grad-from', gradTo: 'grad-to', applyGrad: 'apply-gradient',
    swatch: 'color-swatch', name: 'color-name', colorBtn: 'btn-color', colorMenu: 'menu-color',
    gradBtn: 'btn-gradient', gradMenu: 'menu-gradient' });
  wireToolbar(HOVER, { toolbar: '.hov-toolbar', grid: 'hov-color-grid', hex: 'hov-custom-hex', applyHex: 'hov-apply-hex',
    clearColor: 'hov-clear-color', gradFrom: 'hov-grad-from', gradTo: 'hov-grad-to', applyGrad: 'hov-apply-gradient',
    swatch: 'hov-color-swatch', name: 'hov-color-name', colorBtn: 'hov-btn-color', colorMenu: 'hov-menu-color',
    gradBtn: 'hov-btn-gradient', gradMenu: 'hov-menu-gradient' });

  /* main-only: action buttons */
  document.querySelectorAll('.pill[data-action]').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => { E = MAIN; applyActionCmd(btn.dataset.action); });
  });

  /* main-only: raw-markup mode toggle + textarea */
  rawEl = $('editor-raw');
  editorWrap = document.querySelector('.editor-wrap');
  toolbarEl = document.querySelector('.toolbar');
  $('btn-raw-toggle').addEventListener('mousedown', e => e.preventDefault());
  $('btn-raw-toggle').addEventListener('click', () => toggleRawMode());
  rawEl.addEventListener('input', syncFromRaw);

  /* main-only: insert + templates dropdowns */
  wireDropdown('btn-insert', 'menu-insert');
  wireDropdown('btn-templates', 'menu-templates');
  ['menu-insert', 'menu-templates'].forEach(id => $(id).addEventListener('click', e => e.stopPropagation()));

  const pl = $('placeholder-list');
  PLACEHOLDERS.forEach(([token, desc]) => {
    const item = document.createElement('div'); item.className = 'menu-item';
    item.innerHTML = `<span>${token}</span><span class="hint">${desc}</span>`;
    item.addEventListener('mousedown', e => e.preventDefault());
    item.addEventListener('click', () => { E = MAIN; insertAtCaret(token); closeAllMenus(); });
    pl.appendChild(item);
  });
  const sg = $('symbol-grid');
  SYMBOLS.forEach(sym => {
    const cell = document.createElement('div'); cell.className = 'sym-cell'; cell.textContent = sym;
    cell.addEventListener('mousedown', e => e.preventDefault());
    cell.addEventListener('click', () => { E = MAIN; insertAtCaret(sym); closeAllMenus(); });
    sg.appendChild(cell);
  });

  const tl = $('templates-list');
  TEMPLATES.forEach(t => {
    const item = document.createElement('div'); item.className = 'menu-item';
    item.innerHTML = `<span>${t.name}</span>`;
    item.addEventListener('click', () => { externalLoad(t.markup); closeAllMenus(); });
    tl.appendChild(item);
  });

  /* header buttons */
  $('btn-new').addEventListener('click', () => externalLoad(''));
  $('btn-copy-output').addEventListener('click', async () => { toast(await copyText(serializeRuns(MAIN.doc)) ? 'Output copied!' : 'Copy failed'); });
  $('btn-copy-dsl').addEventListener('click', async () => { toast(await copyText(serializeRuns(MAIN.doc)) ? 'Output copied!' : 'Copy failed'); });

  /* version selector */
  $('version-select').addEventListener('change', () => { refreshOutputs(); if ($('hover-overlay').classList.contains('open')) updateHoverPreview(); });

  /* hover modal: backdrop click + Escape cancel */
  $('hover-overlay').addEventListener('mousedown', e => { if (e.target === $('hover-overlay')) $('hover-cancel').click(); });
  $('hover-overlay').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); $('hover-cancel').click(); } });

  /* load default sample */
  E = MAIN;
  loadMarkup(SAMPLE, { resetHistory: true });

  /* Public engine API. Editor handles operate on the main editor. */
  window.SBMB = { parseMarkup, serializeRuns, validateRuns, nearestLegacy, hexToRgb, LEGACY,
    loadMarkup: (m, o) => externalLoad(m, o),
    getMarkup: () => serializeRuns(MAIN.doc), getDoc: () => MAIN.doc,
    undo: () => { E = MAIN; undo(); }, redo: () => { E = MAIN; redo(); },
    openHoverEditor, hoverCtx: () => HOVER, mainCtx: () => MAIN,
    toggleRawMode, enterRawMode, exitRawMode, isRawMode: () => rawMode, rawEl: () => rawEl };
}

document.addEventListener('DOMContentLoaded', init);
