// Move-Out Agent: front end (plain JS, no framework).
// Flow: photos + move-out date -> Edge Function (Muse model) -> items with prices,
// follow-up questions, price-drop schedule -> export listings as JSON.

const CFG = window.APP_CONFIG || {};
const MAX_PHOTOS = 4;
const MAX_SIDE = 1280; // downscale photos before upload (smaller, cheaper, faster)

const CONDITION_LABEL = { like_new: "Like new", good: "Good", fair: "Fair", worn: "Worn" };
const CATEGORY_EN = { "家具": "Furniture", "数码": "Electronics", "电器": "Appliances", "食品": "Food", "转租房": "Sublease", "其他": "Other" };

const $ = (id) => document.getElementById(id);
const state = { images: [], items: [], answers: {}, moveOutDate: "" };

// ---------- helpers ----------
function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function daysUntil(dateStr) {
  const ms = new Date(dateStr + "T23:59:59").getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v; // textContent only: model output is never parsed as HTML
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function fileToResizedDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
    img.src = url;
  });
}

// ---------- pricing schedule (deterministic: computed in code, not by the model) ----------
function buildSchedule(ideal, quick, daysLeft) {
  if (daysLeft <= 3) {
    return [
      { when: "Now", text: `$${quick}` },
      { when: `Day ${Math.max(daysLeft - 1, 1)}`, text: "give away or donate" },
    ];
  }
  const mid = Math.round((ideal + quick) / 2);
  const d1 = Math.max(1, Math.floor(daysLeft * 0.4));
  const d2 = Math.max(d1 + 1, Math.floor(daysLeft * 0.75));
  const last = Math.max(d2 + 1, daysLeft - 2);
  return [
    { when: "Now", text: `$${ideal}` },
    { when: `Day ${d1}`, text: `$${mid}` },
    { when: `Day ${d2}`, text: `$${quick}` },
    { when: `Day ${last}`, text: "give away or donate" },
  ];
}

// ---------- API ----------
async function analyze() {
  if (!CFG.ANALYZE_URL) {
    // Demo mode: no backend configured, so show sample data. Lets the UI be built and tested for free.
    await new Promise((r) => setTimeout(r, 600));
    return { mode: "demo", items: DEMO_ITEMS.map((i) => ({ ...i })) };
  }
  const res = await fetch(CFG.ANALYZE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CFG.ANON_KEY}`,
      apikey: CFG.ANON_KEY,
    },
    body: JSON.stringify({ images: state.images, moveOutDate: state.moveOutDate, answers: state.answers }),
  });
  if (!res.ok) throw new Error("The analysis service returned an error. Please try again.");
  return res.json();
}

const DEMO_ITEMS = [
  { name: "Study desk", category: "家具", condition: "good", confidence: 0.86, description: "Sturdy wooden study desk with a smooth top. Light wear on the edges.", price_ideal_usd: 45, price_quick_usd: 30, question: "" },
  { name: "Desk lamp", category: "电器", condition: "like_new", confidence: 0.78, description: "Adjustable LED desk lamp, works perfectly.", price_ideal_usd: 12, price_quick_usd: 8, question: "" },
  { name: "Mattress (twin)", category: "家具", condition: "fair", confidence: 0.52, description: "Twin-size mattress, clean and comfortable.", price_ideal_usd: 60, price_quick_usd: 35, question: "How long have you used this mattress?" },
];

// ---------- rendering ----------
function render() {
  const daysLeft = daysUntil(state.moveOutDate);
  const list = $("items");
  list.replaceChildren();

  state.items.forEach((item, idx) => {
    const schedule = buildSchedule(item.price_ideal_usd, item.price_quick_usd, daysLeft);
    const card = el("div", { class: "item" }, [
      el("div", { class: "item-head" }, [
        el("span", { class: "item-name", text: item.name }),
        el("span", { class: "muted", text: `${Math.round(item.confidence * 100)}% sure` }),
      ]),
      el("div", { class: "tags" }, [
        el("span", { class: "tag", text: `${item.category} · ${CATEGORY_EN[item.category] || ""}` }),
        el("span", { class: "tag", text: CONDITION_LABEL[item.condition] || item.condition }),
      ]),
      el("p", { class: "desc", text: item.description }),
      el("div", { class: "prices" }, [
        el("div", { class: "price" }, [el("b", { text: `$${item.price_ideal_usd}` }), el("span", { text: "ideal price" })]),
        el("div", { class: "price" }, [el("b", { text: `$${item.price_quick_usd}` }), el("span", { text: "quick-sale price" })]),
      ]),
      el("ul", { class: "schedule" }, schedule.map((s) => el("li", { text: `${s.when}: ${s.text}` }))),
    ]);

    if (item.question && !state.answers[item.name]) {
      const input = el("input", { type: "text", placeholder: "Your answer", "aria-label": item.question });
      input.addEventListener("input", () => {
        if (input.value.trim()) state.pending = { ...(state.pending || {}), [item.name]: input.value.trim() };
        else if (state.pending) delete state.pending[item.name];
        $("refine").hidden = !(state.pending && Object.keys(state.pending).length);
      });
      card.append(el("div", { class: "ask" }, [el("div", { text: item.question }), input]));
    }
    list.append(card);
  });

  const total = state.items.reduce((s, i) => s + i.price_ideal_usd, 0);
  $("plan-summary").textContent =
    `${state.items.length} items found · about $${total} if everything sells at the ideal price · ${daysLeft} days until move-out`;
  $("step-results").hidden = false;
}

// ---------- export (same field names as the Feicai marketplace listing format) ----------
function exportListings() {
  const listings = state.items.map((i) => ({
    title: i.name,
    price: i.price_ideal_usd,
    currency: "USD",
    category: i.category,
    description: i.description,
    quick_sale_price: i.price_quick_usd,
  }));
  const blob = new Blob([JSON.stringify(listings, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: "listings.json" });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- events ----------
function updateButton() {
  $("analyze").disabled = !(state.images.length && $("move-date").value);
}

$("photos").addEventListener("change", async (e) => {
  const files = [...e.target.files].slice(0, MAX_PHOTOS);
  setStatus("Preparing photos…");
  try {
    state.images = await Promise.all(files.map(fileToResizedDataUrl));
    $("previews").replaceChildren(...state.images.map((src) => el("img", { src, alt: "Room photo" })));
    setStatus("");
  } catch (err) {
    state.images = [];
    setStatus(err.message, true);
  }
  updateButton();
});

$("move-date").addEventListener("change", updateButton);

async function run() {
  state.moveOutDate = $("move-date").value;
  $("analyze").disabled = true;
  $("refine").disabled = true;
  setStatus("Looking at your room…");
  try {
    const result = await analyze();
    state.items = result.items || [];
    state.pending = {};
    $("refine").hidden = true;
    if (!state.items.length) setStatus("No sellable items found. Try a clearer or wider photo.", true);
    else { setStatus(""); render(); }
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $("analyze").disabled = false;
    $("refine").disabled = false;
  }
}

$("analyze").addEventListener("click", () => { state.answers = {}; run(); });
$("refine").addEventListener("click", () => {
  Object.assign(state.answers, state.pending || {});
  run();
});
$("export").addEventListener("click", exportListings);

// default move-out date: 3 weeks from today
{
  const d = new Date(Date.now() + 21 * 86400000);
  $("move-date").value = d.toISOString().slice(0, 10);
}
if (!CFG.ANALYZE_URL) {
  const b = $("mode-banner");
  b.textContent = "Demo mode: no backend connected yet, so results are sample data.";
  b.hidden = false;
}
updateButton();
