// Evaluation page: run test rooms through the agent, grade each item by hand,
// and keep running totals (item precision, price acceptance, recall).
const CFG = window.APP_CONFIG || {};
const MAX_PHOTOS = 4;
const MAX_SIDE = 1280;
const STORE_KEY = "moveout-eval-v1";

const $ = (id) => document.getElementById(id);
const state = { images: [], items: [], grades: [] };

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function save(runs) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(runs)); } catch { /* storage may be blocked; totals still show for this session */ }
}
let runs = load();

function resize(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
    img.src = url;
  });
}

const DEMO = [
  { name: "Study desk", price_ideal_usd: 45, price_quick_usd: 30, confidence: 0.86 },
  { name: "Desk lamp", price_ideal_usd: 12, price_quick_usd: 8, confidence: 0.78 },
  { name: "Mattress (twin)", price_ideal_usd: 60, price_quick_usd: 35, confidence: 0.52 },
];

async function analyze() {
  if (!CFG.ANALYZE_URL) { await new Promise((r) => setTimeout(r, 400)); return { mode: "demo", items: DEMO }; }
  const res = await fetch(CFG.ANALYZE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.ANON_KEY}`, apikey: CFG.ANON_KEY },
    body: JSON.stringify({ images: state.images, moveOutDate: $("move-date").value, answers: {} }),
  });
  if (!res.ok) throw new Error("The analysis service returned an error.");
  return res.json();
}

function renderGrading(mode) {
  const box = $("grade-items");
  box.replaceChildren();
  state.grades = state.items.map(() => ({ real: false, price_ok: false }));
  state.items.forEach((item, i) => {
    const real = el("input", { type: "checkbox", id: `real-${i}` });
    const price = el("input", { type: "checkbox", id: `price-${i}` });
    real.addEventListener("change", () => { state.grades[i].real = real.checked; });
    price.addEventListener("change", () => { state.grades[i].price_ok = price.checked; });
    box.append(el("div", { class: "item" }, [
      el("div", { class: "item-head" }, [
        el("span", { class: "item-name", text: item.name }),
        el("span", { class: "muted", text: `ideal $${item.price_ideal_usd} · quick $${item.price_quick_usd}` }),
      ]),
      el("label", {}, [real, document.createTextNode(" It is really in the photos")]),
      el("br"),
      el("label", {}, [price, document.createTextNode(" I would accept this price as a starting point")]),
    ]));
  });
  $("missed").value = 0;
  $("grade-card").hidden = false;
  $("mode-banner").hidden = mode !== "demo" && mode !== "mock";
  if (mode === "demo" || mode === "mock") {
    $("mode-banner").textContent = "Sample data: these results are NOT model output. Do not grade them for the real evaluation.";
  }
}

function totals() {
  const t = runs.reduce((a, r) => {
    a.rooms += 1; a.found += r.found; a.real += r.real; a.priceOk += r.priceOk; a.missed += r.missed;
    return a;
  }, { rooms: 0, found: 0, real: 0, priceOk: 0, missed: 0 });
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
  return {
    ...t,
    precision: pct(t.real, t.found),
    priceAccept: pct(t.priceOk, t.found),
    recall: pct(t.real, t.real + t.missed),
  };
}

function renderTotals() {
  const t = totals();
  const box = $("totals");
  if (!t.rooms) { box.textContent = "No rooms graded yet."; return; }
  box.replaceChildren(
    el("p", { text: `${t.rooms} rooms · ${t.found} items found by the agent` }),
    el("p", { text: `Items really present (precision): ${t.precision}  (${t.real}/${t.found})` }),
    el("p", { text: `Prices accepted as a starting point: ${t.priceAccept}  (${t.priceOk}/${t.found})` }),
    el("p", { text: `Sellable items found (recall): ${t.recall}  (${t.real} found, ${t.missed} missed)` }),
  );
}

$("photos").addEventListener("change", async (e) => {
  const files = [...e.target.files].slice(0, MAX_PHOTOS);
  try {
    state.images = await Promise.all(files.map(resize));
    $("previews").replaceChildren(...state.images.map((src) => el("img", { src, alt: "Test photo" })));
    setStatus("");
  } catch (err) { state.images = []; setStatus(err.message, true); }
  $("run").disabled = !(state.images.length && $("move-date").value);
});
$("move-date").addEventListener("change", () => { $("run").disabled = !(state.images.length && $("move-date").value); });

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  setStatus("Running…");
  try {
    const out = await analyze();
    state.items = out.items || [];
    state.mode = out.mode;
    if (!state.items.length) { setStatus("No items found in this room (that counts: grade 0 found and enter the missed items).", true); }
    else setStatus("");
    renderGrading(out.mode);
  } catch (err) { setStatus(err.message, true); }
  finally { $("run").disabled = false; }
});

$("save").addEventListener("click", () => {
  if (state.mode === "demo" || state.mode === "mock") { setStatus("Not saved: sample data is not a real model result.", true); return; }
  runs.push({
    found: state.items.length,
    real: state.grades.filter((g) => g.real).length,
    priceOk: state.grades.filter((g) => g.price_ok).length,
    missed: Math.max(0, parseInt($("missed").value, 10) || 0),
  });
  save(runs);
  $("grade-card").hidden = true;
  setStatus("Saved.");
  renderTotals();
});

$("copy").addEventListener("click", async () => {
  const t = totals();
  const text = `${t.rooms} rooms, ${t.found} items. Precision ${t.precision}, price accepted ${t.priceAccept}, recall ${t.recall}.`;
  try { await navigator.clipboard.writeText(text); setStatus("Copied."); } catch { setStatus(text); }
});
$("reset").addEventListener("click", () => { runs = []; save(runs); renderTotals(); });

$("move-date").value = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
renderTotals();
