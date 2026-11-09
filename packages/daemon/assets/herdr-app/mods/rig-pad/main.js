// OpenRig's Rig view padding cell: fills an equal grid when the seats don't.
import { View, div } from "gpui-kit";
import { theme } from "herdr";

export default class RigPad extends View {
  render() {
    const t = theme();
    return div().id("rig-pad").size_full().bg(t.canvas);
  }
}
