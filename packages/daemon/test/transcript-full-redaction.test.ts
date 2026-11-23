import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { TRANSCRIPT_SECRET_PATTERNS, hasTranscriptSecret, redactTranscriptContent } from "../src/domain/transcript-redaction.js";
import * as surface from "../src/transcript-redaction-surface.js";

// The full-transcript route keeps the identifiers an agent needs (full commits, 64-hex hashes, long paths, ids)
// while masking explicit credential shapes. These cells run the production createApp, not a hand-built router.

const commit = "a".repeat(40);
const hash = "b".repeat(64);
const longPath = "/Users/example/code/rigs/lab/seats/security";
const hyphenatedPath = "/Users/example/code/rigs/lab/seats/security-reviewer/notes";
const row = "qitem-root-three-retraces-20261123T0823";
const shortSha = "e3b3d90c5";
// Synthetic credentials, assembled at run time so no source line holds a token-shaped literal. NOT real.
const apiKey = "sk-" + "Fake".repeat(5);
const bearer = "Bearer " + "Fake".repeat(8);
const privateKey = "-----BEGIN " + "PRIVATE KEY-----\n" + "MIIEv".repeat(13) + "\n-----END " + "PRIVATE KEY-----";
const encryptedKey = "-----BEGIN RSA " + "PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC," + "0A1B".repeat(8)
  + "\n\n" + "QUJDRA".repeat(13) + "\n-----END RSA " + "PRIVATE KEY-----";
const awsCliSecret = "wJalr" + "Z".repeat(35);
const urlPassword = "s3cr3t".repeat(8);

describe("transcript redaction keeps identifiers", () => {
  it("leaves commits, hashes, paths and ids unchanged", () => {
    for (const identifier of [commit, hash, longPath, hyphenatedPath, row, shortSha]) {
      expect(redactTranscriptContent(identifier), identifier).toBe(identifier);
      expect(hasTranscriptSecret(identifier), identifier).toBe(false);
    }
  });

  it("runs in linear time on repeated key headers and long runs of spaces", () => {
    // A lazy scan from each BEGIN line to an END line that never comes is quadratic: about 2 s here.
    const started = performance.now();
    redactTranscriptContent("-----BEGIN " + "PRIVATE KEY-----" + ("-----BEGIN " + "PRIVATE KEY-----a").repeat(20_000));
    redactTranscriptContent("aws_secret_access_key" + " ".repeat(200_000) + "x");
    redactTranscriptContent("-----BEGIN " + "PRIVATE KEY-----" + "\t".repeat(200_000) + "!");
    redactTranscriptContent("-----BEGIN " + "PRIVATE KEY-----\nProc-Type:" + "\t".repeat(200_000) + "!");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps the named context in front of a masked value", () => {
    expect(redactTranscriptContent("aws_secret_access_key = " + "wJalr" + "X".repeat(35))).toBe("aws_secret_access_key = [REDACTED]");
    expect(redactTranscriptContent("https://deploy:" + "hunter2hunter2" + "@git.example.com/r.git")).toBe("https://[REDACTED]@git.example.com/r.git");
    expect(redactTranscriptContent(`a ${privateKey} b`)).toBe("a [REDACTED] b");
  });

  it("handles a long unmatched AWS-secret formatting gap in linear time", () => {
    const text = "aws_secret_access_key" + " ".repeat(100_000);
    const started = performance.now();
    expect(redactTranscriptContent(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("masks named AWS secrets with wider formatting whitespace", () => {
    const value = "wJalr" + "X".repeat(35);
    for (const width of [0, 1, 8, 9, 32, 256]) {
      const context = `aws_secret_access_key${" ".repeat(width)}=${" ".repeat(width)}`;
      expect(redactTranscriptContent(context + value)).toBe(context + "[REDACTED]");
      expect(hasTranscriptSecret(context + value)).toBe(true);
    }
  });

  it("masks private keys inside JSON strings and encrypted keys, END line or not", () => {
    expect(redactTranscriptContent(JSON.stringify({ private_key: privateKey }))).toBe('{"private_key":"[REDACTED]"}');
    expect(redactTranscriptContent(JSON.stringify({ private_key: encryptedKey }))).toBe('{"private_key":"[REDACTED]"}');
    expect(redactTranscriptContent(`a ${encryptedKey} b`)).toBe("a [REDACTED] b");
    expect(redactTranscriptContent(encryptedKey.slice(0, encryptedKey.indexOf("\n-----END")))).toBe("[REDACTED]");
  });

  it("masks compact encrypted private keys without changing surrounding text", () => {
    const compact = encryptedKey.replaceAll("\n", "");
    expect(redactTranscriptContent(`left|${compact}|right`)).toBe("left|[REDACTED]|right");
    expect(redactTranscriptContent(compact.slice(0, compact.indexOf("-----END")))).toBe("[REDACTED]");
    expect(redactTranscriptContent(JSON.stringify({ private_key: compact }))).toBe('{"private_key":"[REDACTED]"}');
  });

  it("masks named credentials in AWS CLI output, Azure connection strings, Basic auth and password-only URLs", () => {
    const cases: Array<[string, string]> = [
      [`"SecretAccessKey": "${awsCliSecret}"`, '"SecretAccessKey": "[REDACTED]"'],
      [`"SessionToken": "${"FwoG" + "ZXIvYXdz".repeat(20)}"`, '"SessionToken": "[REDACTED]"'],
      [`aws_session_token = ${"IQoJ" + "b3JpZ2lu".repeat(10)}`, "aws_session_token = [REDACTED]"],
      [`AccountName=acct;AccountKey=${"Zm9vYmFy".repeat(11)}==;EndpointSuffix=core.windows.net`, "AccountName=acct;AccountKey=[REDACTED];EndpointSuffix=core.windows.net"],
      ["Authorization: Basic " + "ZGVwbG95" + "Omh1bnRlcjI=", "Authorization: Basic [REDACTED]"],
      [`https://:${urlPassword}@git.example.com/r.git`, "https://[REDACTED]@git.example.com/r.git"],
    ];
    for (const [text, masked] of cases) {
      expect(redactTranscriptContent(text), text).toBe(masked);
      expect(hasTranscriptSecret(text), text).toBe(true);
    }
    // A colon and "@" after the host aren't a password.
    expect(redactTranscriptContent("https://example.com?x=a:b@other#f")).toBe("https://example.com?x=a:b@other#f");
  });

  it("runs in linear time on JWT-shaped runs that never finish", () => {
    // Starting a JWT after every "-" of a run is quadratic: about 5 s on the first text.
    for (const text of ["eyJ-".repeat(25_000), "eyJ" + "a".repeat(100_000)]) {
      const started = performance.now();
      expect(redactTranscriptContent(text)).toBe(text);
      expect(hasTranscriptSecret(text)).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it("is the rule the CLI's restore packets import", () => {
    expect(surface.TRANSCRIPT_SECRET_PATTERNS).toBe(TRANSCRIPT_SECRET_PATTERNS);
    expect(surface.redactTranscriptContent).toBe(redactTranscriptContent);
  });
});

describe("GET /api/transcripts/:session/full through createApp", () => {
  let db: Database.Database;
  let root: string;

  beforeEach(() => {
    db = createFullTestDb();
    root = mkdtempSync(join(tmpdir(), "transcript-full-redaction-"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns identifiers as they were and masks credentials", async () => {
    const store = new TranscriptStore({ transcriptsRoot: root, enabled: true });
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { transcriptStore: store, appDeps: { transcriptStore: store } });
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    const awsSecret = "wJalr" + "Y".repeat(35);
    const awsContext = "aws_secret_access_key" + " ".repeat(12) + "=" + " ".repeat(12);
    store.ensureTranscriptDir("my-rig");
    writeFileSync(store.getTranscriptPath("my-rig", "dev-impl@my-rig"), [
      `merged ${commit} for ${row} (short ${shortSha})`,
      `tarball sha256 ${hash}`,
      `wrote ${longPath} and ${hyphenatedPath}`,
      `pasted ${apiKey} and ${bearer}`,
      privateKey,
      awsContext + awsSecret,
      `service account ${JSON.stringify({ private_key: privateKey })}`,
      encryptedKey,
      "compact encrypted " + encryptedKey.replaceAll("\n", ""),
      `{"Credentials": {"SecretAccessKey": "${awsCliSecret}"}}`,
      `cloned https://:${urlPassword}@git.example.com/r.git`,
      "trailing line",
    ].join("\n"));

    const res = await app.request("/api/transcripts/dev-impl@my-rig/full");
    expect(res.status).toBe(200);
    const body = await res.json() as { session: string; content: string };
    expect(body.session).toBe("dev-impl@my-rig");
    for (const identifier of [commit, hash, longPath, hyphenatedPath, row, shortSha]) {
      expect(body.content, identifier).toContain(identifier);
    }
    expect(body.content).not.toContain(awsSecret);
    expect(body.content).toContain(awsContext + "[REDACTED]");
    expect(body.content).not.toContain(apiKey);
    expect(body.content).not.toContain(bearer);
    expect(body.content).not.toContain("MIIEvMIIEv");
    expect(body.content).not.toContain("QUJDRAQUJDRA");
    expect(body.content).not.toContain(awsCliSecret);
    expect(body.content).toContain('"SecretAccessKey": "[REDACTED]"');
    expect(body.content).not.toContain(urlPassword);
    expect(body.content).toContain("https://[REDACTED]@git.example.com/r.git");
    expect(body.content).toContain("[REDACTED]");
    expect(body.content).toContain("trailing line");
  });
});
