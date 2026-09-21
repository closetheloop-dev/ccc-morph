import { encodeKeyLegacy, type Key } from "./keys";

export type ViewerInputToken = number | "up" | "down" | "page-up" | "page-down";

// Translate a decoded key (produced once by the shared input pipeline) into the
// token a wrapper viewer switches on. Terminal input is decoded upstream — legacy
// bytes AND Kitty CSI-u alike — so under report-all-keys a viewer's q/Enter/Escape
// still arrive as the right token instead of being misread as escape sequences.
//
// Arrows and paging map to the viewer's named tokens; every other key collapses to
// the single legacy byte the viewers already recognize (q, j/k, Enter, Tab, Space,
// Escape, Ctrl-D, Shift-D, ...). Keys with no single-byte legacy form (e.g. a
// modified arrow) return null and are ignored by the viewer. Only presses are
// dispatched, so a key's release never triggers a command.
export function keyToViewerToken(key: Key): ViewerInputToken | null {
  if (!key.mods.ctrl && !key.mods.alt && !key.mods.shift) {
    if (key.name === "up") return "up";
    if (key.name === "down") return "down";
    if (key.name === "page-up") return "page-up";
    if (key.name === "page-down") return "page-down";
  }
  try {
    const bytes = encodeKeyLegacy(key);
    if (bytes.length === 1) return bytes[0]!;
  } catch {
    // Unsupported key: the viewer has no command for it.
  }
  return null;
}
