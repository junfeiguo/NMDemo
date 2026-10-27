/* Namak Mandi assistant: chat widget and in-browser voice call.
   Needs chatbot/knowledge.js (window.NM_KB) and chatbot/chatbot.css.
   Settings: set window.NM_CHAT = { endpoint: "https://YOUR-WORKER.workers.dev/chat" } before this script.
   With an endpoint the AI (Claude, via the Worker) answers and can send bookings and orders.
   Without one, a built-in rule-based helper answers common questions and prepares booking/order messages. */
(function () {
  "use strict";
  var KB = window.NM_KB, CFG = window.NM_CHAT || {};
  if (!KB || document.getElementById("nmc-root")) return;
  var ENDPOINT = CFG.endpoint || "";
  var PHONE = CFG.phone || KB.phone;
  var AI_PHONE = CFG.aiPhone || ""; // optional: a real phone number answered by an AI voice agent (see voice/README.md)
  var WA = CFG.whatsapp || KB.whatsapp || "";

  /* ---------- tiny helpers ---------- */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(text) {
    var h = esc(text).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    return h.replace(/(\b0\d{2,4}[ ]?\d{3,4}[ ]?\d{3,4}\b)/g, function (m) { return '<a href="tel:' + m.replace(/\s/g, "") + '">' + m + "</a>"; });
  }
  var ICON = {
    bot: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="13.5" r="1.1"/><circle cx="15" cy="13.5" r="1.1"/><path d="M9.5 16.5h5M2 12.5v3M22 12.5v3"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 17-3-7z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
  };

  /* ---------- London time ---------- */
  var DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], DAYNAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function london() {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    function g(t) { return parts.filter(function (p) { return p.type === t; })[0].value; }
    var hh = g("hour") === "24" ? "00" : g("hour");
    return { date: g("year") + "-" + g("month") + "-" + g("day"), time: hh + ":" + g("minute") };
  }
  function addDays(iso, n) { var d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function dow(iso) { return new Date(iso + "T12:00:00Z").getUTCDay(); }
  function toMin(t) { var p = t.split(":"); return +p[0] * 60 + +p[1]; }
  function niceDate(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }); }
  function openNow() {
    var n = london(), h = KB.hours[DAYS[dow(n.date)]], t = toMin(n.time);
    return t >= h[0] * 60 && t < h[1] * 60;
  }

  /* ---------- state ---------- */
  var history = [];            // [{role, content}] sent to the AI
  var flow = null;             // local guided flow
  var voiceOn = false;
  var busy = false;

  /* ---------- build UI ---------- */
  var root = el("div", "nmc"); root.id = "nmc-root";
  var fabs = el("div", "nmc-fabs");
  var chatFab = el("button", "nmc-fab chat", ICON.bot + '<span class="nmc-tip">Ask us anything</span>'); chatFab.type = "button"; chatFab.setAttribute("aria-label", "Open the Namak Mandi chat assistant");
  var callFab = el("button", "nmc-fab call", ICON.phone + '<span class="nmc-tip">Talk to our assistant</span>'); callFab.type = "button"; callFab.setAttribute("aria-label", "Start a voice call with the Namak Mandi assistant");
  fabs.appendChild(chatFab); fabs.appendChild(callFab);

  var panel = el("div", "nmc-panel"); panel.hidden = true; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Namak Mandi chat assistant");
  panel.innerHTML = '<div class="nmc-head"><div class="t"><b>Namak Mandi</b><small>Automated assistant, not a person</small></div>' +
    '<button type="button" class="nmc-ib" data-a="call" aria-label="Switch to a voice call">' + ICON.phone + '</button>' +
    '<button type="button" class="nmc-ib" data-a="close" aria-label="Close chat">' + ICON.close + '</button></div>' +
    '<div class="nmc-msgs" id="nmc-msgs" role="log" aria-live="polite"></div>' +
    '<div class="nmc-chips" id="nmc-chips"></div>' +
    '<form class="nmc-form" id="nmc-form"><input id="nmc-in" type="text" autocomplete="off" placeholder="Ask a question or say what you need" aria-label="Your message" maxlength="500"><button class="nmc-send" type="submit" aria-label="Send">' + ICON.send + '</button></form>' +
    '<div class="nmc-foot">Never share card details here. Call us on <a href="tel:' + PHONE.replace(/\s/g, "") + '">' + esc(PHONE) + '</a>.</div>';

  var call = el("div", "nmc-call"); call.hidden = true; call.setAttribute("role", "dialog"); call.setAttribute("aria-label", "Voice call with the Namak Mandi assistant");
  call.innerHTML = '<div><h2>Namak Mandi</h2><p class="sub">Voice assistant · automated, not a person</p></div>' +
    '<div><div class="nmc-orb" id="nmc-orb">' + ICON.mic + '</div><div class="nmc-status" id="nmc-status" aria-live="polite"></div>' +
    '<div class="nmc-line" id="nmc-line" aria-live="polite"></div><div class="acts" id="nmc-cacts"></div></div>' +
    '<div><div class="nmc-ctl"><button type="button" class="nmc-talk" id="nmc-talk">Tap to talk</button><button type="button" class="nmc-talk" id="nmc-type">Type instead</button><button type="button" class="nmc-end" id="nmc-end">End call</button></div>' +
    '<p class="small">Your browser asks to use the microphone. Speech is turned into text by your browser. For a person, call <a href="tel:' + PHONE.replace(/\s/g, "") + '">' + esc(PHONE) + '</a>' +
    (AI_PHONE ? ' or the AI line <a href="tel:' + AI_PHONE.replace(/\s/g, "") + '">' + esc(AI_PHONE) + "</a>" : "") + ".</p></div>";

  root.appendChild(fabs); root.appendChild(panel); root.appendChild(call); document.body.appendChild(root);
  var msgsEl = panel.querySelector("#nmc-msgs"), chipsEl = panel.querySelector("#nmc-chips"), inEl = panel.querySelector("#nmc-in");
  var orb = call.querySelector("#nmc-orb"), statusEl = call.querySelector("#nmc-status"), lineEl = call.querySelector("#nmc-line"), cacts = call.querySelector("#nmc-cacts");

  function addMsg(who, text, acts) {
    var m = el("div", "nmc-m " + who, fmt(text));
    if (acts && acts.length) {
      var box = el("div", "acts");
      acts.forEach(function (a) {
        var b;
        if (a.href) { b = el("a", "nmc-btn" + (a.ghost ? " ghost" : ""), esc(a.label)); b.href = a.href; if (/^http/.test(a.href)) { b.target = "_blank"; b.rel = "noopener"; } }
        else { b = el("button", "nmc-btn" + (a.ghost ? " ghost" : ""), esc(a.label)); b.type = "button"; b.addEventListener("click", function () { copyText(a.copy, b); }); }
        box.appendChild(b);
      });
      m.appendChild(box);
    }
    msgsEl.appendChild(m); msgsEl.scrollTop = msgsEl.scrollHeight; return m;
  }
  function copyText(t, btn) {
    function done() { var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function () { btn.textContent = o; }, 1600); }
    try { navigator.clipboard.writeText(t).then(done, function () { window.prompt("Copy this message", t); }); } catch (e) { window.prompt("Copy this message", t); }
  }
  function setChips(list) {
    chipsEl.innerHTML = "";
    (list || []).forEach(function (c) { var b = el("button", "nmc-chip", esc(c)); b.type = "button"; b.addEventListener("click", function () { submit(c); }); chipsEl.appendChild(b); });
  }
  var START_CHIPS = ["Opening hours", "Book a table", "Order for collection", "Menu and prices", "Allergens", "Find us"];
  function typing(on) {
    var t = msgsEl.querySelector(".nmc-typing");
    if (on && !t) { msgsEl.appendChild(el("div", "nmc-typing", "<i></i><i></i><i></i>")); msgsEl.scrollTop = msgsEl.scrollHeight; }
    if (!on && t) t.remove();
  }

  /* ---------- open / close ---------- */
  var greeted = false, lastFocus = null;
  function openChat() {
    lastFocus = document.activeElement; panel.hidden = false; fabs.hidden = true;
    if (!greeted) {
      greeted = true;
      addMsg("bot", "Hello, I'm the Namak Mandi assistant, an automated helper. I can answer questions about the restaurant and menu, help you request a table, or put together a collection order. How can I help?");
      history.push({ role: "assistant", content: "Hello, I'm the Namak Mandi assistant. How can I help?" });
      setChips(START_CHIPS);
    }
    setTimeout(function () { inEl.focus(); }, 50);
  }
  function closeChat() { panel.hidden = true; fabs.hidden = false; if (lastFocus && lastFocus.focus) try { chatFab.focus(); } catch (e) {} }
  chatFab.addEventListener("click", openChat);
  callFab.addEventListener("click", startCall);
  panel.addEventListener("click", function (e) { var b = e.target.closest("[data-a]"); if (!b) return; if (b.dataset.a === "close") closeChat(); if (b.dataset.a === "call") startCall(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") { if (!call.hidden) endCall(); else if (!panel.hidden) closeChat(); } });
  panel.querySelector("#nmc-form").addEventListener("submit", function (e) { e.preventDefault(); var v = inEl.value.trim(); if (v) { inEl.value = ""; submit(v); } });

  /* ---------- sending a message ---------- */
  function submit(text) {
    if (busy) return;
    addMsg("me", text); setChips([]);
    ask(text).then(function (r) {
      addMsg("bot", r.text, r.acts); if (r.chips) setChips(r.chips);
    });
  }
  function ask(text) {
    busy = true; typing(true);
    history.push({ role: "user", content: text });
    var p = ENDPOINT ? remote() : Promise.resolve(local(text));
    return p.then(function (r) {
      busy = false; typing(false);
      history.push({ role: "assistant", content: r.text }); if (history.length > 24) history = history.slice(-24);
      if (voiceOn) onBotReply(r);
      return r;
    });
  }
  function remote() {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null, to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 25000);
    return fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history.slice(-20), mode: voiceOn ? "voice" : "chat" }), signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { clearTimeout(to); return res.json().then(function (j) { if (!res.ok) throw new Error(j && j.error || "error"); return j; }); })
      .then(function (j) { return { text: j.reply }; })
      .catch(function () {
        clearTimeout(to);
        var r = local(history[history.length - 1].content);
        r.text = "I couldn't reach the live assistant just now, so here is a quick answer instead.\n\n" + r.text;
        return r;
      });
  }

  /* ================= built-in helper (no server needed) ================= */
  var WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function words2digits(t) { return t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, function (w) { return WORDNUM[w]; }); }
  function parseGuests(t) {
    t = words2digits(t.toLowerCase()); var m = t.match(/\b(\d{1,3})\b/); if (!m) return null; var n = +m[1];
    return n >= 1 ? n : null;
  }
  function parseDate(t) {
    t = t.toLowerCase(); var n = london(), i;
    if (/\b(today|tonight|this evening)\b/.test(t)) return n.date;
    if (/\btomorrow\b/.test(t)) return addDays(n.date, 1);
    var names = [["sun", "sunday"], ["mon", "monday"], ["tue", "tuesday|tues"], ["wed", "wednesday"], ["thu", "thursday|thur|thurs"], ["fri", "friday"], ["sat", "saturday"]];
    for (i = 0; i < 7; i++) {
      if (new RegExp("\\b(" + names[i][1] + "|" + names[i][0] + ")\\b").test(t)) { var diff = (i - dow(n.date) + 7) % 7; if (diff === 0) diff = 7; return addDays(n.date, diff); }
    }
    var mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*", m;
    var y = +n.date.slice(0, 4);
    function mk(d, mi) { var iso = y + "-" + ("0" + (mi + 1)).slice(-2) + "-" + ("0" + d).slice(-2); if (iso < n.date) iso = (y + 1) + iso.slice(4); return isNaN(new Date(iso + "T12:00:00Z")) ? null : iso; }
    m = t.match(new RegExp("(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?" + mon)); if (m) return mk(+m[1], MONTHS.indexOf(m[2]));
    m = t.match(new RegExp(mon + "\\s+(\\d{1,2})(?:st|nd|rd|th)?")); if (m) return mk(+m[2], MONTHS.indexOf(m[1]));
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/); if (m) return mk(+m[1], +m[2] - 1);
    return null;
  }
  function parseTime(t) {
    t = words2digits(t.toLowerCase());
    if (/\b(noon|midday)\b/.test(t)) return "12:00";
    var hp = t.match(/half past (\d{1,2})/); if (hp) t = hp[1] + ":30" + (/pm|evening/.test(t) ? " pm" : "");
    var m = t.match(/\b(\d{1,2})(?:[:.](\d{2})|\s+(thirty))?\s*(a\.?m\.?|p\.?m\.?)?/); if (!m) return null;
    var h = +m[1], mm = m[2] ? +m[2] : (m[3] ? 30 : 0), ap = m[4] ? m[4].replace(/\./g, "") : "";
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    if (!ap && /evening|tonight|dinner/.test(t) && h < 12) h += 12;
    if (!ap && h >= 1 && h <= 11) h += 12; // we open at midday, so a bare "7" means 7pm
    if (h > 23 || mm > 59) return null;
    return ("0" + h).slice(-2) + ":" + ("0" + mm).slice(-2);
  }
  function slotProblem(date, time) {
    var n = london(), h = KB.hours[DAYS[dow(date)]], t = toMin(time);
    if (date < n.date) return "That date has already passed.";
    if (date > addDays(n.date, 60)) return "We take bookings up to 60 days ahead.";
    if (t % 30 !== 0) return "We book on the hour or half hour.";
    if (t < h[0] * 60) return "On " + DAYNAMES[dow(date)] + "s we open at " + (h[0] > 12 ? (h[0] - 12) + "pm" : "midday") + ".";
    if (t > toMin(KB.lastBookingTime)) return "The last booking time is " + KB.lastBookingTime + ".";
    if (date === n.date && t < toMin(n.time) + 30) return "That is too soon for an online request. Please pick a later time, or call us.";
    return null;
  }
  function yes(t) { return /^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|right|that'?s right|that is right|please do|go ahead|confirm)/i.test(t); }
  function no(t) { return /^\s*(no|nope|nah|not quite|wrong|change|incorrect)/i.test(t); }

  var BOOK = [
    { k: "guests", ask: "How many guests? I can take tables of 1 to 20.", parse: function (t) { var n = parseGuests(t); if (!n) return { err: "Please tell me a number of guests." }; if (n > 20) return { err: "For more than 20 guests our events team will help: " + KB.eventsPhone + " or " + KB.eventsEmail + "." }; return { v: n }; } },
    { k: "date", ask: "Which date? You can say \"tomorrow\", \"Saturday\" or \"3 November\".", parse: function (t) { var d = parseDate(t); if (!d) return { err: "Sorry, I didn't catch the date. Try \"Saturday\" or \"3 November\"." }; if (d > addDays(london().date, 60)) return { err: "We take requests up to 60 days ahead. Which date would you like?" }; return { v: d }; } },
    { k: "time", ask: "What time? We take bookings on the hour and half hour.", parse: function (t, d) { var tm = parseTime(t); if (!tm) return { err: "Sorry, I didn't catch the time. Try \"7:30pm\"." }; var p = slotProblem(d.date, tm); return p ? { err: p + " Which time would you like instead?" } : { v: tm }; } },
    { k: "seating", ask: "Would you like a table and chairs, or traditional floor seating?", parse: function (t) { return /floor|cushion|low|traditional/i.test(t) ? { v: "Floor seating" } : /table|chair|normal|regular/i.test(t) ? { v: "Table and chairs" } : { err: "Please say \"table\" or \"floor\"." }; } },
    { k: "name", ask: "What name should the booking be under?", parse: nameParse },
    { k: "phone", ask: "What is the best phone number for you?", parse: phoneParse },
    { k: "notes", ask: "Any allergies, celebrations or other requests? Say \"none\" if not.", parse: function (t) { return { v: /^\s*(no|none|nothing|nope|nah)\b/i.test(t) ? "None" : t.trim().slice(0, 300) }; } }
  ];
  var ORDER = [
    { k: "items", ask: "What would you like to order, and how many? For example: \"one lamb karahi half kilo, two naan and a mango lassi\". Collection only; Lamb Sajji needs one day's notice.", parse: function (t) { return t.trim().length > 2 ? { v: t.trim().slice(0, 500) } : { err: "Please tell me which dishes you would like." }; } },
    { k: "when", ask: "When would you like to collect it? Say \"as soon as possible\", or give a day and time.", parse: function (t) { return { v: /asap|soon|now|as quick/i.test(t) ? "As soon as possible" : t.trim().slice(0, 100) }; } },
    { k: "name", ask: "What name should the order be under?", parse: nameParse },
    { k: "phone", ask: "What is the best phone number for you?", parse: phoneParse },
    { k: "notes", ask: "Any allergies or notes for the kitchen? Say \"none\" if not.", parse: function (t) { return { v: /^\s*(no|none|nothing|nope|nah)\b/i.test(t) ? "None" : t.trim().slice(0, 300) }; } }
  ];
  function nameParse(t) { var n = t.replace(/^(my name is|it'?s|it is|i am|i'm|this is|under|name is)\s+/i, "").replace(/[^\p{L} '.-]/gu, "").trim().slice(0, 60); return n.length > 1 ? { v: n } : { err: "Sorry, what name should I put down?" }; }
  function phoneParse(t) { var d = words2digits(t).replace(/\D/g, ""); return d.length >= 10 && d.length <= 13 ? { v: d.replace(/^(\d{5})(\d+)$/, "$1 $2") } : { err: "That doesn't look like a full phone number. Could you say it again, digit by digit?" }; }

  function summary(f) {
    var d = f.data;
    if (f.id === "book") return "Name: " + d.name + "\nPhone: " + d.phone + "\nDate: " + niceDate(d.date) + "\nTime: " + d.time + "\nGuests: " + d.guests + "\nSeating: " + d.seating + "\nNotes: " + d.notes;
    return "Name: " + d.name + "\nPhone: " + d.phone + "\nCollection: " + d.when + "\nOrder: " + d.items + "\nNotes: " + d.notes;
  }
  function startFlow(id, firstText) {
    flow = { id: id, steps: id === "book" ? BOOK : ORDER, i: 0, data: {}, confirm: false, change: false };
    if (id === "book" && firstText) { // pick up details already given in the first message
      var t = firstText.toLowerCase(), g = t.match(/(?:for|party of|table of)\s+(\d+|[a-z]+)(?:\s+(?:people|guests|persons|of us|adults))?/);
      if (g) { var n = parseGuests(g[1]); if (n && n <= 20) flow.data.guests = n; }
      var dt = parseDate(t); if (dt && /today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d\s*(st|nd|rd|th)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/.test(t)) flow.data.date = dt;
      var tm = t.match(/\b(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/) || t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))/);
      if (tm && flow.data.date) { var tv = parseTime(tm[1]); if (tv && !slotProblem(flow.data.date, tv)) flow.data.time = tv; }
    }
    var intro = id === "book" ? "Happy to help with a table. I'll ask a few quick questions, then prepare your request. " : "Happy to help with a collection order. ";
    return advance(intro);
  }
  function advance(prefix) {
    prefix = prefix || "";
    while (flow.i < flow.steps.length && flow.data[flow.steps[flow.i].k] != null) flow.i++;
    if (flow.i >= flow.steps.length) { flow.confirm = true; return { text: prefix + "Here is what I have:\n\n" + summary(flow) + "\n\nShall I prepare this request? (yes or no)", chips: ["Yes", "No"] }; }
    return { text: prefix + flow.steps[flow.i].ask };
  }
  function finish() {
    var title = flow.id === "book" ? "Table booking request" : "Collection order request";
    var msg = KB.name + " - " + title + "\n" + summary(flow) + "\n(Sent from the website assistant)";
    var acts = [];
    if (WA) acts.push({ label: "Send on WhatsApp", href: "https://wa.me/" + WA + "?text=" + encodeURIComponent(msg) });
    acts.push({ label: "Copy message", copy: msg, ghost: true });
    acts.push({ label: "Call " + PHONE, href: "tel:" + PHONE.replace(/\s/g, ""), ghost: true });
    flow = null;
    return { text: "Your request is ready. It has not been sent yet: tap Send on WhatsApp, or copy it and send it to us. Nothing is booked or ordered until the restaurant replies to confirm." + (title.indexOf("Collection") === 0 ? " Payment is taken when you collect." : ""), acts: acts, chips: START_CHIPS };
  }
  function flowTurn(text) {
    var t = text.trim();
    if (/^\s*(cancel|stop|never ?mind|start again|forget it|exit)/i.test(t)) { flow = null; return { text: "No problem, I've cancelled that. Anything else I can help with?", chips: START_CHIPS }; }
    if (flow.change) { // user said no at the summary; pick what to change
      var key = ["guests", "date", "time", "seating", "name", "phone", "notes", "items", "when"].filter(function (k) { return new RegExp("\\b" + k + "\\b", "i").test(t) || (k === "guests" && /people|party/i.test(t)) || (k === "items" && /order|dish|food/i.test(t)); })[0];
      if (!key || flow.steps.map(function (s) { return s.k; }).indexOf(key) < 0) return { text: "What would you like to change? (" + flow.steps.map(function (s) { return s.k; }).join(", ") + ")" };
      flow.change = false; flow.confirm = false; flow.i = flow.steps.map(function (s) { return s.k; }).indexOf(key); delete flow.data[key];
      return { text: flow.steps[flow.i].ask };
    }
    if (flow.confirm) {
      if (yes(t)) return finish();
      if (no(t)) { flow.change = true; return { text: "No problem. What would you like to change? (" + flow.steps.map(function (s) { return s.k; }).join(", ") + ")" }; }
      return { text: "Please say yes to prepare it, or no to change something.", chips: ["Yes", "No"] };
    }
    var step = flow.steps[flow.i], r = step.parse(t, flow.data);
    if (r.err) return { text: r.err };
    flow.data[step.k] = r.v; flow.i++;
    var ack = step.k === "date" ? niceDate(r.v) + ". " : step.k === "time" ? "" : "";
    return advance(ack);
  }

  /* ---------- knowledge answers ---------- */
  var STOP = /\b(do|you|have|has|the|a|an|any|is|are|what|whats|how|much|does|cost|price|prices|of|for|and|with|me|can|i|get|your|on|in|menu|there|serve|sell|offer|want|like|would|to|please|tell|about|got|some|much)\b/g;
  function money(p) { return "£" + p.toFixed(2); }
  function dishLine(m) {
    var v = m.variants.map(function (x) { return (m.variants.length > 1 || x.label !== "One" && x.label !== "Portion" ? x.label + " " : "") + money(x.price); }).join(", ");
    return m.name + ": " + v + (m.veg ? " (vegetarian)" : "") + (m.preorder ? " (pre-order, one day's notice)" : "");
  }
  function menuSearch(t) {
    var q = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(STOP, " ").replace(/\s+/g, " ").trim();
    if (!q) return null;
    var toks = q.split(" ").filter(function (w) { return w.length > 2; }).map(function (w) { return w.replace(/s$/, ""); });
    if (!toks.length) return null;
    var cats = { starter: "starters", wrap: "wraps", platter: "platters", seafood: "seafood", fish: "seafood", rice: "rice", pulao: "rice", bread: "bread", naan: "bread", dessert: "dessert", sweet: "dessert", drink: "drinks", lassi: "drinks", kid: "kids", child: "kids", vegetarian: "veg", veggie: "veg", sajji: "sajji" };
    function match(m, w) { var hay = (m.name + " " + m.desc).toLowerCase(); return hay.indexOf(w) >= 0 || (cats[w] && m.cat === cats[w]) || ((w === "vegetarian" || w === "veggie") && m.veg); }
    var all = KB.menu.filter(function (m) { return toks.every(function (w) { return match(m, w); }); });
    if (all.length) return all;
    var any = KB.menu.filter(function (m) { return toks.some(function (w) { return match(m, w); }); });
    return any.length ? any : null;
  }
  function A(text, chips, acts) { return { text: text, chips: chips || START_CHIPS, acts: acts }; }
  function local(text) {
    var t = text.toLowerCase();
    if (flow) return flowTurn(text);
    if (/\b(book|booking|reserv|table for|reserve)\b/.test(t) && !/\b(gift|event|wedding)\b/.test(t)) return startFlow("book", text);
    if (/\b(order|collect|collection|takeaway|take away|pick ?up)\b/.test(t) && !/(deliver)/.test(t)) return startFlow("order");
    if (/\b(hi|hello|hey|good (morning|afternoon|evening)|salaam|assalam)/.test(t) && t.length < 30) return A("Hello! How can I help? I can answer questions, help you request a table, or put together a collection order.");
    if (/\b(thanks|thank you|cheers|shukriya)\b/.test(t)) return A("You're welcome! Anything else I can help with?");
    if (/\b(hour|open|opening|close|closing|time)\b/.test(t) && !/menu/.test(t)) return A("We are open " + KB.hoursText + "\n\n" + (openNow() ? "We are open right now." : "We are closed at the moment."));
    if (/\b(where|address|location|find you|find us|directions|station|bus|park|parking|postcode)\b/.test(t)) return A(KB.address + ".\nTooting Bec station is a one-minute walk, buses stop on Upper Tooting Road, and street parking nearby is usually free.", null, [{ label: "Open in maps", href: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(KB.address) }]);
    if (/\b(phone|call|number|contact|email|e-mail|speak to)\b/.test(t)) return A("Restaurant: " + KB.phone + "\nEmail: " + KB.email + "\nEvents team: " + KB.eventsPhone + ", " + KB.eventsEmail);
    if (/\b(halal)\b/.test(t)) return A("Yes. All of our food is 100% halal and HMC approved.");
    if (/\b(alcohol|wine|beer|byo|bring your own)\b/.test(t)) return A("We don't serve alcohol and it can't be brought in.");
    if (/\b(allerg|gluten|nut|nuts|dairy|lactose|sesame|intoleran|coeliac|celiac)\b/.test(t)) return A("Our kitchen handles milk, gluten (wheat in naan and breads), nuts, sesame, eggs, fish, mustard, celery and soya, and many dishes share pans and fryers, so I can't promise any dish is free of an allergen. Please tell us when you book, order or sit down and the team will check the ingredients of your dishes with you.");
    if (/\b(deliver|delivery|uber|deliveroo|just eat)\b/.test(t)) return A("For delivery you can find us on Uber Eats, Deliveroo and Just Eat. I can also prepare a collection order for you, paid at the counter.", ["Order for collection"]);
    if (/\b(sajji|whole lamb|lamb leg|half lamb)\b/.test(t) && !/price|cost|how much/.test(t)) return A("Lamb Sajji is a leg, half or whole lamb, simply seasoned and slow-roasted until it falls from the bone. It's cooked to order, so we need one day's notice and a deposit. You can collect it or eat it at the restaurant with a booking.\n\n" + KB.menu.filter(function (m) { return m.cat === "sajji"; }).map(dishLine).join("\n"));
    if (/\b(gift|voucher)\b/.test(t)) return A("Gift cards come in £25, £50, £100 and £150, valid in the restaurant. You can request one on the website and we'll confirm with you before anything is charged.");
    if (/\b(event|wedding|party|parties|catering|private|large group|big group|corporate|birthday)\b/.test(t)) return A("We cater weddings, birthdays, corporate events and private dining for 10 or more. For groups over 20 or a specific date, please contact our events team: " + KB.eventsPhone + " or " + KB.eventsEmail + ".");
    if (/\b(floor|cushion|seating|high chair|highchair|prayer|pray)\b/.test(t)) return A("You can sit at a table and chairs or on traditional floor seating with cushions. High chairs are available, and a prayer space can be arranged. Just ask when you book.");
    if (/\b(walk[- ]?in|without (a )?(booking|reservation))\b/.test(t)) return A("Yes, we keep room for walk-ins every day. Evenings are busy, so if a time isn't available just come along and we'll seat you as soon as we can.");
    if (/\b(vegetarian|vegan|veggie)\b/.test(t)) { var vs = KB.menu.filter(function (m) { return m.veg; }); return A("Vegetarian dishes (cooked in our shared kitchen):\n" + vs.map(dishLine).join("\n")); }
    if (/\b(spicy|spice|heat|hot|mild)\b/.test(t) && !/\b(menu)\b/.test(t)) return A("Peshawari cooking is gently spiced rather than fiery. Ask and we'll happily make a dish milder or hotter.");
    if (/\b(signature|recommend|popular|best|first time|try)\b/.test(t)) return A("If it's your first visit, start with: " + KB.menu.filter(function (m) { return m.signature; }).map(dishLine).join("; ") + ".");
    var hits = menuSearch(text);
    if (hits && hits.length <= 8) return A(hits.map(dishLine).join("\n") + "\n\nThese are dine-in prices; collection prices can differ slightly.", ["Order for collection", "Book a table"]);
    if (hits) return A("I found " + hits.length + " dishes. Here are the first eight:\n" + hits.slice(0, 8).map(dishLine).join("\n") + "\n\nTry asking about one in particular, or see the full menu on the page.", ["Vegetarian dishes", "Lamb Sajji"]);
    if (/\b(menu|food|dishes|eat|serve)\b/.test(t)) return A("We serve Peshawari grills, karahi, Kabuli pulao, wraps, platters, sajji, bread, desserts and lassis, from noon until midnight. Ask me about a dish, like \"lamb karahi\" or \"mixed grill\", or about vegetarian options.", ["Lamb karahi", "Vegetarian dishes", "Platters"]);
    return A("I'm not sure about that one. For anything I can't answer please call us on " + KB.phone + ". I can help with opening hours, the menu and prices, allergens, finding us, table requests and collection orders.");
  }

  /* ================= voice call (runs in the visitor's browser) ================= */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition, synth = window.speechSynthesis;
  var rec = null, callActive = false, listening = false, speaking = false, silent = 0, voice = null;
  function pickVoice() {
    if (!synth) return; var vs = synth.getVoices(); if (!vs.length) return;
    var pref = /Google UK English Female|Serena|Kate|Martha|Libby|Sonia|Hazel|Susan|Daniel|Arthur|George|Google UK English Male/i;
    voice = vs.filter(function (v) { return /^en-GB/i.test(v.lang) && pref.test(v.name); })[0] || vs.filter(function (v) { return /^en-GB/i.test(v.lang); })[0] || vs.filter(function (v) { return /^en/i.test(v.lang); })[0] || null;
  }
  if (synth) { pickVoice(); if (synth.addEventListener) synth.addEventListener("voiceschanged", pickVoice); }
  function setStatus(s, cls) { statusEl.textContent = s; orb.className = "nmc-orb" + (cls ? " " + cls : ""); }
  function spoken(t) { // make text easier to say aloud
    return t.replace(/£(\d+)\.(\d{2})/g, function (_, a, b) { return a + " pounds " + (b === "00" ? "" : b); }).replace(/£(\d+)/g, "$1 pounds").replace(/\*\*/g, "").replace(/\n+/g, ". ").replace(/\s+/g, " ").replace(/\(vegetarian\)/g, ", vegetarian").replace(/[()]/g, "");
  }
  function startCall() {
    if (!SR || !synth) { panel.hidden = true; fabs.hidden = false; openChat(); addMsg("bot", "Voice calls need a browser with speech support, such as Chrome, Edge or Safari. You can type here instead, or call us on " + PHONE + "."); return; }
    voiceOn = true; callActive = true; silent = 0; panel.hidden = true; fabs.hidden = true; call.hidden = false;
    lineEl.textContent = ""; cacts.innerHTML = "";
    var hello = "Hello, you're through to the Namak Mandi assistant. I'm an automated assistant. I can answer questions, take a table request or a collection order. How can I help?";
    if (!greeted) { greeted = true; history.push({ role: "assistant", content: hello }); } else history.push({ role: "assistant", content: "Hello again. How can I help?" });
    showBot(hello); speak(hello);
  }
  function showBot(t, acts) {
    lineEl.innerHTML = fmt(t);
    cacts.innerHTML = "";
    (acts || []).forEach(function (a) {
      var b = a.href ? el("a", "nmc-btn gold", esc(a.label)) : el("button", "nmc-btn gold", esc(a.label));
      if (a.href) { b.href = a.href; if (/^http/.test(a.href)) { b.target = "_blank"; b.rel = "noopener"; } } else { b.type = "button"; b.addEventListener("click", function () { copyText(a.copy, b); }); }
      cacts.appendChild(b);
    });
    addMsg("bot", t, acts);
  }
  function speak(text, then) {
    if (!callActive) return;
    stopListening(); speaking = true; setStatus("Speaking…", "speaking");
    synth.cancel();
    var parts = spoken(text).match(/[^.!?]+[.!?]*/g) || [spoken(text)], i = 0;
    function next() {
      if (!callActive) return;
      if (i >= parts.length) { speaking = false; if (then) then(); else listen(); return; }
      var s = parts[i++].trim(); if (!s) return next();
      var u = new SpeechSynthesisUtterance(s); u.lang = "en-GB"; if (voice) u.voice = voice; u.rate = 1;
      u.onend = next; u.onerror = next; synth.speak(u);
    }
    next();
  }
  function listen() {
    if (!callActive || speaking || busy) return;
    try { rec = new SR(); } catch (e) { setStatus("Microphone unavailable"); return; }
    rec.lang = "en-GB"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    var got = "", final = false;
    rec.onstart = function () { listening = true; setStatus("Listening…", "listening"); };
    rec.onresult = function (e) {
      var s = ""; for (var i = e.resultIndex; i < e.results.length; i++) { s += e.results[i][0].transcript; if (e.results[i].isFinal) final = true; }
      got = s; lineEl.innerHTML = '<span class="you">You</span>' + esc(s);
    };
    rec.onerror = function (e) {
      listening = false;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { callActive = false; setStatus("Microphone blocked"); lineEl.textContent = "Please allow microphone access in your browser, then start the call again. You can also type to us instead."; }
    };
    rec.onend = function () {
      listening = false; if (!callActive || speaking || busy) return;
      if (final && got.trim()) { silent = 0; handleVoice(got.trim()); return; }
      silent++;
      if (silent === 3) { speak("Are you still there?"); return; }
      if (silent >= 5) { speak("I'll end the call now. Thank you for calling Namak Mandi. Goodbye.", endCall); return; }
      setTimeout(listen, 250);
    };
    try { rec.start(); } catch (e) { setTimeout(listen, 400); }
  }
  function stopListening() { listening = false; if (rec) { rec.onend = null; rec.onresult = null; rec.onerror = null; try { rec.abort(); } catch (e) {} rec = null; } }
  function handleVoice(text) {
    addMsg("me", text); setStatus("Thinking…");
    if (/\b(goodbye|bye|that'?s all|hang up|end (the )?call)\b/i.test(text) && text.length < 40) { speak("Thank you for calling Namak Mandi. Goodbye.", endCall); return; }
    ask(text);
  }
  function onBotReply(r) { showBot(r.text, r.acts); speak(r.text); }
  function endCall() {
    callActive = false; voiceOn = false; stopListening(); try { synth.cancel(); } catch (e) {}
    call.hidden = true; fabs.hidden = false; setStatus("");
  }
  call.querySelector("#nmc-end").addEventListener("click", endCall);
  call.querySelector("#nmc-type").addEventListener("click", function () { endCall(); openChat(); });
  call.querySelector("#nmc-talk").addEventListener("click", function () { if (!callActive) return; try { synth.cancel(); } catch (e) {} speaking = false; stopListening(); listen(); });
  window.addEventListener("pagehide", function () { try { synth && synth.cancel(); } catch (e) {} });

  /* test hooks (harmless in production) */
  window.NMChat = { open: openChat, call: startCall, local: local };
})();
