// OPR.0.5.3.5 mini-req 6 — ADDRESSABLE MARKDOWN, the resolver core (Atom 1).
// RED-first against the locked Q1 ruling (SPEC.md, approved-spec-by review-r1):
// an address is `file#H2-slug/H3-slug`; it resolves to everything until the next
// SAME-OR-HIGHER-level header; headers inside code fences are never addresses;
// resolution FAILS LOUD (an address that matches nothing is an error with a
// reason, never a silent empty); the validator enforces unique header-paths and
// one memorable slug rule. The bare-address vs own-text rule is STATED and
// ENFORCED: a bare address returns the FULL section span (children included);
// own text (until the next header of ANY level) is the `ownText` field of the
// same resolution — never a second address syntax (the May separator-ambiguity
// lesson: exactly one grammar form).

import { describe, it, expect } from "vitest";
import {
  slugifyHeader,
  parseAddress,
  parseMarkdownSections,
  resolveAddress,
  validateMarkdownAddressability,
  AddressResolutionError,
} from "../src/domain/markdown-address.js";

const CORPUS = [
  "# Title", //                                  H1 — file-level, not addressable (Q1: H2+H3)
  "intro prose", //                              line 1
  "", //
  "## Getting Started", //                       H2 @ line 3, slug getting-started
  "welcome text", //
  "", //
  "### Install the CLI", //                      H3 @ line 6, slug install-the-cli
  "run the installer", //
  "", //
  "```bash", //                                  fence opens @ line 9
  "## not-a-header inside a fence", //           protected
  "### also-not-a-header", //
  "```", //                                      fence closes
  "post-fence prose of Install the CLI", //      still inside install-the-cli
  "", //
  "### Configure", //                            H3 @ line 15, slug configure
  "config text", //
  "", //
  "## Reference", //                             H2 @ line 18, slug reference
  "ref intro (own text of Reference)", //
  "", //
  "### Commands & Flags!", //                    H3 @ line 21, slug commands-flags
  "the flag table", //
].join("\n");

describe("slugifyHeader — ONE memorable rule", () => {
  it("lowercases, hyphenates non-alphanumerics, collapses and trims hyphens", () => {
    expect(slugifyHeader("Getting Started")).toBe("getting-started");
    expect(slugifyHeader("Commands & Flags!")).toBe("commands-flags");
    expect(slugifyHeader("  Weird   spacing  ")).toBe("weird-spacing");
    expect(slugifyHeader("`code` and *emphasis*")).toBe("code-and-emphasis");
  });
});

describe("parseAddress — the one grammar form: name#H2-slug/H3-slug", () => {
  it("splits ref and header path", () => {
    expect(parseAddress("packs/install#getting-started/install-the-cli")).toEqual({
      ref: "packs/install",
      headerPath: ["getting-started", "install-the-cli"],
    });
    expect(parseAddress("file.md#reference")).toEqual({ ref: "file.md", headerPath: ["reference"] });
  });
  it("a bare ref has an empty header path (whole file)", () => {
    expect(parseAddress("packs/install")).toEqual({ ref: "packs/install", headerPath: [] });
  });
  it("fails loud on malformed forms: empty ref, empty segment, depth beyond H3, second '#'", () => {
    expect(() => parseAddress("#getting-started")).toThrow(AddressResolutionError);
    expect(() => parseAddress("f#a//b")).toThrow(AddressResolutionError);
    expect(() => parseAddress("f#a/b/c")).toThrow(AddressResolutionError);
    expect(() => parseAddress("f#a#b")).toThrow(AddressResolutionError);
  });
});

describe("parseMarkdownSections — code-fence-protected header tree", () => {
  it("finds exactly the real H2/H3 headers, never fenced ones", () => {
    const sections = parseMarkdownSections(CORPUS);
    expect(sections.map((s) => s.headerPath.join("/"))).toEqual([
      "getting-started",
      "getting-started/install-the-cli",
      "getting-started/configure",
      "reference",
      "reference/commands-flags",
    ]);
  });
  it("spans terminate at the next SAME-OR-HIGHER header (Q1), own text at ANY header", () => {
    const sections = parseMarkdownSections(CORPUS);
    const gettingStarted = sections.find((s) => s.headerPath.join("/") === "getting-started")!;
    const install = sections.find((s) => s.headerPath.join("/") === "getting-started/install-the-cli")!;
    // getting-started runs to the line before "## Reference" (children included)...
    expect(gettingStarted.text).toContain("### Configure");
    expect(gettingStarted.text).not.toContain("## Reference");
    // ...while its own text stops at its first child header.
    expect(gettingStarted.ownText).toContain("welcome text");
    expect(gettingStarted.ownText).not.toContain("### Install the CLI");
    // install-the-cli (H3) ends at the NEXT H3 (same level), fence content included.
    expect(install.text).toContain("post-fence prose");
    expect(install.text).toContain("## not-a-header inside a fence");
    expect(install.text).not.toContain("### Configure");
  });
});

describe("resolveAddress — fail-loud resolution on real text", () => {
  it("resolves an H2 and an H2/H3 address to the correct spans", () => {
    const h2 = resolveAddress(CORPUS, ["reference"]);
    expect(h2.text).toContain("ref intro");
    expect(h2.text).toContain("the flag table"); // children included
    const h3 = resolveAddress(CORPUS, ["getting-started", "install-the-cli"]);
    expect(h3.text).toContain("run the installer");
    expect(h3.text).not.toContain("config text");
  });
  it("an address inside a code fence does NOT resolve", () => {
    expect(() => resolveAddress(CORPUS, ["not-a-header-inside-a-fence"])).toThrow(AddressResolutionError);
  });
  it("a non-existent address FAILS LOUD with the reason and the candidates, never empty", () => {
    try {
      resolveAddress(CORPUS, ["getting-started", "does-not-exist"]);
      expect.unreachable("resolution must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AddressResolutionError);
      const msg = (err as Error).message;
      expect(msg).toContain("getting-started/does-not-exist");
      expect(msg).toContain("install-the-cli"); // names the real candidates under the parent
    }
  });
});

describe("validateMarkdownAddressability — the compose gate", () => {
  it("flags a duplicate header-path", () => {
    const dup = ["## Setup", "a", "## Setup", "b"].join("\n");
    const findings = validateMarkdownAddressability(dup);
    expect(findings.some((f) => f.kind === "duplicate-header-path" && f.headerPath === "setup")).toBe(true);
  });
  it("flags a header whose slug is empty (unaddressable)", () => {
    const bad = ["## ???", "text"].join("\n");
    expect(validateMarkdownAddressability(bad).some((f) => f.kind === "unaddressable-header")).toBe(true);
  });
  it("passes the reference corpus clean", () => {
    expect(validateMarkdownAddressability(CORPUS)).toEqual([]);
  });

  it("r1 F1: an UNTERMINATED fence is a finding — a file that loses its sections to a stray fence never validates clean", () => {
    // r1's measured discriminator: the fence swallows beta and gamma; resolution
    // stays honest (addressing them fails loud) but the validator — whose job is
    // to catch unaddressability BEFORE compose — reported a clean file.
    const swallowed = "## alpha\nok\n```\n## beta\n## gamma\nstill in fence\n";
    const findings = validateMarkdownAddressability(swallowed);
    expect(findings.some((f) => f.kind === "unterminated-fence")).toBe(true);
  });

  it("r1 F2: an empty-slug H2 KEEPS its children (no silent promotion to top level), and the whole family is flagged", () => {
    // r1's measured discriminator: currentH2 holds a slug and "" is falsy, so an
    // emoji-only H2's children addressed at TOP level — a nested H3 reachable by
    // a top-level-looking address, silently.
    const text = "## 🚀\nparent body\n### kid\nkid body\n## real\nreal body\n";
    const sections = parseMarkdownSections(text);
    const kid = sections.find((s) => s.title === "kid")!;
    expect(kid.headerPath).toEqual(["", "kid"]); // stays under its (unaddressable) parent
    expect(() => resolveAddress(text, ["kid"])).toThrow(AddressResolutionError); // no top-level reach
    const findings = validateMarkdownAddressability(text);
    // Parent AND child are both named: the child's path carries an empty segment,
    // so no legal address can reach it — silence here would be silent content loss.
    expect(findings.filter((f) => f.kind === "unaddressable-header").length).toBe(2);
  });
});
