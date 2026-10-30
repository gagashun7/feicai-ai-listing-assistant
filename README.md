# feicai-ai-listing-assistant

**Move-Out Agent**: an AI agent that turns photos of an international student's room into a priced selling plan, built for the Meta Global AI Developer Hackathon.

Built during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026).

Feicai (feicai.vercel.app) is a pre-existing student marketplace. Everything in this repository was built during the hackathon, and no code from the existing Feicai codebase is included here.

Live demo: https://move-out-agent.vercel.app/

## The problem

International students often have only a few weeks to sell furniture, appliances and textbooks before moving out. Writing listings and guessing prices is slow, and the deadline changes the right price: an item that can wait three weeks should be priced differently from one that must go in three days.

## What it does

1. The student uploads photos of their room and enters a move-out date.
2. A Muse model identifies each sellable item and returns structured data (name, category, condition, description, ideal and quick-sale price).
3. If something that changes the price is unknown (for example how old a mattress is), the agent asks one short question.
4. A price-drop schedule is computed from the move-out date for every item.
5. The student reviews everything and exports ready-to-post listings.

## Status

| Feature | State |
|---|---|
| Web UI (upload, date, results, export), works on mobile | Done, tested in demo mode |
| Edge Function: image input, JSON-schema output, validation | Written, tested against a stand-in service; not yet run against the live model |
| Follow-up questions and re-analysis | UI done; live behaviour pending |
| Price-drop schedule from move-out date | Done (computed in code) |
| Spend protection (per-IP and total hourly limits) | Done, tested |
| Provider switch (Meta Model API or a hosted Muse Spark Open endpoint) | Done, tested with a stand-in service |
| Evaluation page (`eval.html`) | Done; real results pending |
| SAM 3.1 item cut-outs for listing photos | Planned |
| Voice input (Muse Voice Transcribe) | Planned |

This table is updated as features are finished and verified.

## Architecture

- `index.html`, `app.js`, `styles.css`: static front end, no framework.
- `eval.html`, `eval.js`: evaluation page. Run test rooms, grade each item by hand, and keep running totals (precision, price acceptance, recall). Sample data is never counted.
- `supabase/functions/analyze-room/index.ts`: Supabase Edge Function. Calls a Muse model (Chat Completions, image input, JSON-schema structured output), validates every field, and limits calls per hour. The API key exists only in the function's environment.
- `config.js`: public settings (function URL and Supabase public key). No secrets.

## Run it

Demo mode (no setup): open `index.html` in a browser.

Live mode:

1. Create a Supabase project and deploy the function from `supabase/functions/analyze-room`.
2. Set secrets (see `.env.example`): `MODEL_API_KEY`, and optionally `MOCK_MODE=true` to return sample data without calling a model.
3. Put the function URL and the Supabase public (anon) key in `config.js`.

Function settings (all optional): `MODEL_NAME`, `MODEL_API_URL`, `JSON_MODE` (`schema` or `prompt`), `LIMIT_PER_IP_PER_HOUR`, `LIMIT_TOTAL_PER_HOUR`.

## Built with

- Meta Model API (Muse Spark)
- Supabase Edge Functions
- Vercel (hosting)

## Notes

Prices are AI estimates for used goods, not guarantees. The price-drop schedule is deterministic and computed in code from the move-out date.

Long-term vision: storage and delivery for items that do not sell before the student leaves.
