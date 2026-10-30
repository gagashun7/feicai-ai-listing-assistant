// Supabase Edge Function: analyze-room
// Takes room photos + move-out date (+ optional seller answers),
// asks a Muse model (Meta Model API) to find sellable items, and returns structured JSON.
//
// The API key lives ONLY in this function's environment (MODEL_API_KEY). Never in the browser.
// If MODEL_API_KEY is not set (or MOCK_MODE=true) the function returns demo data, so the
// whole app can be built and tested without spending any credits.

// Provider settings (all optional). Defaults call the Meta Model API directly.
// To use a hosted Muse Spark Open endpoint instead (Baseten, Fireworks, Modal), set
// MODEL_API_URL (full .../chat/completions URL), MODEL_NAME, and MODEL_API_KEY as secrets.
const API_URL = Deno.env.get("MODEL_API_URL") ?? "https://api.meta.ai/v1/chat/completions";
const MODEL = Deno.env.get("MODEL_NAME") ?? "muse-spark-1.3"; // standard mode only
// "schema" (default) sends a JSON schema; "prompt" is for providers without schema support:
// the schema is described in the prompt and the reply is parsed leniently.
const JSON_MODE = Deno.env.get("JSON_MODE") ?? "schema";

const CATEGORIES = ["家具", "数码", "电器", "食品", "转租房", "其他"] as const;
const CONDITIONS = ["like_new", "good", "fair", "worn"] as const;

// Spend protection. The page is public, so cap real model calls. Counters live in memory
// (best effort: they reset when the function restarts), which is enough to stop casual abuse.
const LIMIT_PER_IP_PER_HOUR = Number(Deno.env.get("LIMIT_PER_IP_PER_HOUR") ?? "12");
const LIMIT_TOTAL_PER_HOUR = Number(Deno.env.get("LIMIT_TOTAL_PER_HOUR") ?? "150");
const hits = new Map<string, number[]>();

function allowCall(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - 3_600_000;
  for (const key of [ip, "*"]) {
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    hits.set(key, recent);
  }
  const mine = hits.get(ip)!;
  const all = hits.get("*")!;
  if (mine.length >= LIMIT_PER_IP_PER_HOUR || all.length >= LIMIT_TOTAL_PER_HOUR) return false;
  mine.push(now);
  all.push(now);
  return true;
}

const MAX_IMAGES = 4;
const MAX_BODY_BYTES = 12_000_000; // basic guard against huge uploads

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// JSON schema the model must follow (strict mode needs: every key required, no extra keys).
const ITEMS_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short item name, e.g. 'IKEA study desk'" },
          category: { type: "string", enum: [...CATEGORIES] },
          condition: { type: "string", enum: [...CONDITIONS] },
          confidence: { type: "number", description: "0 to 1: how sure you are about the item and its condition" },
          description: { type: "string", description: "2-3 sentence listing description for buyers" },
          price_ideal_usd: { type: "integer", description: "Fair asking price in USD if the seller has time" },
          price_quick_usd: { type: "integer", description: "Lower price likely to sell within days" },
          question: { type: "string", description: "One short question for the seller if key info is missing, otherwise empty string" },
        },
        required: [
          "name", "category", "condition", "confidence", "description",
          "price_ideal_usd", "price_quick_usd", "question",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You help international students in the US sell their belongings before moving out.
You are given photos of a room. Identify the individual items a student could realistically sell
(furniture, electronics, appliances, kitchen items, etc.). Skip walls, floors, built-in fixtures and clutter.
For each item give: a short name, one category from the allowed list, a condition judged from the photo,
a confidence score, a friendly 2-3 sentence listing description, an ideal price and a quick-sale price in USD.
Prices are estimates for used goods near a US university campus; keep them realistic and conservative.
Ask a question ONLY when something that changes the price is truly unknown (age, brand, working order).
Otherwise leave "question" as an empty string. Never invent brands or model numbers you cannot see.
If the seller already answered a question, use the answer and do not ask again.`;

type Item = {
  name: string; category: string; condition: string; confidence: number;
  description: string; price_ideal_usd: number; price_quick_usd: number; question: string;
};

function mockItems(): Item[] {
  return [
    {
      name: "Study desk", category: "家具", condition: "good", confidence: 0.86,
      description: "Sturdy wooden study desk with a smooth top, great for a dorm or apartment. Light wear on the edges.",
      price_ideal_usd: 45, price_quick_usd: 30, question: "",
    },
    {
      name: "Desk lamp", category: "电器", condition: "like_new", confidence: 0.78,
      description: "Adjustable LED desk lamp, works perfectly. Pick up on campus.",
      price_ideal_usd: 12, price_quick_usd: 8, question: "",
    },
    {
      name: "Mattress (twin)", category: "家具", condition: "fair", confidence: 0.52,
      description: "Twin-size mattress, clean and comfortable. Mattress topper not included.",
      price_ideal_usd: 60, price_quick_usd: 35, question: "How long have you used this mattress?",
    },
  ];
}

function clampItem(raw: Record<string, unknown>): Item | null {
  const category = String(raw.category ?? "");
  const condition = String(raw.condition ?? "");
  if (!(CATEGORIES as readonly string[]).includes(category)) return null;
  if (!(CONDITIONS as readonly string[]).includes(condition)) return null;
  const ideal = Math.max(0, Math.round(Number(raw.price_ideal_usd)));
  const quick = Math.max(0, Math.round(Number(raw.price_quick_usd)));
  if (!Number.isFinite(ideal) || !Number.isFinite(quick)) return null;
  return {
    name: String(raw.name ?? "").slice(0, 80),
    category,
    condition,
    confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
    description: String(raw.description ?? "").slice(0, 500),
    price_ideal_usd: Math.max(ideal, quick),
    price_quick_usd: Math.min(ideal, quick),
    question: String(raw.question ?? "").slice(0, 200),
  };
}

async function callModel(apiKey: string, images: string[], moveOutDate: string, daysLeft: number, answers: Record<string, string>) {
  const answerLines = Object.entries(answers)
    .map(([item, answer]) => `- ${item}: ${answer}`)
    .join("\n");
  const userText =
    `Move-out date: ${moveOutDate} (${daysLeft} days from now).\n` +
    (answerLines ? `Seller's answers to earlier questions:\n${answerLines}\n` : "") +
    "List the sellable items in these photos.";

  const promptMode = JSON_MODE === "prompt";
  const system = promptMode
    ? SYSTEM_PROMPT +
      "\n\nReply with ONLY a JSON object (no markdown) that matches this JSON schema:\n" +
      JSON.stringify(ITEMS_SCHEMA)
    : SYSTEM_PROMPT;

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ],
  };
  if (!promptMode) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "RoomItems", strict: true, schema: ITEMS_SCHEMA },
    };
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Do not echo upstream details to the browser; log them server-side only.
    console.error("Model API error", res.status, await res.text());
    throw new Error(`model_api_${res.status}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  if (!promptMode) return JSON.parse(content);
  // Lenient parse: strip code fences / surrounding text and take the outermost JSON object.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("no JSON object in reply");
  return JSON.parse(content.slice(start, end + 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  let payload: { images?: string[]; moveOutDate?: string; answers?: Record<string, string> };
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const images = (payload.images ?? []).slice(0, MAX_IMAGES);
  const moveOutDate = String(payload.moveOutDate ?? "");
  const answers = payload.answers ?? {};
  if (images.length === 0) return json({ error: "no_images" }, 400);
  if (!images.every((u) => typeof u === "string" && u.startsWith("data:image/"))) {
    return json({ error: "images_must_be_data_urls" }, 400);
  }

  const daysLeft = Math.max(
    0,
    Math.ceil((new Date(moveOutDate).getTime() - Date.now()) / 86_400_000) || 0,
  );

  const apiKey = Deno.env.get("MODEL_API_KEY");
  if (!apiKey || Deno.env.get("MOCK_MODE") === "true") {
    return json({ mode: "mock", items: mockItems() });
  }

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (!allowCall(ip)) return json({ error: "rate_limited" }, 429);

  try {
    let parsed;
    try {
      parsed = await callModel(apiKey, images, moveOutDate, daysLeft, answers);
    } catch (e) {
      // One retry for malformed JSON only; do not retry API/client errors (protects credits).
      if (e instanceof SyntaxError) {
        parsed = await callModel(apiKey, images, moveOutDate, daysLeft, answers);
      } else {
        throw e;
      }
    }
    const items = (parsed.items ?? [])
      .map((r: Record<string, unknown>) => clampItem(r))
      .filter((i: Item | null): i is Item => i !== null);
    return json({ mode: "live", items });
  } catch (e) {
    console.error(e);
    return json({ error: "analysis_failed" }, 502);
  }
});
