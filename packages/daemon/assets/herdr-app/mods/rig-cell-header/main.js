// OpenRig's Rig view cell header: the `<agent> · <slice>` title over a viewer, drawn like herdr's own pane header
// (30 px, theme colours) and independent of terminal titles, so tmux `set-titles` can't overwrite it.
// props: { title, detail, seat }
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, theme } from "herdr";

export default class RigCellHeader extends View {
  render() {
    const t = theme(), p = props() ?? {};
    return h_flex().id("rig-cell-header").size_full().px(10).gap(8).items_center().bg(t.background).text_size(12)
      .child(div().flex_none().truncate().max_w(320).font_medium().text_color(t.foreground).child(p.title ?? ""))
      .child(div().flex_1().truncate().text_color(t.dim).child(p.detail ?? ""));
  }
}
