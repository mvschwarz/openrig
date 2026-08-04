#!/usr/bin/env node
// OpenRig Claude Status Line Context Collector
// Reads Claude status line JSON from stdin, extracts context window data,
// and writes atomically to a sidecar file.
//
// Usage: node claude-statusline-context.js <context-output-path-or-dir> [provider-usage-dir]

const fs = require("fs");
const path = require("path");

const outputTarget = process.argv[2];
const providerUsageTarget = process.argv[3];
if (!outputTarget) {
  process.exit(0); // No output path — silently exit
}

function logFailure(message, error) {
  const suffix = error && error.message ? `: ${error.message}` : "";
  console.error(`[openrig][collector] ${message}${suffix}`);
}

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const raw = JSON.parse(input);
    const contextWindow = raw.context_window;
    if (!contextWindow) {
      logFailure("missing context_window in Claude status line payload");
      process.exit(0);
    }

    const sample = {
      context_window: {
        context_window_size: contextWindow.context_window_size ?? null,
        used_percentage: contextWindow.used_percentage ?? null,
        remaining_percentage: contextWindow.remaining_percentage ?? null,
        total_input_tokens: contextWindow.total_input_tokens ?? null,
        total_output_tokens: contextWindow.total_output_tokens ?? null,
        current_usage: contextWindow.current_usage ?? null,
      },
      session_id: raw.session_id ?? null,
      session_name: raw.session_name ?? null,
      transcript_path: raw.transcript_path ?? null,
      sampled_at: new Date().toISOString(),
    };

    const outputPath = resolveOutputPath(outputTarget, raw);
    if (!outputPath) {
      logFailure("could not resolve output path from Claude status line payload");
      process.exit(0);
    }

    writeJsonAtomic(outputPath, sample);

    if (providerUsageTarget) {
      const providerUsagePath = resolveOutputPath(providerUsageTarget, raw);
      if (!providerUsagePath) {
        logFailure("could not resolve provider_usage output path from Claude status line payload");
        process.exit(0);
      }
      const rateLimits = normalizeRateLimits(raw.rate_limits);
      const providerUsage = {
        seatSession: raw.session_name || raw.session_id,
        asOf: new Date().toISOString(),
        ...(rateLimits ? { accountKind: "subscription", rateLimits } : {}),
      };
      writeJsonAtomic(providerUsagePath, providerUsage);
    }
  } catch (error) {
    logFailure("failed to collect Claude context status line", error);
    process.exit(0);
  }
});

function resolveOutputPath(target, raw) {
  if (target.endsWith(".json")) {
    return target;
  }

  const sessionKey = raw.session_name || raw.session_id;
  if (!sessionKey) {
    return null;
  }

  const safe = String(sessionKey).replace(/[^a-zA-Z0-9@._-]/g, "_");
  return path.join(target, safe + ".json");
}

function normalizeRateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["five_hour", "seven_day"]) {
    const window = value[key];
    if (!window || typeof window !== "object" || Array.isArray(window)) continue;
    if (typeof window.used_percentage !== "number" || !Number.isFinite(window.used_percentage)
      || typeof window.resets_at !== "string") continue;
    result[key] = { usedPercent: window.used_percentage, resetsAt: window.resets_at };
  }
  return result.five_hour || result.seven_day ? result : null;
}

function writeJsonAtomic(outputPath, value) {
  const tmpPath = outputPath + ".tmp";
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tmpPath, JSON.stringify(value), "utf-8");
  fs.renameSync(tmpPath, outputPath);
}
