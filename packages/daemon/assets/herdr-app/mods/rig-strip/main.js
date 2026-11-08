// OpenRig's Rig view strip: the header of the `rig-work` stack in OpenRig's Rig layout (layouts/rig.json).
// Installed and updated by OpenRig when it opens a view; OpenRig writes its props on every layout write.
//
// - Pills: the person's tabs, then OpenRig's views. A click shows that stack child (layout.select).
// - Entering a view (a click here, an explicit open, or a restart with one shown) focuses the cell the person was
//   last in, else the first live cell. Never on a rewrite, never while the person is elsewhere.
//   herdr-app reloads this strip whenever its props change, which is every OpenRig write, and keys a mod's storage by
//   its props. So what the strip must remember (the cell per view, the child last shown, the revision it was shown
//   with) lives in <app home>/openrig/strip.json. A reload with a new revision and the same shown child is a rewrite:
//   nothing moves. The same revision is a restart: the shown view gets its remembered cell back.
// - Keys: `rig-strip.left|right|up|down`, when the person binds them (keys.json section `layout:rig`), move the
//   keyboard between a view's live cells; pad and ended cells are skipped.
// - Acknowledgement: OpenRig stamps each write with a revision. When this strip renders a revision, its own shown
//   layout carries that write, so it records the revision and the terminals the shown layout still references in
//   <app home>/openrig/ack.json. OpenRig ends a viewer only after that record shows its cell is gone.
//
// props: { stack, main, revision, views: [{ id, name, rows: [[terminal|null, ...], ...] }] }
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, theme, run, focused, layout, nextCommand, appHome, readTextFile, writeTextFile } from "herdr";

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  return null;
}

function terminalsIn(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.content?.terminal === "string") out.push(node.content.terminal);
  for (const child of node.children ?? []) terminalsIn(child, out);
  return out;
}

export default class RigStrip extends View {
  init(_p, cx) {
    const path = `${appHome()}/openrig/strip.json`;
    readTextFile(path)
      .then((text) => {
        const state = JSON.parse(text);
        if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("strip.json root is not an object");
        this.saved = text;
        this.state = state;
      })
      .catch(() => { this.saved = null; this.state = {}; })
      .finally(() => { this.state ??= {}; this.state.cells ??= {}; this.loaded = true; cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command !== "focus") this.move(command);
        cx.notify();
      }
    });
  }

  shown() {
    const p = props() ?? {};
    return find(layout(), p.stack)?.active ?? null;
  }

  view(id) {
    return ((props() ?? {}).views ?? []).find((v) => v.id === id) ?? null;
  }

  move(dir) {
    const view = this.view(this.shown());
    const at = focused()?.terminal;
    const step = { left: [0, -1], right: [0, 1], up: [-1, 0], down: [1, 0] }[dir];
    if (!view || !at || !step) return;
    const rows = view.rows;
    let r = rows.findIndex((row) => row.includes(at));
    if (r < 0) return;
    let c = rows[r].indexOf(at);
    for (;;) {
      r += step[0]; c += step[1];
      if (r < 0 || r >= rows.length || c < 0 || c >= rows[r].length) return;
      if (rows[r][c]) { run("pane.focus", { terminal: rows[r][c] }); return; }
    }
  }

  /** Records the strip's state; one write at a time, the latest state wins. */
  persist() {
    const text = JSON.stringify(this.state) + "\n";
    if (text === this.saved || this.saving) { this.dirty = text !== this.saved && this.saving; return; }
    this.saving = true;
    const path = `${appHome()}/openrig/strip.json`;
    readTextFile(path).catch(() => null)
      .then((current) => writeTextFile(path, text, current))
      .then(() => { this.saved = text; })
      .catch((e) => console.log(`rig-strip: could not record its state: ${e}`))
      .finally(() => { this.saving = false; if (this.dirty) { this.dirty = false; this.persist(); } });
  }

  enter(view) {
    const live = view.rows.flat().filter(Boolean);
    const remembered = this.state.cells[view.id];
    const target = live.includes(remembered) ? remembered : live[0];
    if (target) { run("pane.focus", { terminal: target }); this.state.cells[view.id] = target; }
  }

  // Focus only when the person enters a view: a change of the shown child, or a restart with one shown. A reload
  // caused by an OpenRig write (a new revision, the same shown child) moves nothing, unless the cell the person was in
  // has just ended while they are in that view: then the keyboard goes to a live cell instead of a dead one.
  follow() {
    if (!this.loaded) return;
    const shown = this.shown(), view = this.view(shown), revision = (props() ?? {}).revision ?? null;
    const remembered = view ? this.state.cells[view.id] : undefined;
    const lost = !!(view && remembered && !view.rows.flat().includes(remembered));
    if (!this.settled) {
      this.settled = true;
      const restart = revision === this.state.revision;
      if (view && (shown !== this.state.shown || restart || lost)) this.enter(view);
    } else if (view && (shown !== this.state.shown || lost)) this.enter(view);
    this.state.shown = shown;
    this.state.revision = revision;
    const at = focused()?.terminal;
    if (view && at && view.rows.some((row) => row.includes(at))) this.state.cells[view.id] = at;
    for (const id of Object.keys(this.state.cells)) if (!this.view(id)) delete this.state.cells[id];
    this.persist();
  }

  acknowledge() {
    const p = props() ?? {};
    if (!p.revision || p.revision === this.acked || this.acking) return;
    const shown = layout();
    // The shown layout carries this very write: its strip props hold the revision being acknowledged.
    if (find(shown, p.stack)?.header?.content?.props?.revision !== p.revision) return;
    this.acking = true;
    const path = `${appHome()}/openrig/ack.json`;
    const record = JSON.stringify({ revision: p.revision, terminals: terminalsIn(shown), at: new Date().toISOString() }) + "\n";
    // A missing ack.json reads as null; any other read failure must not stop the acknowledgement either.
    readTextFile(path).catch(() => null)
      .then((current) => writeTextFile(path, record, current))
      .then(() => { this.acked = p.revision; })
      .catch((e) => console.log(`rig-strip: could not record revision ${p.revision}: ${e}`))
      .finally(() => { this.acking = false; });
  }

  render() {
    const t = theme(), p = props() ?? {};
    this.follow();
    this.acknowledge();
    const active = this.shown();
    const pill = (id, name) => div().id(`v-${id}`).px(10).h(24).flex().items_center().rounded(6).text_size(12)
      .bg(id === active ? t.selected : t.chrome).text_color(id === active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("layout.select", { stack: p.stack, child: id })).child(name);
    return h_flex().id("rig-strip").size_full().px(8).gap(4).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(pill(p.main ?? "main", "Your tabs"))
      .children((p.views ?? []).map((v) => pill(v.id, v.name)));
  }
}
