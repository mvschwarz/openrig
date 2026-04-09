import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../src/domain/transcript-store.js";

describe("TranscriptStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getTranscriptPath", () => {
    it("returns deterministic {root}/{rigName}/{sessionName}.log", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const path = store.getTranscriptPath("my-rig", "dev.impl@my-rig");
      expect(path).toBe(join(tmpDir, "my-rig", "dev.impl@my-rig.log"));
    });
  });

  describe("ensureTranscriptDir", () => {
    it("creates nested directory structure and returns true", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const result = store.ensureTranscriptDir("my-rig");
      expect(result).toBe(true);
      expect(existsSync(join(tmpDir, "my-rig"))).toBe(true);
    });

    it("returns false on permission error without throwing", () => {
      const readonlyDir = join(tmpDir, "readonly");
      mkdirSync(readonlyDir);
      chmodSync(readonlyDir, 0o444);
      const store = new TranscriptStore({ transcriptsRoot: join(readonlyDir, "nested") });
      const result = store.ensureTranscriptDir("my-rig");
      expect(result).toBe(false);
      // Restore permissions for cleanup
      chmodSync(readonlyDir, 0o755);
    });
  });

  describe("writeBoundaryMarker", () => {
    it("appends marker with ISO timestamp to file and returns true", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      // Create an existing transcript file with prior content
      const filePath = store.getTranscriptPath("my-rig", "dev.impl@my-rig");
      writeFileSync(filePath, "prior content\n");

      const result = store.writeBoundaryMarker("my-rig", "dev.impl@my-rig", "restored from snapshot abc123");
      expect(result).toBe(true);

      const content = readFileSync(filePath, "utf-8");
      expect(content).toContain("prior content\n");
      expect(content).toMatch(/--- SESSION BOUNDARY: restored from snapshot abc123 at \d{4}-\d{2}-\d{2}T/);
      expect(content).toMatch(/---\n$/);
    });

    it("returns false on filesystem error without throwing", () => {
      const store = new TranscriptStore({ transcriptsRoot: join(tmpDir, "nonexistent", "deep") });
      // Directory doesn't exist, write will fail
      const result = store.writeBoundaryMarker("my-rig", "dev.impl@my-rig", "test");
      expect(result).toBe(false);
    });
  });

  describe("stripAnsi", () => {
    it("removes ANSI escape sequences from spike doc examples", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const raw = "\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m  \x1b[0m\x1b[27m\x1b[24m\x1b[Jmschwarz@mike-air /tmp % \x1b[K\x1b[?2004hecho 'test'\x1b[?2004l";
      const stripped = store.stripAnsi(raw);
      expect(stripped).not.toContain("\x1b[");
      expect(stripped).toContain("mschwarz@mike-air /tmp %");
      expect(stripped).toContain("echo 'test'");
    });

    it("preserves readability for real TUI cursor-motion output", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const raw = "\x1b[38;5;231m⏺\x1b[1C\x1b[39mTRANSCRIPT PROBE\x1b[1CACK\x1b[1C2026-03-31\r\x1b[2B\x1b[38;5;174m✳\x1b[39m \x1b[38;5;174mSchlepping… \x1b[39m                                                                   \r\x1b[1B   \r\x1b[2B\x1b[38;5;246m❯\u00a0\x1b[39m\x1b[7m \x1b[27m               \r\n\x1b]0;✳ Restore protocol start and read inventory\u0007\r\n\x1b[2C\x1b[38;5;246mesc\x1b[1Cto\x1b[1Cinterrupt\x1b[39m";
      const stripped = store.stripAnsi(raw);
      expect(stripped).toContain("TRANSCRIPT PROBE ACK 2026-03-31");
      expect(stripped).toContain("esc to interrupt");
      expect(stripped).not.toContain("\x1b");
      expect(stripped).not.toContain("]0;");
    });

    it("removes shell redraw noise from real transcript capture", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const raw = "printf 'TRACK_A_SMOKE_LINE\\nPNS-T06 marker\\n'\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m                                                                               \r  \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jmschwarz@mike-air rigged % \x1b[K\x1b[?2004hp\bprintf 'TRACK_A_SMOKE_LINE\\nPNS-T06 marker\\n'";
      const stripped = store.stripAnsi(raw);
      expect(stripped).toContain("mschwarz@mike-air rigged %");
      expect(stripped).toContain("printf 'TRACK_A_SMOKE_LINE\\nPNS-T06 marker\\n'");
      expect(stripped).not.toContain("pprintf");
      expect(stripped).not.toContain("\b");
      expect(stripped).not.toContain("\x1b");
    });
  });

  describe("enabled: false", () => {
    it("skips write operations but path resolution still works", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: false });
      expect(store.enabled).toBe(false);
      // Path resolution still works
      expect(store.getTranscriptPath("my-rig", "dev@my-rig")).toBe(join(tmpDir, "my-rig", "dev@my-rig.log"));
      // Write operations return false/skip
      expect(store.ensureTranscriptDir("my-rig")).toBe(false);
      expect(store.writeBoundaryMarker("my-rig", "dev@my-rig", "test")).toBe(false);
      // Directory was NOT created
      expect(existsSync(join(tmpDir, "my-rig"))).toBe(false);
    });
  });

  describe("path traversal safety", () => {
    it("rig name '..' does not resolve outside transcript root", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const path = store.getTranscriptPath("..", "dev@rig");
      // Path must stay under the root, not resolve to parent
      expect(path.startsWith(tmpDir + "/")).toBe(true);
    });

    it("ensureTranscriptDir with '..' rig name returns false", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const result = store.ensureTranscriptDir("..");
      expect(result).toBe(false);
    });
  });

  describe("readTail", () => {
    it("returns null on missing file without throwing", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const result = store.readTail("my-rig", "nonexistent-session", 10);
      expect(result).toBeNull();
    });

    it("returns last N lines with ANSI stripped", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(filePath, "line1\nline2\nline3\n\x1b[1mline4\x1b[0m\nline5\n");

      const result = store.readTail("my-rig", "dev@my-rig", 3);
      expect(result).not.toBeNull();
      const lines = result!.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("line3");
      expect(lines[1]).toBe("line4"); // ANSI stripped
      expect(lines[2]).toBe("line5");
    });

    it("strips shell prompt prefixes from tailed transcript lines", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(
        filePath,
        "mschwarz@mike-air rigged % echo SEND_ALPHA_OK\nSEND_ALPHA_OK\nmschwarz@mike-air rigged % \n",
      );

      const result = store.readTail("my-rig", "dev@my-rig", 5);

      expect(result).toBe("echo SEND_ALPHA_OK\nSEND_ALPHA_OK\n");
    });

    it("drops bare shell prompt lines from tailed transcript output", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(
        filePath,
        "echo OPS_SHELL_READY\n%\nmschwarz@mike-air rigged % \nmschwarz@mike-air rigged % echo RIG_BROADCAST_OK\nRIG_BROADCAST_OK\n",
      );

      const result = store.readTail("my-rig", "dev@my-rig", 10);

      expect(result).toBe("echo OPS_SHELL_READY\necho RIG_BROADCAST_OK\nRIG_BROADCAST_OK\n");
    });

    it("preserves terse legitimate output lines during tail cleanup", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(
        filePath,
        "mschwarz@mike-air rigged % echo ACK\nACK\nmschwarz@mike-air rigged % \n",
      );

      const result = store.readTail("my-rig", "dev@my-rig", 5);

      expect(result).toBe("echo ACK\nACK\n");
    });

    it("normalizes carriage-return prompt redraws before filtering shell prompt lines", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(
        filePath,
        "echo DEV_ALPHA_READY\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m\r  \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jmschwarz@mike-air rigged % \x1b[K\x1b[?2004hecho DEV_ALPHA_READY\x1b[?2004l\r\r\nDEV_ALPHA_READY\n",
      );

      const result = store.readTail("my-rig", "dev@my-rig", 10);

      expect(result).toBe("echo DEV_ALPHA_READY\nDEV_ALPHA_READY\n");
    });

    it("drops TUI chrome and redraw fragments from transcript tails", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(
        filePath,
        [
          "❯",
          "  ? for shortcuts",
          "  Round 2 drill from dev1.impl2@rigged-buildout",
          "❯ Round 2 drill from dev1.impl2@rigged-buildout",
          "· Quantumizing…",
          "───────────────────────────────────────────────────────────── rev1.r1@rigged-buildout ──",
          "  esc to interrupt",
          "✢",
          "✳",
          "✶",
          "✻",
          "✽",
          "  Q",
          "✻  u",
          "    a",
          "  Q  n",
          "✶  u  t",
          "    a  u",
          "✳    n  m",
          "      t  i",
          "✢      u  z",
          "        m  i",
          "·        i  n",
          "          z  g",
          "           i  …",
          "⏺ Acknowledged. I see impl2's round 2 drill is running — their capture showed them",
          "  executing rig whoami --json when I captured their pane.",
        ].join("\n") + "\n",
      );

      const result = store.readTail("my-rig", "dev@my-rig", 20);

      expect(result).toContain("Round 2 drill from dev1.impl2@rigged-buildout");
      expect(result).toContain("Quantumizing…");
      expect(result).toContain("Acknowledged. I see impl2's round 2 drill is running");
      expect(result).not.toContain("? for shortcuts");
      expect(result).not.toContain("esc to interrupt");
      expect(result).not.toContain("rev1.r1@rigged-buildout ──");
      expect(result).not.toContain("\n✢\n");
      expect(result).not.toContain("Q  n");
      expect(result).not.toContain("u  z");
    });
  });

  describe("grep", () => {
    it("returns matching lines with ANSI stripped", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(filePath, "hello world\n\x1b[1mdecision made\x1b[0m\nfoo bar\ndecision final\n");

      const result = store.grep("my-rig", "dev@my-rig", "decision");
      expect(result).not.toBeNull();
      expect(result).toHaveLength(2);
      expect(result![0]).toBe("decision made"); // ANSI stripped
      expect(result![1]).toBe("decision final");
    });

    it("matches against stripped logical lines from noisy shell capture", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("my-rig");
      const filePath = store.getTranscriptPath("my-rig", "dev@my-rig");
      writeFileSync(
        filePath,
        "printf 'TRACK_A_SMOKE_LINE\\nPNS-T06 marker\\n'\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m                                                                                \r  \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jmschwarz@mike-air rigged % \x1b[K\x1b[?2004hprintf 'TRACK_A_GROWTH_LINE\\\\n'\n",
      );

      const result = store.grep("my-rig", "dev@my-rig", "TRACK_A_GROWTH_LINE");
      expect(result).toEqual(["printf 'TRACK_A_GROWTH_LINE\\\\n'"]);
    });

    it("returns null on missing file without throwing", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      const result = store.grep("my-rig", "nonexistent", "pattern");
      expect(result).toBeNull();
    });
  });

  describe("large file performance", () => {
    function writeLargeTranscript(filePath: string, totalLines: number, markerEvery: number) {
      const chunks: string[] = [];
      for (let i = 0; i < totalLines; i++) {
        if (i > 0 && i % markerEvery === 0) {
          chunks.push(`MARKER_LINE_${i}`);
        } else {
          chunks.push(`line ${i}: ${"x".repeat(80)}`);
        }
      }
      writeFileSync(filePath, chunks.join("\n") + "\n");
    }

    it("readTail returns enough lines even when most raw lines are prompt noise", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("noisy-rig");
      const filePath = store.getTranscriptPath("noisy-rig", "dev@noisy-rig");
      // 8 prompt noise lines + 2 real lines
      const lines = [
        "mschwarz@mike-air rigged % ",
        "mschwarz@mike-air rigged % ",
        "KEEP_ONE",
        "mschwarz@mike-air rigged % ",
        "mschwarz@mike-air rigged % ",
        "mschwarz@mike-air rigged % ",
        "mschwarz@mike-air rigged % ",
        "mschwarz@mike-air rigged % ",
        "mschwarz@mike-air rigged % ",
        "KEEP_TWO",
      ];
      writeFileSync(filePath, lines.join("\n") + "\n");
      const result = store.readTail("noisy-rig", "dev@noisy-rig", 2);
      expect(result).toContain("KEEP_ONE");
      expect(result).toContain("KEEP_TWO");
    });

    it("readTail handles multibyte UTF-8 characters at chunk boundaries", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("utf8-rig");
      const filePath = store.getTranscriptPath("utf8-rig", "dev.tail@utf8-rig");
      // Write enough padding to push the multibyte char near a chunk boundary
      const padding = "X".repeat(16 * 1024 - 5); // just before 16KB boundary
      writeFileSync(filePath, padding + "\ncafé résumé\nlast line\n");
      const result = store.readTail("utf8-rig", "dev.tail@utf8-rig", 2);
      expect(result).not.toBeNull();
      expect(result).toContain("café");
      expect(result).toContain("last line");
    });

    it("grep matches multibyte UTF-8 characters correctly", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("utf8-rig");
      const filePath = store.getTranscriptPath("utf8-rig", "dev@utf8-rig");
      // Write lines with multibyte characters
      writeFileSync(filePath, "hello world\ncafé résumé\nnormal line\nüber important\n");
      const result = store.grep("utf8-rig", "dev@utf8-rig", "é");
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0]).toContain("café");
    });

    it("readTail on large file returns correct last N lines without reading entire file", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("big-rig");
      const filePath = store.getTranscriptPath("big-rig", "dev@big-rig");
      writeLargeTranscript(filePath, 50000, 10000);

      const result = store.readTail("big-rig", "dev@big-rig", 5);
      expect(result).not.toBeNull();
      const lines = result!.split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines.length).toBeGreaterThan(0);
      // Last lines should be from the end of the file
      expect(lines[lines.length - 1]).toContain("49999");
    });

    it("grep on large file returns only matching lines without loading entire file", () => {
      const store = new TranscriptStore({ transcriptsRoot: tmpDir });
      store.ensureTranscriptDir("big-rig");
      const filePath = store.getTranscriptPath("big-rig", "dev@big-rig");
      writeLargeTranscript(filePath, 50000, 10000);

      const result = store.grep("big-rig", "dev@big-rig", "MARKER_LINE");
      expect(result).not.toBeNull();
      // Should find markers at 10000, 20000, 30000, 40000
      expect(result!.length).toBe(4);
      expect(result![0]).toBe("MARKER_LINE_10000");
      expect(result![3]).toBe("MARKER_LINE_40000");
    });
  });
});
