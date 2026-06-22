# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **static, dependency-free, vanilla-JS website** — a visual "Message Builder" where Minecraft server admins compose chat messages and copy out a markup string. There is no build step, no framework, no package.json. Just `index.html` (markup + all CSS) and `app.js` (engine + editor).

**The output string is the entire point.** It must conform exactly to what spigot-boot's `ChatMarkup` parser consumes. The authoritative contract is `../spigot-boot/chat-markup-frontend-spec.md` (a sibling repo) — read it before changing anything in the parser/serializer. The grammar: `&a`/`§a` legacy colours, `#rrggbb` hex (version-gated), `[click=run:/cmd]…[/click]`, `[hover=<markup>]…[/hover]`, `\` escapes, `%key%` placeholders. It is **not** MiniMessage/Adventure, despite what the original design mockup's "DSL" pane implied.

## Commands

- **Run / preview the dev server:** start via the Claude Preview MCP using `.claude/launch.json` (config name `message-builder`, port 5050). It runs `python serve.py`.
- **`serve.py` is intentionally custom:** a `ThreadingHTTPServer` that sends `Cache-Control: no-store`. Don't replace it with `python -m http.server` — that one is single-threaded (hangs when the preview tab and another client connect at once) and sends no cache headers (the browser then serves a stale `app.js` after edits).
- **If stale code is still suspected after an edit,** bump the `app.js?v=N` query in `index.html` (one-time cache-bust; `no-store` handles the rest).
- **Syntax check (no runtime):** `node --check app.js`. `app.js` touches the DOM at load, so it cannot be `require`d in Node — `--check` only parses.
- **There is no test runner.** Verify in the browser (see below).

## Verifying changes

- Use the **Claude Preview MCP** (`mcp__Claude_Preview__*`) — that browser shares the sandbox network with the dev server. Do **not** try the user's real Chrome (Claude-in-Chrome MCP): the sandbox-bound server returns a `chrome-error` page there. The user themselves interacts through the Claude preview panel.
- **`preview_screenshot` times out** because the preview tab is backgrounded (`document.hidden` pauses `requestAnimationFrame`). Verify via `preview_eval` + DOM inspection instead — it's more precise anyway.
- The engine is exposed for scripted checks as **`window.SBMB`**: `parseMarkup`, `serializeRuns`, `validateRuns`, `nearestLegacy`, `hexToRgb`, `loadMarkup`, `getMarkup`, `getDoc`, `undo`, `redo`, `openHoverEditor`, `mainCtx`, `hoverCtx`. Use spec §9 worked examples and round-trips (`parse(serialize(x)) === serialize(x)`) as fixtures.
- Synthetic-event caveat: `new InputEvent('beforeinput',{inputType:'deleteContent'})` yields `inputType === ""` (Chromium blanks non-allowlisted values), so some real inputTypes can't be reproduced synthetically. Editor delete handling keys off `inputType.startsWith('delete')` precisely for this reason.

## Architecture (`app.js`)

Two layers. Both are needed because the live preview round-trips through them: **model → `serializeRuns` → `parseMarkup` → render**, so the preview shows exactly what the server would render (quirks included).

### Pure engine (no DOM, design-independent)
- `LEGACY[16]` — the 16 colours with exact RGB from spec §4.1; drives names, swatches, and downsampling.
- `parseMarkup(str)` → flat `runs[]`. A faithful mirror of `ChatMarkup.parse`, including its quirks: a colour/`#hex` token **resets all styles**; the `#` hex guard needs a char after the 6 digits; `[` is only a tag if a later `]` exists and the body starts with `click=`/`hover=`/`/click`/`/hover`, otherwise `[` is literal and the rest re-tokenizes; click/hover use stacks; unknown click kinds fall back to OPEN_URL.
- `serializeRuns(runs)` → markup string (spec §7.2). The subtle rule: legacy codes can't turn a *single* style off, so it emits a clearing token (`&r` or re-emitting the colour) whenever the colour changes **or** any active style must go off, then re-asserts the needed styles. Also: trailing-hex guard, and `escapeRunText` escapes `\ & § # [` but **not** `%` (placeholders pass through) or `]`.
- `validateRuns`, `nearestLegacy` (squared-distance downsample, §4.3).

### Reusable editor (contenteditable, `beforeinput`-controlled)
- All editor functions operate on the **active context `E`**. `makeCtx(el, opts)` builds one; `MAIN` (the message editor) and `HOVER` (the tooltip mini-editor in the modal) are two instances. Every input handler and toolbar command sets `E` to its instance before running; `selectionchange` routes to whichever context contains the selection.
- The model is a flat `runs[]` where `text` may contain `\n`; the DOM is rebuilt from the model on every change (`renderEditor`) and the caret restored by character offset (`offsetToDom`/`domToOffset`).
- We `preventDefault()` **all** input and apply edits to the model ourselves. Consequences: the browser's native undo history is empty, so **undo/redo is our own snapshot stack** driven by a `keydown` handler (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y), with typing/delete runs coalesced into single steps.
- `commit`/`reflect`/`onSel` are per-context callbacks: MAIN's `commit` is `refreshOutputs` (DSL output + chat preview + validation + status bar); HOVER's is `updateHoverPreview`.

### Editor invariants — easy to break, hard to notice
- **Colour before style** when emitting; re-assert styles after every colour change (a colour resets styles).
- **`mkRun(text, attrs)` applies `text` last** so an `attrs` object that itself carries `text` (an existing run in `splitAt`/`applyGradient`) can't clobber the slice.
- **`domToOffset` on the editor node maps an index at/past the last child to `docLen()`** — Ctrl+A's selection end is `(editor, childCount)`; clamping it wrong silently drops the last line.
- **`typingAttrs` never inherits across a `\n`** — otherwise a new line below a coloured line inherits its colour.
- **Tooltips (hover bodies) are colours/styles only** — no nested click/hover, and `]` is forbidden (it truncates the `[hover=…]` tag; there is no escape for `]`).

## index.html

Single file: all CSS in `<style>`, the app shell, and the hover-tooltip modal. CSS theming uses `--`-prefixed variables. The hover modal uses `overflow: visible` (corners rounded on `.modal-h`/`.modal-f`) so its toolbar dropdowns aren't clipped. Toolbars are wired generically by `wireToolbar(ctx, ids)`; the main toolbar additionally has the action pills, Insert, Templates, and header buttons.

## Known spec discrepancy

Spec §9 "Example 3" claims `#1a2b3c` downsamples to Black; the real nearest-legacy (and what `HexSupport.java` computes) is **Dark Gray (`8`)**. Trust the §4.3 algorithm, not that prose example — `nearestLegacy` is correct, do not "fix" it to match Example 3.
