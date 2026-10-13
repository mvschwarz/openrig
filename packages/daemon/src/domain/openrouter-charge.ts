// OPR.0.7.0.2 (cost reporting, K4): OpenRouter's actual charge for a Pi request, beside Pi's model-priced estimate.
//
// Contract (OpenRouter's official API reference, "Get a generation"): GET https://openrouter.ai/api/v1/generation
// ?id=<generation id>, Bearer API key. The id matches ^gen-[0-9A-Za-z-]+$ (at most 128). The reply's
// `data.total_cost` is the generation's total cost in USD; `data` also names the generation (`id`), the
// `model`, `provider_name`, `api_type`, `is_byok`, `upstream_inference_cost`, `cache_discount`, `workspace_id`
// and `created_at`.
//
// Which requests this covers: Pi 0.87.1 records a chat completion's `id` as the assistant message's
// `responseId` (openai-completions API), and OpenRouter's usage-accounting guide uses that `id` for this
// lookup. Pi's anthropic-messages API records `message_start.message.id` instead, which OpenRouter does not
// document as a generation id, so those requests are not looked up ("not covered"), never guessed.

export const OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation";
const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/;

/** A charge outcome for one Pi entry. `charged` is final; `unavailable` says why there is no charge. */
export type PiProviderCharge = {
  entryId: string;
  generationId: string;
  status: "charged" | "unavailable";
  /** OpenRouter's data.total_cost, in USD. */
  totalCostUsd: number | null;
  upstreamInferenceCostUsd: number | null;
  cacheDiscountUsd: number | null;
  isByok: boolean | null;
  providerName: string | null;
  model: string | null;
  apiType: string | null;
  workspaceId: string | null;
  generationCreatedAt: string | null;
  /** The credential that generated the request and made the lookup (a name, never a value). */
  credentialSource: string;
  reason: string | null;
};

/** Whether a Pi entry is a request this lookup covers, and if not, why. */
export function openRouterChargeTarget(fact: { kind: string; provider: string | null; api?: string | null; responseId?: string | null }):
  { generationId: string } | { notCovered: string } {
  if (fact.kind !== "assistant" || fact.provider !== "openrouter") return { notCovered: "not an OpenRouter request" };
  if (fact.api !== "openai-completions") return { notCovered: `Pi's ${fact.api ?? "unknown"} API: its response id isn't a documented OpenRouter generation id` };
  if (!fact.responseId || !GENERATION_ID.test(fact.responseId)) return { notCovered: "no OpenRouter generation id recorded" };
  return { generationId: fact.responseId };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** The longest reply text kept (model, provider, workspace, api type, timestamp); longer text isn't kept. */
export const OPENROUTER_TEXT_LIMIT = 256;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= OPENROUTER_TEXT_LIMIT ? v : null);

/** OpenRouter's reply for one generation, checked against the generation asked about. */
export function parseOpenRouterGeneration(body: unknown, generationId: string):
  { ok: true; fields: Omit<PiProviderCharge, "entryId" | "generationId" | "status" | "credentialSource" | "reason"> } | { ok: false; reason: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed reply" };
  const data = (body as Record<string, unknown>)["data"];
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "malformed reply" };
  const d = data as Record<string, unknown>;
  if (d["id"] !== generationId) return { ok: false, reason: "the reply names a different generation" };
  const total = num(d["total_cost"]);
  if (total === null || total < 0) return { ok: false, reason: "malformed reply: no total_cost" };
  return {
    ok: true,
    fields: {
      totalCostUsd: total,
      upstreamInferenceCostUsd: num(d["upstream_inference_cost"]),
      cacheDiscountUsd: num(d["cache_discount"]),
      isByok: typeof d["is_byok"] === "boolean" ? d["is_byok"] : null,
      providerName: str(d["provider_name"]),
      model: str(d["model"]),
      apiType: str(d["api_type"]),
      workspaceId: str(d["workspace_id"]),
      generationCreatedAt: str(d["created_at"]),
    },
  };
}
