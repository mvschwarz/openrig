// OpenRig's Rig view cell for a viewer that ended. OpenRig writes it in place of the terminal block, so the layout
// never references a dead terminal. props: { title }
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, theme } from "herdr";

export default class RigEnded extends View {
  render() {
    const t = theme(), p = props() ?? {};
    return v_flex().id("rig-ended").size_full().items_center().justify_center().gap(4).bg(t.canvas).text_size(12)
      .child(div().text_color(t.muted).child(`${p.title ?? "This viewer"} ended`))
      .child(div().text_color(t.dim).child("Its seat is not touched. Open the view again to reattach."));
  }
}
