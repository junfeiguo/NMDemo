// Namak Mandi assistant: Cloudflare Worker that sits between the website and the Claude API.
// The API key lives here as a secret, never in the website code.
//
// POST /chat   body: { messages: [{role:"user"|"assistant", content:"..."}], mode: "chat" | "voice" }
//              reply: { reply: "text", submitted: [{type:"booking"|"order", ok:true|false}] }
import { KB } from "./kb.js";
import { buildPrompt } from "./prompt.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_TURNS = 20, MAX_CHARS = 1500, MAX_LOOPS = 5;
const hits = new Map(); // best-effort per-isolate rate limit; also add a Cloudflare rate limiting rule

/* ---------- time helpers (London) ---------- */
function londonNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short"
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  const hh = g("hour") === "24" ? "00" : g("hour");
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${hh}:${g("minute")}`, weekday: g("weekday") };
}
function dayKey(iso) { return DAYS[new Date(iso + "T12:00:00Z").getUTCDay()]; }
function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function toMin(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fmtDate(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }); }

/* ---------- prompt ---------- */
function systemPrompt(mode) {
  const n = londonNow();
  return buildPrompt(mode, `${n.weekday} ${fmtDate(n.date)} (${n.date}), ${n.time} London time`);
}

/* ---------- tools ---------- */
const TOOLS = [
  {
    name: "submit_booking",
    description: "Send a table booking request to the restaurant. Only call after the guest has confirmed all details read back to them.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, phone: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24 hour" },
        guests: { type: "integer", minimum: 1, maximum: 20 },
        seating: { type: "string", enum: ["table", "floor"] },
        notes: { type: "string", description: "Allergies, celebrations, other requests" }
      },
      required: ["name", "phone", "date", "time", "guests", "seating"]
    }
  },
  {
    name: "submit_order",
    description: "Send a collection order request to the restaurant. Only call after the guest has confirmed the items and pickup time read back to them.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" }, phone: { type: "string" },
        items: {
          type: "array", minItems: 1, maxItems: 30,
          items: {
            type: "object",
            properties: { id: { type: "string" }, size: { type: "string", description: "Size label exactly as on the menu" }, qty: { type: "integer", minimum: 1, maximum: 20 } },
            required: ["id", "qty"]
          }
        },
        pickup: { type: "string", description: "'asap' or 'YYYY-MM-DD HH:MM'" },
        notes: { type: "string" }
      },
      required: ["name", "phone", "items", "pickup"]
    }
  }
];

function cleanPhone(p) { const d = String(p || "").replace(/[^\d+]/g, ""); const digits = d.replace(/\D/g, ""); return digits.length >= 10 && digits.length <= 13 ? d : null; }
function cleanText(s, n) { return String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); }

function checkSlot(date, time, needHourRule) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return "Date must be YYYY-MM-DD.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) return "Time must be HH:MM.";
  const now = londonNow();
  if (date < now.date) return "That date has already passed.";
  if (date > addDays(now.date, 60)) return "We take bookings up to 60 days ahead.";
  const hrs = KB.hours[dayKey(date)];
  const t = toMin(time);
  if (t < hrs[0] * 60) return `We open at ${hrs[0]}:00 on that day.`;
  if (needHourRule && t > toMin(KB.lastBookingTime)) return `The last booking time is ${KB.lastBookingTime}.`;
  if (t >= hrs[1] * 60) return "That is after closing time.";
  if (date === now.date && t < toMin(now.time) + 30) return "That time is too soon. Please choose a time at least 30 minutes from now, or phone the restaurant.";
  return null;
}

async function notify(env, subject, text) {
  let ok = false;
  if (env.NOTIFY_WEBHOOK) {
    try {
      const r = await fetch(env.NOTIFY_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${subject}\n${text}`.slice(0, 1900), text: `${subject}\n${text}` }) });
      ok = ok || r.ok;
    } catch (e) { /* ignore */ }
  }
  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL && env.FROM_EMAIL) {
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.RESEND_API_KEY }, body: JSON.stringify({ from: env.FROM_EMAIL, to: [env.NOTIFY_EMAIL], subject, text }) });
      ok = ok || r.ok;
    } catch (e) { /* ignore */ }
  }
  return ok;
}

async function runTool(name, input, env, state) {
  if (state.submitted >= 1) return { ok: false, error: "A request has already been sent in this conversation. Ask the guest to phone the restaurant for changes." };
  input = input || {};
  if (name === "submit_booking") {
    const guests = Number(input.guests);
    if (!Number.isInteger(guests) || guests < 1) return { ok: false, error: "Number of guests is invalid." };
    if (guests > 20) return { ok: false, error: `Groups over 20 go through the events team: ${KB.eventsPhone}, ${KB.eventsEmail}.` };
    const phone = cleanPhone(input.phone), nm = cleanText(input.name, 60);
    if (!nm) return { ok: false, error: "Name is missing." };
    if (!phone) return { ok: false, error: "The phone number does not look valid. Ask the guest to repeat it." };
    const bad = checkSlot(input.date, input.time, true);
    if (bad) return { ok: false, error: bad };
    const seating = input.seating === "floor" ? "Floor seating" : "Table and chairs";
    const text = `Name: ${nm}\nPhone: ${phone}\nDate: ${fmtDate(input.date)} (${input.date})\nTime: ${input.time}\nGuests: ${guests}\nSeating: ${seating}\nNotes: ${cleanText(input.notes, 300) || "none"}\n\nSent by the website assistant. Please confirm with the guest.`;
    const sent = await notify(env, "NEW TABLE BOOKING REQUEST", text);
    state.log.push({ type: "booking", ok: sent });
    if (sent) state.submitted++;
    return sent ? { ok: true, status: "sent_to_restaurant_awaiting_confirmation" } : { ok: false, error: `The request could not be delivered. Ask the guest to phone ${KB.phone}.` };
  }
  if (name === "submit_order") {
    const nm = cleanText(input.name, 60), phone = cleanPhone(input.phone);
    if (!nm) return { ok: false, error: "Name is missing." };
    if (!phone) return { ok: false, error: "The phone number does not look valid. Ask the guest to repeat it." };
    if (!Array.isArray(input.items) || !input.items.length) return { ok: false, error: "No items." };
    const byId = Object.fromEntries(KB.menu.map((m) => [m.id, m]));
    let total = 0, hasSajji = false; const lines = [];
    for (const it of input.items.slice(0, 30)) {
      const m = byId[it && it.id]; const qty = Number(it && it.qty);
      if (!m) return { ok: false, error: `Unknown item id "${it && it.id}". Use ids from the menu list.` };
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { ok: false, error: `Quantity for ${m.name} is invalid.` };
      let v = m.variants[0];
      if (it.size) { v = m.variants.find((x) => x.label.toLowerCase() === String(it.size).toLowerCase()); if (!v) return { ok: false, error: `${m.name} sizes: ${m.variants.map((x) => x.label).join(", ")}.` }; }
      else if (m.variants.length > 1) return { ok: false, error: `${m.name} has several sizes: ${m.variants.map((x) => x.label + " £" + x.price.toFixed(2)).join(", ")}. Ask which one.` };
      if (m.preorder) hasSajji = true;
      total += v.price * qty; lines.push(`${qty} x ${m.name} (${v.label}) £${(v.price * qty).toFixed(2)}`);
    }
    let when = "As soon as possible";
    const now = londonNow();
    if (String(input.pickup).toLowerCase() !== "asap") {
      const m = String(input.pickup).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
      if (!m) return { ok: false, error: "Pickup must be 'asap' or 'YYYY-MM-DD HH:MM'." };
      const bad = checkSlot(m[1], m[2], false); if (bad) return { ok: false, error: bad };
      when = `${fmtDate(m[1])} at ${m[2]}`;
      if (hasSajji && m[1] <= now.date) return { ok: false, error: "Lamb Sajji needs at least one day's notice. Choose a pickup date after today." };
    } else if (hasSajji) return { ok: false, error: "Lamb Sajji needs at least one day's notice. Ask for a pickup date after today." };
    else {
      const hrs = KB.hours[dayKey(now.date)], t = toMin(now.time);
      if (t < hrs[0] * 60 || t >= hrs[1] * 60 - 20) return { ok: false, error: "The restaurant is closed or about to close. Ask the guest to choose a pickup time when we are open." };
    }
    const text = `Name: ${nm}\nPhone: ${phone}\nCollection: ${when}\n\n${lines.join("\n")}\nTotal at dine-in prices: £${total.toFixed(2)} (pay on collection; collection prices may differ slightly)\nNotes: ${cleanText(input.notes, 300) || "none"}\n\nSent by the website assistant. Please confirm with the guest.`;
    const sent = await notify(env, "NEW COLLECTION ORDER REQUEST", text);
    state.log.push({ type: "order", ok: sent });
    if (sent) state.submitted++;
    return sent ? { ok: true, status: "sent_to_restaurant_awaiting_confirmation", total: "£" + total.toFixed(2), items: lines } : { ok: false, error: `The request could not be delivered. Ask the guest to phone ${KB.phone}.` };
  }
  return { ok: false, error: "Unknown tool." };
}

/* ---------- HTTP ---------- */
function cors(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || "https://junfeiguo.github.io").split(",").map((s) => s.trim());
  if (!origin || allowed.indexOf(origin) < 0) return null;
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "vary": "Origin" };
}
const json = (o, status, h) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ "content-type": "application/json" }, h || {}) });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin");
    const ch = cors(env, origin);
    if (req.method === "OPTIONS") return ch ? new Response(null, { status: 204, headers: ch }) : new Response(null, { status: 403 });
    const url = new URL(req.url);
    // Server-to-server endpoint for a phone voice platform's "custom tool" / webhook (see voice/README.md)
    if (req.method === "POST" && url.pathname === "/tool") {
      if (!env.PHONE_TOOL_SECRET || req.headers.get("x-secret") !== env.PHONE_TOOL_SECRET) return json({ error: "Unauthorized" }, 401);
      let tb; try { tb = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      if (!tb || (tb.name !== "submit_booking" && tb.name !== "submit_order")) return json({ error: "Unknown tool" }, 400);
      return json(await runTool(tb.name, tb.input, env, { submitted: 0, log: [] }));
    }
    if (req.method !== "POST" || url.pathname !== "/chat") return json({ error: "Not found" }, 404, ch);
    if (!ch) return json({ error: "Origin not allowed" }, 403);

    const ip = req.headers.get("cf-connecting-ip") || "x", now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < 600000); arr.push(now); hits.set(ip, arr);
    if (arr.length > 40) return json({ error: "Too many messages. Please try again in a few minutes, or phone " + KB.phone + "." }, 429, ch);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Assistant is not configured." }, 500, ch);

    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400, ch); }
    let msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) })).slice(-MAX_TURNS);
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Bad request" }, 400, ch);
    const mode = body.mode === "voice" ? "voice" : "chat";

    const state = { submitted: 0, log: [] };
    let convo = msgs.slice();
    try {
      for (let i = 0; i < MAX_LOOPS; i++) {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: env.MODEL || "claude-haiku-5-5", max_tokens: mode === "voice" ? 300 : 600, system: systemPrompt(mode), tools: TOOLS, messages: convo })
        });
        if (!r.ok) { console.log("anthropic error", r.status, (await r.text()).slice(0, 300)); return json({ error: "The assistant is unavailable right now. Please phone " + KB.phone + "." }, 502, ch); }
        const data = await r.json();
        const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        const uses = (data.content || []).filter((b) => b.type === "tool_use");
        if (data.stop_reason !== "tool_use" || !uses.length) return json({ reply: text || "Sorry, could you say that again?", submitted: state.log }, 200, ch);
        convo.push({ role: "assistant", content: data.content });
        const results = [];
        for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await runTool(u.name, u.input, env, state)) });
        convo.push({ role: "user", content: results });
      }
      return json({ reply: "Sorry, I could not finish that. Please phone us on " + KB.phone + ".", submitted: state.log }, 200, ch);
    } catch (e) {
      console.log("worker error", String(e));
      return json({ error: "The assistant is unavailable right now. Please phone " + KB.phone + "." }, 502, ch);
    }
  }
};
