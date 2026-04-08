import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { execSync } from "node:child_process";

interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
}

async function resolveRigId(client: DaemonClient, rigName: string): Promise<string> {
  const res = await client.get<RigSummary[]>("/api/rigs/summary");
  const matches = res.data.filter((r) => r.name === rigName);

  if (matches.length === 0) {
    throw new Error(`Rig '${rigName}' not found. List rigs with: rig ps`);
  }
  if (matches.length > 1) {
    throw new Error(`Rig '${rigName}' is ambiguous — ${matches.length} rigs share that name. Use a unique name or remove duplicates.`);
  }

  return matches[0]!.id;
}

export function chatroomCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("chatroom").description("Chat room for rig communication");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient | null> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running. Start it with: rig daemon start");
      process.exitCode = 1;
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // chatroom send <rig> "message" [--sender <name>]
  cmd
    .command("send")
    .argument("<rig>", "Rig name")
    .argument("<message>", "Message to send")
    .option("--sender <name>", "Sender name", "cli")
    .action(async (rig: string, message: string, opts: { sender: string }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const res = await client.post<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/send`,
        { sender: opts.sender, body: message },
      );

      if (res.status >= 400) {
        console.error((res.data as Record<string, unknown>)["error"] ?? `Failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`[${opts.sender}] ${message}`);
    });

  // chatroom history <rig> [--topic <name>] [--limit N] [--json]
  cmd
    .command("history")
    .argument("<rig>", "Rig name")
    .option("--topic <name>", "Filter by topic")
    .option("--after <id>", "Messages after this message ID")
    .option("--since <timestamp>", "Messages since this timestamp")
    .option("--sender <name>", "Messages from this sender")
    .option("--limit <n>", "Limit results", "50")
    .option("--json", "JSON output")
    .action(async (rig: string, opts: { topic?: string; after?: string; since?: string; sender?: string; limit?: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const params = new URLSearchParams();
      if (opts.topic) params.set("topic", opts.topic);
      if (opts.after) params.set("after", opts.after);
      if (opts.since) params.set("since", opts.since);
      if (opts.sender) params.set("sender", opts.sender);
      if (opts.limit) params.set("limit", opts.limit);

      const qs = params.toString();
      const res = await client.get<Array<Record<string, unknown>>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/history${qs ? `?${qs}` : ""}`,
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }

      const messages = res.data;
      if (!Array.isArray(messages) || messages.length === 0) {
        console.log("No messages.");
        return;
      }

      for (const msg of messages) {
        const kind = msg["kind"] as string;
        if (kind === "topic") {
          console.log(`--- topic: ${msg["topic"]} ---`);
        } else {
          console.log(`[${msg["sender"]}] ${msg["body"]}`);
        }
      }
    });

  // chatroom watch <rig> [--tmux]
  cmd
    .command("watch")
    .argument("<rig>", "Rig name")
    .option("--tmux", "Run watch in a dedicated tmux session")
    .action(async (rig: string, opts: { tmux?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      if (opts.tmux) {
        const sessionName = `chatroom@${rig}`;
        try {
          execSync(`tmux new-session -d -s ${JSON.stringify(sessionName)} "rig chatroom watch ${JSON.stringify(rig)}"`, { stdio: "ignore" });
          console.log(`Started watch in tmux session: ${sessionName}`);
          console.log(`Attach with: tmux attach -t ${sessionName}`);
        } catch {
          console.error(`Failed to create tmux session '${sessionName}'. It may already exist.`);
          process.exitCode = 1;
        }
        return;
      }

      // Direct SSE watch
      const url = `${client.baseUrl}/api/rigs/${encodeURIComponent(rigId)}/chat/watch`;
      try {
        const res = await fetch(url, {
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok || !res.body) {
          console.error(`Watch failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              try {
                const msg = JSON.parse(data) as { sender: string; body: string; kind: string; topic?: string; createdAt: string };
                if (msg.kind === "topic") {
                  console.log(`--- topic: ${msg.topic} ---`);
                } else {
                  console.log(`[${msg.sender}] ${msg.body}`);
                }
              } catch {
                // Skip malformed data lines
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error(`Watch error: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }
    });

  // chatroom topic <rig> <topic-name> [--body "text"]
  cmd
    .command("topic")
    .argument("<rig>", "Rig name")
    .argument("<topic-name>", "Topic name")
    .option("--body <text>", "Optional body text")
    .option("--sender <name>", "Sender name", "cli")
    .action(async (rig: string, topicName: string, opts: { body?: string; sender: string }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const res = await client.post<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/chat/topic`,
        { sender: opts.sender, topic: topicName, body: opts.body },
      );

      if (res.status >= 400) {
        console.error((res.data as Record<string, unknown>)["error"] ?? `Failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`--- topic: ${topicName} ---`);
    });

  // chatroom wait <rig>
  cmd
    .command("wait")
    .argument("<rig>", "Rig name")
    .option("--after <id>", "Only messages after this ID")
    .option("--topic <name>", "Filter by topic")
    .option("--sender <name>", "Filter by sender")
    .option("--timeout <seconds>", "Timeout in seconds", "120")
    .option("--json", "JSON output")
    .action(async (rig: string, opts: { after?: string; topic?: string; sender?: string; timeout: string; json?: boolean }) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const timeoutMs = parseInt(opts.timeout, 10) * 1000;
      const pollIntervalMs = 3000;

      // Bootstrap cursor: use --after if provided, otherwise generate a ULID at start time
      // as a practical time-based baseline. Messages with IDs after this point are considered new.
      let cursor = opts.after ?? "";
      if (!cursor) {
        const { monotonicFactory } = await import("ulid");
        cursor = monotonicFactory()();
      }

      // Build filter params
      const filterParams = new URLSearchParams();
      if (opts.topic) filterParams.set("topic", opts.topic);
      if (opts.sender) filterParams.set("sender", opts.sender);

      const start = Date.now();
      while (true) {
        // Check timeout BEFORE polling
        if (Date.now() - start >= timeoutMs) break;

        const params = new URLSearchParams(filterParams);
        if (cursor) params.set("after", cursor);

        const res = await client.get<Array<Record<string, unknown>>>(
          `/api/rigs/${encodeURIComponent(rigId)}/chat/history?${params}`,
        );

        if (res.data && res.data.length > 0) {
          if (opts.json) {
            console.log(JSON.stringify(res.data));
          } else {
            for (const msg of res.data) {
              console.log(`[${msg["sender"]}] ${msg["body"]}`);
            }
          }
          return;
        }

        // Sleep with remaining timeout awareness
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
      }

      console.error(`Timed out after ${opts.timeout} seconds — no new messages matching filters.`);
      process.exitCode = 1;
    });

  // chatroom clear <rig>
  cmd
    .command("clear")
    .argument("<rig>", "Rig name")
    .action(async (rig: string) => {
      const client = await getClient();
      if (!client) return;

      let rigId: string;
      try {
        rigId = await resolveRigId(client, rig);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }

      const res = await client.post<{ ok: boolean; deleted: number }>(`/api/rigs/${encodeURIComponent(rigId)}/chat/clear`, {});

      if (res.status >= 400) {
        console.error(`Clear failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`Cleared ${res.data.deleted} messages from ${rig} chatroom.`);
    });

  return cmd;
}
