// ===== Supabase client init (single instance) =====
const SUPABASE_URL = "https://wzbjbiaiumonyvucewqi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6YmpiaWFpdW1vbnl2dWNld3FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0NDAxMTUsImV4cCI6MjA4NDAxNjExNX0.DFmuUKBRDCDkE5zHF5zH9GLU8Wd-IGFIbLwO-5gJC3o";

if (!window.supabase?.createClient) {
  throw new Error("Supabase SDK not loaded. Check index.html script order.");
}

// Use a project-specific storageKey to avoid conflicts, even if a second instance is accidentally created.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey: "vtwiki-auth-token",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});
window.sb = sb;
// ================================================

// ===========================
// DOM safety helpers (prevent null crashes)
// ===========================
function setText(id, v){ const e = document.getElementById(id); if(e) e.textContent = String(v ?? ""); }
function setHTML(id, v){ const e = document.getElementById(id); if(e) e.innerHTML = String(v ?? ""); }
function setVal(id, v){ const e = document.getElementById(id); if(e) e.value = String(v ?? ""); }
// ===========================


// ===== Global DOM safety helpers (do not remove) =====
(function(){
  if (window.setText) return;
  window.$id = (id) => document.getElementById(id);
  window.setText = (id, v) => { const e = window.$id(id); if (e) e.textContent = String(v ?? ""); };
  window.setHTML = (id, v) => { const e = window.$id(id); if (e) e.innerHTML = String(v ?? ""); };
  window.setVal  = (id, v) => { const e = window.$id(id); if (e) e.value = String(v ?? ""); };
})();


  // ===========================
  // Auth safety: prevent double signup/resend (avoids 429 / over_email_send_rate_limit)
  // ===========================
  const AUTH_GUARD = {
    inFlight: false,
    lastAttemptAt: 0,
    minIntervalMs: 6500, // matches Supabase message (~6s)
  };

  function canAuthRequest() {
    const now = Date.now();
    const dt = now - AUTH_GUARD.lastAttemptAt;
    if (dt < AUTH_GUARD.minIntervalMs) {
      const wait = Math.ceil((AUTH_GUARD.minIntervalMs - dt) / 1000);
      return { ok: false, wait };
    }
    return { ok: true, wait: 0 };
  }

  async function guardedAuth(fn) {
    if (AUTH_GUARD.inFlight) throw new Error("처리 중입니다. 잠시만 기다려주세요.");
    const check = canAuthRequest();
    if (!check.ok) throw new Error(`보안 제한으로 ${check.wait}초 후 다시 시도해줘.`);
    AUTH_GUARD.inFlight = true;
    AUTH_GUARD.lastAttemptAt = Date.now();
    try {
      return await fn();
    } finally {
      AUTH_GUARD.inFlight = false;
    }
  }

/* VTuber Archive Wiki - 3 files only (v2)
   Added requested features:
   ✅ Auto TOC (목차 자동 생성)
   ✅ Wiki links: [[문서]] / [[문서|표시]] 파싱
   ✅ Templates/Infobox: {{InfoboxVTuber|key=value|...}} 또는 자동 인포박스(버튜버 테이블 기반)
   ✅ Page protection levels (문서별 보호 레벨)
   ✅ Basic anti-vandal + client rate-limit helpers (DB 트리거 권장)
   ✅ VTuber wiki-specific fields + auto infobox render
*/

(() => {
  // ===========================
  // 0) CONFIG
  // ===========================
  const CONFIG = {
    // Supabase 프로젝트 Settings → API에서 복사
    supabaseUrl: "https://wzbjbiaiumonyvucewqi.supabase.co",
    supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6YmpiaWFpdW1vbnl2dWNld3FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0NDAxMTUsImV4cCI6MjA4NDAxNjExNX0.DFmuUKBRDCDkE5zHF5zH9GLU8Wd-IGFIbLwO-5gJC3o",

    siteName: "VTuber Archive Wiki",
    pageSize: 40,
    maxMd: 200000,

    // client-side throttles (DB 트리거로도 막는 걸 강력 추천)
    clientCooldownMs: 12_000,     // 같은 브라우저에서 연속 저장 쿨다운
    clientMaxEditsPerHour: 30,    // localStorage 기준
    enableViewCountRpc: true,     // RPC increment_view_count(p_slug) (선택)
  };

  // ===========================
  // 1) UTILITIES
  // ===========================
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function normalizeSlug(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-\_가-힣]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
  }

  function parseTags(tagText) {
    const raw = String(tagText || "")
      .replaceAll(",", " ")
      .split(/\s+/g)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith("#") ? t.slice(1) : t))
      .slice(0, 60);
    return [...new Set(raw)];
  }

  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    return d.toLocaleString("ko-KR");
  }

  function toast(title, body = "", type = "info") {
    const host = $("#toastHost");
    if (!host) return;
    host.className = "toast";
    const el = document.createElement("div");
    el.className = "toast-item";
    el.dataset.type = type;
    el.innerHTML = `
      <div class="t-title">${escapeHtml(title)}</div>
      ${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ""}
    `;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(-6px)";
      setTimeout(() => el.remove(), 220);
    }, 2400);
  }

  function setStatus(text) {
    const el = $("#statusLine");
    if (el) el.textContent = text;
  }

  function mustConfig() {
    if (
      !CONFIG.supabaseUrl ||
      !CONFIG.supabaseAnonKey ||
      CONFIG.supabaseUrl.includes("PASTE_") ||
      CONFIG.supabaseAnonKey.includes("PASTE_")
    ) {
      render(layoutCard("설정 필요", `
        <p>app.js의 <span class="kbd">CONFIG.supabaseUrl</span> / <span class="kbd">CONFIG.supabaseAnonKey</span>를 채워야 합니다.</p>
        <div class="hr"></div>
        <p class="muted small">Supabase 프로젝트 → Settings → API 에서 URL과 anon key를 복사하세요.</p>
      `));
      return false;
    }
    return true;
  }

  // ===========================
  // 2) Wiki parsing: [[links]] + templates + TOC

  // ===========================
  // 2.5) Categories + Standard templates + refs
  // ===========================
  // Category syntax: [[분류:카테고리]] (multiple allowed)
  function extractCategories(md) {
    const cats = [];
    // supports [[분류:카테고리]] and [[분류:카테고리|정렬키]]
    const re = /\[\[\s*분류\s*:\s*([^\]\|]+)(?:\|([^\]]+))?\]\]/g;
    let m;
    while ((m = re.exec(String(md || "")))) {
      const name = String(m[1] || "").trim();
      const sort = String(m[2] || "").trim();
      if (name) cats.push({ name, sort_key: sort || null });
    }
    const map = new Map();
    for (const c of cats) if (!map.has(c.name)) map.set(c.name, c);
    return Array.from(map.values()).slice(0, 30);
  }

  function stripCategoryTokens(md) {
    return String(md || "").replace(/\[\[\s*분류\s*:\s*([^\]|]+)(?:\|[^\]]+)?\]\]\s*/g, "").trim();
  }

  // Standard template: {{Redirect|target=slug|reason=...}} or {{리다이렉트|...}}
  function extractRedirectTemplate(md) {
    // supports:
    // 1) {{Redirect|target=slug|reason=...}}
    // 2) #REDIRECT [[slug]]  (Namuwiki-like)
    const text = String(md || "");
    const firstLine = (text.split(/\r?\n/, 1)[0] || "");
    const m1 = firstLine.match(/^\s*#\s*redirect\s*\[\[\s*([^\]\|]+)(?:\|[^\]]+)?\s*\]\]\s*$/i);
    if (m1) {
      const target = normalizeSlug(m1[1]);
      const rest = text.replace(firstLine, "").trim();
      return { md: rest, redirect: target ? { target, reason: "REDIRECT" } : null };
    }

    const re = /\{\{\s*(redirect|리다이렉트)\s*((?:\|[^}]*)*)\}\}/i;
    const m = text.match(re);
    if (!m) return { md: text, redirect: null };
    const raw = m[0];
    const args = parseTemplateArgs(raw);
    const target = normalizeSlug(args.target || args.to || args.대상 || "");
    const reason = args.reason || args.사유 || "";
    const md2 = text.replace(raw, "").trim();
    if (!target) return { md: md2, redirect: null };
    return { md: md2, redirect: { target, reason } };
  }

  // Refs: <ref> ... </ref> → superscripts + footnotes block appended
  function renderRefs(mdText) {
    const refs = [];
    const md = String(mdText || "").replace(/<ref>([\s\S]*?)<\/ref>/g, (_, inner) => {
      const text = String(inner || "").trim();
      if (!text) return "";
      refs.push(text);
      const n = refs.length;
      return `<span class="refsup">[${n}]</span>`;
    });

    const foot = refs.length ? `
      <div class="footnotes">
        <h2>각주</h2>
        <ol>
          ${refs.map((t, i) => `<li id="fn-${i+1}">${escapeHtml(t)}</li>`).join("")}
        </ol>
      </div>
    ` : "";

    return { md, footHtml: foot };
  }

  // Citation template: {{Cite|url=...|title=...|date=...}} → markdown line
  function expandCiteTemplates(md) {
    return String(md || "").replace(/\{\{\s*(cite|출처)\s*((?:\|[^}]*)*)\}\}/gi, (raw) => {
      const args = parseTemplateArgs(raw);
      const url = args.url || args.link || "";
      const title = args.title || args.name || "출처";
      const date = args.date || args.access || "";
      const extra = [date].filter(Boolean).join(" · ");
      const safeTitle = title.replace(/\n/g, " ").slice(0, 140);
      if (url) return `- 출처: [${safeTitle}](${url})${extra ? " ("+extra+")" : ""}`;
      return `- 출처: ${safeTitle}${extra ? " ("+extra+")" : ""}`;
    });
  }

  // Sources template: {{Sources}} inserts a heading if missing
  function expandSourcesTemplate(md) {
    if (!/\{\{\s*sources\s*\}\}/i.test(md)) return md;
    return String(md || "").replace(/\{\{\s*sources\s*\}\}/gi, "\n\n## 출처\n- (여기에 출처를 추가하세요)\n");
  }

  // ===========================
  // [[Page]] or [[Page|Text]] → markdown link to hash route
  function parseWikiLinks(md) {
    return String(md || "").replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_, p1, _p2, p3) => {
      const page = normalizeSlug(p1);
      const text = (p3 || p1).trim();
      return `[${text}](#/v/${encodeURIComponent(page)})`;
    });
  }

  // File syntax: [[파일:URL]] or [[파일:URL|width=320|alt=...|caption=...]]
  function parseFileSyntax(md) {
    return String(md || "").replace(/\[\[\s*파일\s*:\s*([^\]\|]+)(?:\|([^\]]+))?\]\]/g, (_, url, optStr) => {
      const u = String(url || "").trim();
      if (!u) return "";
      const opts = {};
      if (optStr) {
        for (const part of String(optStr).split("|")) {
          const p = part.trim();
          if (!p) continue;
          const idx = p.indexOf("=");
          if (idx > 0) opts[p.slice(0, idx).trim().toLowerCase()] = p.slice(idx + 1).trim();
        }
      }
      const w = opts.width ? Math.max(80, Math.min(960, Number(opts.width))) : null;
      const alt = opts.alt ? opts.alt : "파일";
      const cap = opts.caption || opts.설명 || "";
      const img = `<img src="${escapeHtml(u)}" ${w ? `style="max-width:${w}px"` : ""} alt="${escapeHtml(alt)}" />`;
      const fig = cap ? `<figure>${img}<figcaption class="muted small" style="margin-top:6px">${escapeHtml(cap)}</figcaption></figure>` : img;
      return fig;
    });
  }


  // {{InfoboxVTuber|key=value|...}} OR {{Infobox VTuber|...}}
  function extractTemplate(md, nameSet) {
    // returns {mdWithoutTemplate, templateRaw|null}
    const re = /\{\{\s*([^\|\}]+)\s*((?:\|[^}]*)*)\}\}/m;
    const m = String(md || "").match(re);
    if (!m) return { md: md || "", tpl: null };
    const name = (m[1] || "").trim().toLowerCase();
    const hit = nameSet.some(n => n === name);
    if (!hit) return { md: md || "", tpl: null };
    const tpl = m[0];
    const md2 = (md || "").replace(tpl, "").trim();
    return { md: md2, tpl };
  }

  function parseTemplateArgs(tplRaw) {
    // tplRaw like {{InfoboxVTuber|name=Airina|agency=...|tags=#a,#b}}
    const inner = tplRaw.replace(/^\{\{|\}\}$/g, "");
    const parts = inner.split("|").map(s => s.trim()).filter(Boolean);
    parts.shift(); // template name
    const args = {};
    for (const p of parts) {
      const idx = p.indexOf("=");
      if (idx >= 0) {
        const k = p.slice(0, idx).trim().toLowerCase();
        const v = p.slice(idx + 1).trim();
        args[k] = v;
      } else {
        // positional ignored
      }
    }
    return args;
  }

  function infoboxHtmlFromArgs(args) {
    const title = args.name || args.title || "Infobox";
    const rows = [];
    const map = [
      ["agency", "소속"],
      ["generation", "세대/기수"],
      ["debut", "데뷔"],
      ["platforms", "플랫폼"],
      ["fandom", "팬덤"],
      ["hashtags", "해시태그"],
      ["birthday", "생일"],
      ["height", "키"],
      ["illustrator", "일러스트"],
      ["rigger", "리거"],
      ["language", "언어"],
    ];
    for (const [k, label] of map) {
      if (!args[k]) continue;
      let v = args[k];
      // allow comma list for hashtags/platforms
      if (k === "hashtags") {
        const tags = v.split(/[, ]+/).map(s => s.trim()).filter(Boolean).map(t => t.startsWith("#")? t : "#"+t);
        v = tags.map(t => `<span class="ib-chip">${escapeHtml(t)}</span>`).join("");
        rows.push([label, `<div class="ib-chips">${v}</div>`]);
        continue;
      }
      if (k === "platforms") {
        const lines = v.split(/[, ]+/).map(s => s.trim()).filter(Boolean);
        const html = lines.map(u => {
          const safe = escapeHtml(u);
          return `<div><a href="${safe}" target="_blank" rel="noreferrer">${safe}</a></div>`;
        }).join("") || escapeHtml(v);
        rows.push([label, html]);
        continue;
      }
      rows.push([label, escapeHtml(v)]);
    }

    const grid = rows.map(([k, v]) => `
      <div class="k">${escapeHtml(k)}</div>
      <div class="v">${v}</div>
    `).join("");

    return `
      <div class="infobox">
        <div class="ib-title">
          <span>${escapeHtml(title)}</span>
          <span class="kbd">Template</span>
        </div>
        ${args.subtitle ? `<div class="ib-sub">${escapeHtml(args.subtitle)}</div>` : ""}
        <div class="ib-grid">${grid || `<div class="muted small">필드가 비었습니다.</div>`}</div>
      </div>
      ${refed.footHtml || ""}
    `;
  }

  // Markdown → safe HTML + TOC injection
  function renderMarkdownWithToc(mdText, { infoboxHtml = "" } = {}) {
    // preprocess: categories + standard templates
    let mdText2 = String(mdText || "");
    mdText2 = expandSourcesTemplate(mdText2);
    mdText2 = expandCiteTemplates(mdText2);
    const red = extractRedirectTemplate(mdText2);
    mdText2 = red.md;
    const cats = extractCategories(mdText2);
    mdText2 = stripCategoryTokens(mdText2);
    const refed = renderRefs(mdText2);
    mdText2 = refed.md;

    // 1) preprocess wiki syntax
    let md = parseWikiLinks(mdText2 || "");
    md = parseFileSyntax(md);

    // TOC placeholder
    const hasTocToken = md.includes("__TOC__");
    md = md.replaceAll("__TOC__", "");

    // 2) markdown → html
    const raw = marked.parse(md, { mangle: false, headerIds: false });

    // 3) build TOC and add ids to headings
    const doc = new DOMParser().parseFromString(raw, "text/html");
    const headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4"));
    const tocItems = [];
    const used = new Set();

    function slugifyHeading(text) {
      let s = String(text || "").trim().toLowerCase();
      s = s.replace(/[^\p{L}\p{N}\s\-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 60);
      if (!s) s = "section";
      let base = s, i = 2;
      while (used.has(s)) { s = base + "-" + i++; }
      used.add(s);
      return s;
    }

    for (const h of headings) {
      const level = Number(h.tagName.slice(1));
      const text = h.textContent || "";
      const id = slugifyHeading(text);
      h.setAttribute("id", id);
      tocItems.push({ level, text, id });
    }

    const bodyHtml = doc.body.innerHTML;

    const tocHtml = tocItems.length >= 3 ? `
      <div class="cardlite toc">
        <h3>목차</h3>
        ${tocItems.map(it => `<a data-level="${it.level}" href="#${escapeHtml(it.id)}">${escapeHtml(it.text)}</a>`).join("")}
      </div>
    ` : "";

    // 4) sanitize
    const finalHtml = DOMPurify.sanitize(bodyHtml, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ["div","span"],
      ADD_ATTR: ["target","rel","class","data-level","id"],
    });

    // 5) output: infobox + toc + wiki html
    // expose meta for caller
    window.__vtwiki_last_render = { categories: (cats||[]), redirect: red.redirect || null };

    let combined = `
      ${infoboxHtml ? `<div style="margin-bottom:14px">${infoboxHtml}</div>` : ""}
      ${tocHtml}
      <div class="wiki">${finalHtml}</div>
      ${refed.footHtml || ""}
    `;

    // If __TOC__ token was used, prefer toc at that location
    if (hasTocToken && tocHtml) {
      // simplest: put toc above content (already). token support mainly for author control.
    }

    return combined;
  }

  // ===========================
  // 3) Client-side rate-limit helpers (DB triggers recommended)
  // ===========================
  const RL = {
    key: "vtwiki_rl_v2",
    now() { return Date.now(); },
    read() {
      try { return JSON.parse(localStorage.getItem(this.key) || "{}"); }
      catch { return {}; }
    },
    write(obj) { localStorage.setItem(this.key, JSON.stringify(obj)); },
    bump(kind) {
      const st = this.read();
      const t = this.now();
      st.last = st.last || {};
      st.hour = st.hour || {};
      st.last[kind] = t;
      const hourKey = String(Math.floor(t / 3600000));
      st.hour[hourKey] = st.hour[hourKey] || {};
      st.hour[hourKey][kind] = (st.hour[hourKey][kind] || 0) + 1;
      this.write(st);
    },
    check(kind) {
      const st = this.read();
      const t = this.now();
      const last = st.last?.[kind] || 0;
      if (t - last < CONFIG.clientCooldownMs) {
        return { ok:false, msg:`너무 빠릅니다. ${Math.ceil((CONFIG.clientCooldownMs-(t-last))/1000)}초 후 다시 시도` };
      }
      const hourKey = String(Math.floor(t / 3600000));
      const n = st.hour?.[hourKey]?.[kind] || 0;
      if (n >= CONFIG.clientMaxEditsPerHour) return { ok:false, msg:"이 브라우저에서 시간당 작업 제한" };
      return { ok:true };
    }
  };

  // Basic vandal heuristics (client only): warn user, DB trigger should enforce if needed
  function vandalHeuristic(oldMd, newMd) {
    const a = String(oldMd||"");
    const b = String(newMd||"");
    const la = a.length, lb = b.length;
    if (la > 800 && lb < la * 0.35) return "대량 삭제 감지(반달 의심). 출처/요약을 꼭 남기세요.";
    if (b.replace(/\s+/g,"").length < 30) return "내용이 너무 짧습니다.";
    if (/fuck|shit|병신|좆|시발|개새|닥쳐|죽어/i.test(b)) return "비속어/혐오 표현 감지. 저장 전 확인하세요.";
    return null;
  }

  // ===========================
  // 4) SUPABASE CLIENT
  // ===========================
  let supabase = sb;

  function initSupabase() { supabase = sb; }

  async function getUser() {
    const { data } = await sb.auth.getUser();
    return data?.user || null;
  }

  async function getProfile(userId) {
    if (!userId) return null;
    const { data } = await sb.from("profiles").select("id, username, role, created_at").eq("id", userId).maybeSingle();
    return data || null;
  }

  async function ensureProfile(user, usernameOptional) {
    if (!user?.id) return;
    const existing = await getProfile(user.id);
    if (existing) return existing;

    const { data, error } = await supabase
      .from("profiles")
      .insert({ id: user.id, username: usernameOptional || null, role: "user" })
      .select()
      .maybeSingle();
    if (error) {
      console.warn(error);
      return null;
    }
    return data || null;
  }

  // ===========================
  // 5) DB QUERIES (schema v2)
  // ===========================
  async function dbGetVtuber(slug) {
    const { data, error } = await supabase
      .from("vtubers")
      .select("*")
      .eq("slug", slug)
      .eq("is_deleted", false)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function dbUpsertVtuber(vt) {
    const { data, error } = await sb.from("vtubers").upsert(vt, { onConflict: "slug" }).select().maybeSingle();
    if (error) throw error;
    return data;
  }

  async function dbListVtubers({ limit = 24, order = "view_count" } = {}) {
    let q = sb.from("vtubers").select("slug,display_name,agency,generation,debut_date,view_count,tags,updated_at").eq("is_deleted", false);
    q = order === "updated" ? q.order("updated_at", { ascending: false }) : q.order("view_count", { ascending: false });
    const { data, error } = await q.limit(clamp(limit, 1, 100));
    if (error) throw error;
    return data || [];
  }

  async function dbEnsurePage(slug, title) {
    const { data, error } = await supabase
      .from("wiki_pages")
      .upsert({ slug, title }, { onConflict: "slug" })
      .select("id,slug,title,current_revision_id,protection_level,is_locked,lock_reason,updated_at,created_at")
      .single();
    if (error) throw error;
    return data;
  }

  async function dbGetPage(slug) {
    const { data, error } = await supabase
      .from("wiki_pages")
      .select("id,slug,title,current_revision_id,protection_level,is_locked,lock_reason,updated_at,created_at")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function dbGetRevision(revId) {
    const { data, error } = await sb.from("wiki_revisions").select("*").eq("id", revId).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function dbGetCurrentContent(slug) {
    const page = await dbGetPage(slug);
    if (!page?.current_revision_id) {
      return { page, revision: null, content_md: `# ${slug}\n\n아직 문서가 없습니다. **편집**으로 첫 내용을 작성하세요.\n\n__TOC__\n\n## 개요\n- [[문서 링크 예시]]\n\n## 인포박스 템플릿 예시\n{{InfoboxVTuber|name=${slug}|agency=개인|generation=0기|debut=2026-01-01|platforms=https://twitch.tv/|fandom=팬덤명|hashtags=#tag1,#tag2}}` };
    }
    const rev = await dbGetRevision(page.current_revision_id);
    return { page, revision: rev, content_md: rev?.content_md || "" };
  }

  async function dbInsertRevision({ pageId, summary, content_md }) {
    const { data, error } = await supabase
      .from("wiki_revisions")
      .insert({ page_id: pageId, summary, content_md })
      .select("id")
      .single();
    if (error) throw error;
    return data;
  }

  async function dbSetCurrentRevision(pageId, revId) {
    const { error } = await sb.from("wiki_pages").update({ current_revision_id: revId }).eq("id", pageId);
    if (error) throw error;
  }

  async function dbHistory(slug, limit = 60) {
    const page = await dbGetPage(slug);
    if (!page) return { page: null, revisions: [] };
    const { data, error } = await supabase
      .from("wiki_revisions")
      .select("id, summary, created_at, author_id")
      .eq("page_id", page.id)
      .order("created_at", { ascending: false })
      .limit(clamp(limit, 1, 200));
    if (error) throw error;
    return { page, revisions: data || [] };
  }

  async function dbRecent(limit = 50) {
    const { data, error } = await supabase
      .from("wiki_revisions")
      .select("id,summary,created_at,page_id,wiki_pages!inner(slug,title)")
      .order("created_at", { ascending: false })
      .limit(clamp(limit, 1, 120));
    if (error) throw error;
    return data || [];
  }

  async function dbSearch(q) {
    q = String(q || "").trim();
    if (!q) return { vtubers: [], pages: [], hits: [] };

    if (q.startsWith("#")) {
      const tag = q.slice(1);
      const { data, error } = await sb.from("vtubers").select("slug,display_name,view_count,tags,generation").contains("tags", [tag]).limit(50);
      if (error) throw error;
      return { vtubers: data || [], pages: [], hits: [] };
    }

    const vt = await supabase
      .from("vtubers")
      .select("slug,display_name,view_count,tags,agency,generation")
      .or(`display_name.ilike.%${q}%,slug.ilike.%${q}%`)
      .limit(50);

    const pages = await supabase
      .from("wiki_pages")
      .select("slug,title,is_locked,protection_level,updated_at")
      .or(`title.ilike.%${q}%,slug.ilike.%${q}%`)
      .limit(50);

    const hits = await supabase
      .from("wiki_revisions")
      .select("id,summary,created_at,wiki_pages!inner(slug,title)")
      .ilike("content_plain", `%${q}%`)
      .order("created_at", { ascending: false })
      .limit(30);

    if (vt.error) throw vt.error;
    if (pages.error) throw pages.error;
    if (hits.error) throw hits.error;

    return { vtubers: vt.data || [], pages: pages.data || [], hits: hits.data || [] };
  }

  async function dbThreads(slug, limit=40) {
    const page = await dbGetPage(slug);
    if (!page) return [];
    const { data, error } = await supabase
      .from("discussion_threads")
      .select("*")
      .eq("page_id", page.id)
      .order("created_at", { ascending: false })
      .limit(clamp(limit,1,200));
    if (error) throw error;
    return data || [];
  }

  async function dbCreateThread(slug, title) {
    const page = await dbGetPage(slug);
    if (!page) throw new Error("page not found");
    const { data, error } = await supabase
      .from("discussion_threads")
      .insert({ page_id: page.id, title })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async function dbPosts(threadId, limit=200) {
    const { data, error } = await supabase
      .from("discussion_posts")
      .select("*")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(clamp(limit,1,500));
    if (error) throw error;
    return data || [];
  }

  async function dbCreatePost(threadId, body_md) {
    const { data, error } = await supabase
      .from("discussion_posts")
      .insert({ thread_id: threadId, body_md })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  async function dbReport({ target_type, target_id, reason }) {
    const { error } = await sb.from("reports").insert({ target_type, target_id, reason });
    if (error) throw error;
  }

  async function dbAdminReports(status="open") {
    const { data, error } = await sb.from("reports").select("*").eq("status", status).order("created_at", { ascending:false }).limit(200);
    if (error) throw error;
    return data || [];
  }

  async function dbAdminCloseReport(id, status="closed") {
    const { error } = await sb.from("reports").update({ status }).eq("id", id);
    if (error) throw error;
  }

  async function dbLockPage(slug, is_locked, lock_reason="") {
    const { error } = await sb.from("wiki_pages").update({ is_locked, lock_reason: lock_reason || null }).eq("slug", slug);
    if (error) throw error;
  }

  async function dbSetProtection(slug, protection_level) {
    const { error } = await sb.from("wiki_pages").update({ protection_level }).eq("slug", slug);
    if (error) throw error;
  }

  async function dbViewCountRpc(slug) {
    if (!CONFIG.enableViewCountRpc) return;
    const { error } = await sb.rpc("increment_view_count", { p_slug: slug });
    if (error) console.warn("view rpc failed", error);
  }

  // Stream records (optional)
  async function dbListStreams(slug, limit=6) {
    const { data, error } = await supabase
      .from("vtuber_streams")
      .select("*")
      .eq("vtuber_slug", slug)
      .order("started_at", { ascending:false })
      .limit(clamp(limit,1,20));
    if (error) return [];
    return data || [];
  }


  async function dbGetCategories(slug) {
    const page = await dbGetPage(slug);
    if (!page) return [];
    const { data, error } = await supabase
      .from("page_categories")
      .select("category")
      .eq("page_id", page.id)
      .order("category", { ascending: true });
    if (error) return [];
    return (data || []).map(x => x.category);
  }

  async function dbPagesByCategory(category, limit=80) {
    const { data, error } = await supabase
      .from("page_categories")
      .select("category,page_id,wiki_pages!inner(slug,title,updated_at)")
      .eq("category", category)
      .order("wiki_pages(updated_at)", { ascending: false })
      .limit(clamp(limit,1,200));
    if (error) throw error;
    return (data || []).map(r => r.wiki_pages);
  }

  async function dbInsertStream({ vtuber_slug, platform, title, url, started_at, duration_sec }) {
    const { data, error } = await supabase
      .from("vtuber_streams")
      .insert({ vtuber_slug, platform, title, url, started_at, duration_sec })
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  // ===========================
  // 6) ROUTER
  // ===========================
  const routes = [];
  function route(pattern, handler) { routes.push({ pattern, handler }); }
  function parseHash() {
    const h = location.hash || "#/";
    const path = h.replace(/^#/, "");
    return path.startsWith("/") ? path : "/" + path;
  }
  function matchRoute(path) {
    for (const r of routes) {
      const m = path.match(r.pattern);
      if (m) return { handler: r.handler, params: m.groups || {} };
    }
    return null;
  }

  async function navigate() {
    if (!mustConfig()) return;
    const path = parseHash();
    const m = matchRoute(path);
    if (!m) return render(notFoundView(path));
    try {
      setStatus("로딩 중…");
      await m.handler(m.params);
    } catch (e) {
      console.error(e);
      toast("오류", e?.message || String(e), "error");
      render(layoutCard("오류", `<p class="warn">${escapeHtml(e?.message || String(e))}</p>`));
    } finally {
      await refreshStatusLine();
    }
  }

  function render(html) {
    const view = $("#view");
    view.innerHTML = html;
    bindViewEvents();
  }

  // ===========================
  // 7) VIEWS
  // ===========================
  function layoutCard(title, innerHtml) {
    return `<div class="card"><h1>${escapeHtml(title)}</h1>${innerHtml}</div>`;
  }

  function notFoundView(path) {
    return layoutCard("404", `
      <p>페이지를 찾을 수 없습니다.</p>
      <div class="hr"></div>
      <div class="row gap10 flex-wrap">
        <a class="btn" href="#/">홈</a>
        <a class="btn" href="#/search">검색</a>
      </div>
      <div class="hr"></div>
      <div class="mono muted">${escapeHtml(path)}</div>
    `);
  }

  async function homeView() {
    const vt = await dbListVtubers({ limit: 24, order: "view_count" });
    const cards = vt.map(v => `
      <a class="card" href="#/v/${encodeURIComponent(v.slug)}">
        <div class="toolbar">
          <div class="left">
            <div style="font-weight:900; font-size:18px">${escapeHtml(v.display_name)}</div>
            <span class="pill"><span class="muted">조회</span> <b>${v.view_count}</b></span>
          </div>
          <div class="right">
            <span class="kbd">/v/${escapeHtml(v.slug)}</span>
          </div>
        </div>
        <div class="muted" style="margin-top:8px">${escapeHtml(v.agency || "개인/미상")}${v.generation ? ` · ${escapeHtml(v.generation)}` : ""}${v.debut_date ? ` · 데뷔 ${escapeHtml(v.debut_date)}` : ""}</div>
        <div class="chips" style="margin-top:10px">
          ${(v.tags || []).slice(0, 10).map(t => `<span class="chip">#${escapeHtml(t)}</span>`).join("")}
        </div>
      </a>
    `).join("");

    render(`
      <div class="grid" style="gap:18px">
        <div class="card">
          <h1>${escapeHtml(CONFIG.siteName)}</h1>
          <p>VTuber 정보 위키(문서/리비전/토론/검색/신고/보호레벨). <span class="kbd">3파일</span>만으로 운영.</p>
          <div class="hr"></div>
          <div class="row gap10 flex-wrap">
            <a class="btn" href="#/search">🔎 검색</a>
            <a class="btn" href="#/recent">🕒 최근 변경</a>
            <a class="btn ok" href="#/new">➕ 새 문서</a>
            <a class="btn" href="#/vt/new">➕ VTuber 등록</a>
            <a class="btn" href="#/admin">🛡️ 관리자</a>
          </div>
          <div class="hr"></div>
          <details class="cardlite">
            <summary class="muted">문서 문법</summary>
            <div style="margin-top:10px" class="muted">
              <div>• 위키 링크: <span class="kbd">[[airina]]</span> / <span class="kbd">[[airina|아이리나]]</span></div>
              <div>• 목차: <span class="kbd">__TOC__</span> (없어도 자동 생성)</div>
              <div>• 템플릿: <span class="kbd">{{InfoboxVTuber|name=...|agency=...|hashtags=#a,#b}}</span></div>
            </div>
          </details>
        </div>

        <div class="grid two">
          ${cards || `<div class="card"><p>아직 VTuber가 없습니다. <a class="btn" href="#/vt/new">첫 등록</a></p></div>`}
        </div>
      </div>
    `);
  }

  function protectionLabel(level) {
    const map = {
      0: "일반",
      1: "로그인만",
      2: "스태프",
      3: "관리자",
    };
    return map[level] || `L${level}`;
  }



  async function renderRecommendations(slug, vtuber) {
    if (!vtuber) return "";
    const agency = vtuber.agency || null;
    const generation = vtuber.generation || null;
    const tags = (vtuber.tags || []).slice(0, 5);

    const rec = new Map();

    // same agency / generation
    if (agency || generation) {
      let q = sb.from("vtubers")
        .select("slug,display_name,agency,generation,view_count,tags,updated_at")
        .eq("is_deleted", false)
        .neq("slug", slug);

      if (agency && generation) q = q.or(`agency.eq.${agency},generation.eq.${generation}`);
      else if (agency) q = q.eq("agency", agency);
      else if (generation) q = q.eq("generation", generation);

      const { data, error } = await q.limit(12);
      if (!error) for (const v of (data||[])) rec.set(v.slug, v);
    }

    // tag overlap
    for (const t of tags) {
      const { data, error } = await supabase
        .from("vtubers")
        .select("slug,display_name,agency,generation,view_count,tags,updated_at")
        .eq("is_deleted", false)
        .neq("slug", slug)
        .contains("tags", [t])
        .limit(8);
      if (!error) for (const v of (data||[])) rec.set(v.slug, v);
      if (rec.size >= 10) break;
    }

    const arr = Array.from(rec.values()).slice(0, 10);
    if (!arr.length) return "";

    const items = arr.map(v => `
      <a class="reco-item" href="#/v/${encodeURIComponent(v.slug)}">
        <div class="name">${escapeHtml(v.display_name)}</div>
        <div class="muted small" style="margin-top:6px">
          ${escapeHtml(v.agency || "개인/미상")}${v.generation ? ` · ${escapeHtml(v.generation)}` : ""}
        </div>
        <div class="chips" style="margin-top:8px">
          ${(v.tags||[]).slice(0,6).map(t=>`<span class="chip">#${escapeHtml(t)}</span>`).join("")}
        </div>
      </a>
    `).join("");

    return `
      <div class="reco">
        <div class="reco-head">
          <div class="reco-title">추천 문서</div>
          <span class="muted small">같은 소속/세대/태그</span>
        </div>
        <div class="reco-grid">${items}</div>
      </div>
    `;
  }

  async function renderStreamsWidget(slug) {
    const streams = await dbListStreams(slug, 5);
    if (!streams.length) return "";
    const items = streams.map(s => {
      const u = s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.title || s.url)}</a>` : escapeHtml(s.title || "");
      const dur = s.duration_sec ? `${Math.round(s.duration_sec/60)}m` : "";
      return `<div class="st-item">
        <div class="row gap10 flex-wrap">
          <span class="pill">${escapeHtml(s.platform || "stream")}</span>
          <span class="kbd">${escapeHtml(fmtTime(s.started_at))}</span>
          ${dur ? `<span class="pill"><span class="muted">길이</span> ${escapeHtml(dur)}</span>` : ""}
        </div>
        <div style="margin-top:8px">${u || `<span class="muted">(제목 없음)</span>`}</div>
      </div>`;
    }).join("");
    return `<div class="streams" style="margin-top:14px">
      <div class="st-head">
        <div class="st-title">최근 방송</div>
        <a class="btn" href="#/streams/${encodeURIComponent(slug)}">기록 추가</a>
      </div>
      <div class="hr"></div>
      ${items}
    </div>`;
  }

  async function buildAutoInfobox(slug, vtuber) {
    if (!vtuber) return "";
    const streams = await dbListStreams(slug, 5);
    const chips = []
    if (vtuber.fandom) chips.push(`팬덤: ${vtuber.fandom}`);
    if (vtuber.hashtags?.length) chips.push(...vtuber.hashtags.slice(0,8).map(h => h.startsWith("#")? h : "#"+h));
    const chipHtml = chips.map(c => `<span class="ib-chip">${escapeHtml(c)}</span>`).join("");

    const gridRows = [
      ["소속", vtuber.agency || "개인/미상"],
      ["세대/기수", vtuber.generation || "미상"],
      ["데뷔", vtuber.debut_date || "미상"],
      ["조회", String(vtuber.view_count || 0)],
    ];

    // platforms
    const plat = vtuber.platforms || {};
    const platHtml = Object.entries(plat).slice(0, 10).map(([k,v]) => {
      const u = String(v||"");
      return `<div><span class="k">${escapeHtml(k)}</span> <a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(u)}</a></div>`;
    }).join("");

    const streamHtml = streams.length ? streams.map(s => {
      const u = s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.title || s.url)}</a>` : escapeHtml(s.title || "");
      return `<div class="muted small">• ${escapeHtml(s.platform || "")} · ${escapeHtml(fmtTime(s.started_at))} · ${u}</div>`;
    }).join("") : `<div class="muted small">기록 없음</div>`;

    return `
      <div class="infobox">
        <div class="ib-title">
          <span>${escapeHtml(vtuber.display_name)}</span>
          <span class="kbd">VTuber</span>
        </div>
        <div class="ib-sub">${escapeHtml(slug)} · 자동 인포박스</div>
        <div class="ib-grid">
          ${gridRows.map(([k,v]) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`).join("")}
          <div class="k">플랫폼</div>
          <div class="v">${platHtml || `<span class="muted">없음</span>`}</div>
          <div class="k">방송 기록</div>
          <div class="v">${streamHtml}</div>
        </div>
        ${chipHtml ? `<div class="ib-chips" style="margin-top:10px">${chipHtml}</div>` : ""}
      </div>
      ${refed.footHtml || ""}
    `;
  }

  async function viewPageView({ slug }) {
    slug = normalizeSlug(slug);
    await dbViewCountRpc(slug);

    const [{ page, revision, content_md }, vtuber] = await Promise.all([
      dbGetCurrentContent(slug),
      dbGetVtuber(slug).catch(() => null),
    ]);

    const title = page?.title || vtuber?.display_name || slug;

    // 1) template infobox (optional)
    const { md: mdWithoutTpl, tpl } = extractTemplate(content_md, ["infoboxvtuber","infobox vtuber"]);
    let infoboxHtml = "";

    if (tpl) {
      const args = parseTemplateArgs(tpl);
      // If template omitted some fields, auto-fill from vtuber record
      if (vtuber) {
        args.name ||= vtuber.display_name;
        args.agency ||= vtuber.agency || "";
        args.generation ||= vtuber.generation || "";
        args.debut ||= vtuber.debut_date || "";
        if (!args.hashtags && vtuber.hashtags?.length) args.hashtags = vtuber.hashtags.join(",");
        if (!args.fandom && vtuber.fandom) args.fandom = vtuber.fandom;
        if (!args.platforms && vtuber.platforms) args.platforms = Object.values(vtuber.platforms).join(", ");
      }
      infoboxHtml = infoboxHtmlFromArgs(args);
    } else {
      // 2) auto infobox from vtubers table
      infoboxHtml = await buildAutoInfobox(slug, vtuber);
    }

    const protection = page?.protection_level ?? 0;

    const wikiBlock = renderMarkdownWithToc(mdWithoutTpl || content_md, { infoboxHtml });
    const meta = window.__vtwiki_last_render || { categories: [], redirect: null };
    const cats = meta.categories || [];
    const redirect = meta.redirect || null;

    const catBar = cats.length
      ? `<div class="catbar">${cats.map(c => `<a class="cat" href="#/cat/${encodeURIComponent(c.name)}">분류:${escapeHtml(c.name)}</a>`).join("")}</div>`
      : "";

    const streamsWidget = await renderStreamsWidget(slug);
    const recoWidget = await renderRecommendations(slug, vtuber);

    let redirectNotice = "";
    if (redirect?.target) {
      redirectNotice = `<div class="notice warn" style="margin-bottom:14px">
        <b>리다이렉트</b>: 이 문서는 <a class="btn" href="#/v/${encodeURIComponent(redirect.target)}">${escapeHtml(redirect.target)}</a> 로 연결됩니다.
        ${redirect.reason ? `<span class="muted">(${escapeHtml(redirect.reason)})</span>` : ""}
      </div>`;
      // optional: gentle auto-jump if the viewer stays here
      setTimeout(() => {
        if (location.hash === `#/v/${encodeURIComponent(slug)}`) {
          location.hash = `#/v/${encodeURIComponent(redirect.target)}`;
        }
      }, 900);
    }

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="toolbar">
            <div class="left" style="flex-wrap:wrap">
              <div>
                <h1 style="margin:0 0 6px">${escapeHtml(title)}</h1>
                <div class="muted">
                  슬러그 <span class="kbd">/v/${escapeHtml(slug)}</span>
                  ${page?.is_locked ? `<span class="pill warn">🔒 잠김 ${page.lock_reason ? "· " + escapeHtml(page.lock_reason) : ""}</span>` : ""}
                  <span class="pill">보호: <b>${escapeHtml(protectionLabel(protection))}</b></span>
                </div>
              </div>
            </div>
            <div class="right">
              <a class="btn" href="#/edit/${encodeURIComponent(slug)}">편집</a>
              <a class="btn" href="#/history/${encodeURIComponent(slug)}">역사</a>
              <a class="btn" href="#/talk/${encodeURIComponent(slug)}">토론</a>
              <button class="btn danger" data-report="page:${escapeHtml(page?.id || "")}">🚩 신고</button>
            </div>
          </div>
        </div>

        <div class="card">
          ${redirectNotice}
          ${wikiBlock}
          ${streamsWidget}
          ${recoWidget}
          ${catBar}
          <div class="hr"></div>
          <div class="row gap10 flex-wrap">
            <span class="muted small">현재 리비전:</span>
            <span class="kbd">${escapeHtml(revision?.id || "none")}</span>
            <span class="muted small">저장:</span>
            <span class="kbd">${escapeHtml(revision?.created_at ? fmtTime(revision.created_at) : "—")}</span>
          </div>
        </div>
      </div>
    `);

    // Smooth scroll for toc anchor links (#id)
    $$("a[href^='#']", $("#view")).forEach(a => {
      a.addEventListener("click", (e) => {
        const href = a.getAttribute("href") || "";
        // local anchor inside page (e.g. #section)
        if (/^#[a-z0-9\-]+$/i.test(href)) {
          e.preventDefault();
          const id = href.slice(1);
          const el = document.getElementById(id);
          if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
        }
      });
    });
  }

  async function newDocView() {
    render(layoutCard("새 문서", `
      <p>슬러그를 입력하면 편집 화면으로 이동합니다.</p>
      <div class="hr"></div>
      <label class="field">
        <div class="label">슬러그</div>
        <input id="newSlug" placeholder="예: airina / hololive-xyz" />
        <div class="help muted">영문/숫자/한글 가능</div>
      </label>
      <div class="row gap10 flex-wrap" style="margin-top:12px">
        <button class="btn ok" data-action="goNew">편집하러 가기</button>
        <a class="btn" href="#/">취소</a>
      </div>
    `));
  }

  async function editView({ slug }) {
    slug = normalizeSlug(slug);

    const user = await getUser();
    if (!user) {
      toast("로그인 필요", "편집하려면 로그인하세요.");
      $("#authModal").showModal();
      location.hash = `#/v/${encodeURIComponent(slug)}`;
      return;
    }

    const { page, content_md } = await dbGetCurrentContent(slug);
    const title = page?.title || slug;
    const protection = page?.protection_level ?? 0;

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="toolbar">
            <div class="left" style="flex-wrap:wrap">
              <div>
                <h1 style="margin:0 0 6px">편집: ${escapeHtml(slug)}</h1>
                <div class="muted">
                  저장하면 리비전이 쌓입니다.
                  ${page?.is_locked ? `<span class="pill warn">🔒 잠김</span>` : ""}
                  <span class="pill">보호: <b>${escapeHtml(protectionLabel(protection))}</b></span>
                </div>
              </div>
            </div>
            <div class="right">
              <a class="btn" href="#/v/${encodeURIComponent(slug)}">문서로</a>
              <a class="btn" href="#/history/${encodeURIComponent(slug)}">역사</a>
            </div>
          </div>
        </div>

        <div class="split">
          <div class="card">
            <label class="field">
              <div class="label">제목</div>
              <input id="editTitle" value="${escapeHtml(title)}" maxlength="120" />
            </label>
            <div style="height:10px"></div>
            <label class="field">
              <div class="label">요약</div>
              <input id="editSummary" placeholder="예: 오타 수정 / 데뷔일 추가" maxlength="160" />
            </label>
            <div class="hr"></div>

            <label class="field">
              <div class="label">내용(Markdown + 위키문법)</div>
              <textarea id="editMd">${escapeHtml(content_md)}</textarea>
              <div class="help muted">
                • 위키링크: <span class="kbd">[[문서]]</span>
                • 목차: <span class="kbd">__TOC__</span>
                • 인포박스: <span class="kbd">{{InfoboxVTuber|name=...|agency=...}}</span>
              </div>
            </label>

            <div class="row gap10 flex-wrap" style="margin-top:12px">
              <button class="btn ok" data-action="saveWiki" data-slug="${escapeHtml(slug)}">저장</button>
              <button class="btn" data-action="previewWiki">미리보기</button>
              <a class="btn" href="#/v/${encodeURIComponent(slug)}">취소</a>
            </div>

            <div class="hr"></div>
            <details class="cardlite">
              <summary class="muted">스태프 도구(잠금/보호레벨)</summary>
              <div class="grid gap12" style="margin-top:12px">
                <div class="row gap10 flex-wrap">
                  <button class="btn" data-action="lockPage" data-slug="${escapeHtml(slug)}" data-lock="1">잠금</button>
                  <button class="btn" data-action="lockPage" data-slug="${escapeHtml(slug)}" data-lock="0">잠금 해제</button>
                </div>
                <label class="field">
                  <div class="label">잠금 사유</div>
                  <input id="lockReason" placeholder="예: 훼손 방지" maxlength="120" />
                </label>
                <div class="hr"></div>
                <div class="muted small">보호레벨: 0=일반, 1=로그인만, 2=스태프, 3=관리자</div>
                <div class="row gap10 flex-wrap">
                  <button class="btn" data-action="setProtection" data-slug="${escapeHtml(slug)}" data-level="0">L0</button>
                  <button class="btn" data-action="setProtection" data-slug="${escapeHtml(slug)}" data-level="1">L1</button>
                  <button class="btn" data-action="setProtection" data-slug="${escapeHtml(slug)}" data-level="2">L2</button>
                  <button class="btn" data-action="setProtection" data-slug="${escapeHtml(slug)}" data-level="3">L3</button>
                </div>
              </div>
            </details>
          </div>

          <div class="card">
            <h2 style="margin-top:0">미리보기</h2>
            <div class="hr"></div>
            <div id="previewBox">${renderMarkdownWithToc(content_md, { infoboxHtml: "" })}</div>
          </div>
        </div>
      </div>
    `);
  }

  async function historyView({ slug }) {
    slug = normalizeSlug(slug);
    const { page, revisions } = await dbHistory(slug, 80);

    if (!page) {
      render(layoutCard("역사", `
        <p>문서가 없습니다.</p>
        <div class="hr"></div>
        <a class="btn ok" href="#/edit/${encodeURIComponent(slug)}">문서 만들기</a>
      `));
      return;
    }

    const items = revisions.map(r => `
      <div class="cardlite">
        <div class="toolbar">
          <div class="left flex-wrap">
            <span class="kbd">${escapeHtml(r.id)}</span>
            <span class="muted">${escapeHtml(r.summary || "(요약 없음)")}</span>
          </div>
          <div class="right">
            <span class="kbd">${escapeHtml(fmtTime(r.created_at))}</span>
            <button class="btn" data-action="openCompare" data-slug="${escapeHtml(slug)}" data-rev="${escapeHtml(r.id)}">비교</button>
            <button class="btn danger" data-action="revert" data-slug="${escapeHtml(slug)}" data-rev="${escapeHtml(r.id)}">되돌리기</button>
          </div>
        </div>
      </div>
    `).join("");

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="toolbar">
            <div class="left">
              <div>
                <h1 style="margin:0 0 6px">역사: ${escapeHtml(page.title)}</h1>
                <div class="muted">리비전 목록 · 되돌리기는 새 리비전 생성</div>
              </div>
            </div>
            <div class="right">
              <a class="btn" href="#/v/${encodeURIComponent(slug)}">문서로</a>
              <a class="btn ok" href="#/edit/${encodeURIComponent(slug)}">편집</a>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="grid" style="gap:10px">
            ${items || `<p class="muted">리비전이 없습니다.</p>`}
          </div>
        </div>

        <div class="card" id="comparePanel" style="display:none">
          <h2 style="margin-top:0">리비전 비교</h2>
          <div class="hr"></div>
          <div class="row gap10 flex-wrap">
            <span class="muted small">선택된 rev:</span><span class="kbd" id="cmpRev"></span>
            <button class="btn" data-action="closeCompare">닫기</button>
          </div>
          <div class="hr"></div>
          <div id="cmpBox"></div>
        </div>
      </div>
    `);
  }

  async function recentView() {
    const rows = await dbRecent(60);
    const items = rows.map(r => `
      <a class="card" href="#/v/${encodeURIComponent(r.wiki_pages.slug)}">
        <div class="toolbar">
          <div class="left">
            <div style="font-weight:900">${escapeHtml(r.wiki_pages.title)}</div>
            <span class="pill"><span class="muted">요약</span> ${escapeHtml(r.summary || "(없음)")}</span>
          </div>
          <div class="right">
            <span class="kbd">${escapeHtml(fmtTime(r.created_at))}</span>
          </div>
        </div>
        <div class="muted mono" style="margin-top:10px">/v/${escapeHtml(r.wiki_pages.slug)} · rev:${escapeHtml(r.id)}</div>
      </a>
    `).join("");

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <h1>최근 변경</h1>
          <p>최근 저장된 리비전 목록입니다.</p>
        </div>
        <div class="grid" style="gap:10px">
          ${items || `<div class="card"><p class="muted">아직 변경 내역이 없습니다.</p></div>`}
        </div>
      </div>
    `);
  }

  async function searchView() {
    const q = (new URLSearchParams(location.hash.split("?")[1] || "")).get("q") || "";

    render(layoutCard("검색", `
      <form id="searchForm">
        <input id="searchInput" name="q" value="${escapeHtml(q)}" placeholder="이름/슬러그/제목/내용, 태그는 #태그" />
      </form>
      <div class="hr"></div>
      <div id="searchResult">
        ${q ? `<div class="muted"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:95%"></div><div class="skeleton" style="width:80%"></div></div>` : `<p class="muted">검색어를 입력하세요.</p>`}
      </div>
    `));

    $("#searchForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const val = $("#searchInput").value.trim();
      location.hash = `#/search?q=${encodeURIComponent(val)}`;
    });

    if (q) {
      const res = await dbSearch(q);
      const vtHtml = (res.vtubers || []).map(v => `
        <a class="cardlite" href="#/v/${encodeURIComponent(v.slug)}">
          <div class="toolbar">
            <div class="left flex-wrap">
              <b>${escapeHtml(v.display_name)}</b>
              <span class="pill"><span class="muted">조회</span> ${escapeHtml(v.view_count || 0)}</span>
              ${v.generation ? `<span class="pill">${escapeHtml(v.generation)}</span>` : ""}
            </div>
            <div class="right"><span class="kbd">/v/${escapeHtml(v.slug)}</span></div>
          </div>
          <div class="chips" style="margin-top:10px">
            ${(v.tags || []).slice(0, 10).map(t => `<span class="chip">#${escapeHtml(t)}</span>`).join("")}
          </div>
        </a>
      `).join("");

      const pageHtml = (res.pages || []).map(p => `
        <a class="cardlite" href="#/v/${encodeURIComponent(p.slug)}">
          <div class="toolbar">
            <div class="left flex-wrap">
              <b>${escapeHtml(p.title)}</b>
              ${p.is_locked ? `<span class="pill warn">🔒 잠김</span>` : ""}
              <span class="pill">보호 <b>${escapeHtml(protectionLabel(p.protection_level ?? 0))}</b></span>
            </div>
            <div class="right"><span class="kbd">/v/${escapeHtml(p.slug)}</span></div>
          </div>
        </a>
      `).join("");

      const hitHtml = (res.hits || []).map(h => `
        <a class="cardlite" href="#/v/${encodeURIComponent(h.wiki_pages.slug)}">
          <div class="toolbar">
            <div class="left flex-wrap">
              <b>${escapeHtml(h.wiki_pages.title)}</b>
              <span class="muted">${escapeHtml(h.summary || "(요약 없음)")}</span>
            </div>
            <div class="right"><span class="kbd">${escapeHtml(fmtTime(h.created_at))}</span></div>
          </div>
          <div class="muted mono" style="margin-top:8px">rev:${escapeHtml(h.id)}</div>
        </a>
      `).join("");

      setHTML("searchResult", `
        <div class="grid" style="gap:14px">
          <div class="card">
            <h2 style="margin-top:0">VTuber</h2>
            <div class="hr"></div>
            <div class="grid" style="gap:10px">${vtHtml || `<p class="muted">결과 없음</p>`}</div>
          </div>
          <div class="card">
            <h2 style="margin-top:0">문서(제목/슬러그)</h2>
            <div class="hr"></div>
            <div class="grid" style="gap:10px">${pageHtml || `<p class="muted">결과 없음</p>`}</div>
          </div>
          <div class="card">
            <h2 style="margin-top:0">문서 내용(리비전)</h2>
            <div class="hr"></div>
            <div class="grid" style="gap:10px">${hitHtml || `<p class="muted">결과 없음</p>`}</div>
          </div>
        </div>
      `);
    }
  }


  async function streamsFormView({ slug }) {
    slug = normalizeSlug(slug);
    const user = await getUser();
    if (!user) { toast("로그인 필요", "방송 기록 추가"); $("#authModal").showModal(); location.hash = `#/v/${encodeURIComponent(slug)}`; return; }

    const vt = await dbGetVtuber(slug).catch(()=>null);
    if (!vt) {
      render(layoutCard("방송 기록", `
        <p>VTuber가 등록되지 않았습니다. 먼저 VTuber 등록을 해주세요.</p>
        <div class="hr"></div>
        <a class="btn ok" href="#/vt/new">VTuber 등록</a>
        <a class="btn" href="#/v/${encodeURIComponent(slug)}">문서로</a>
      `));
      return;
    }

    const recent = await dbListStreams(slug, 10);

    render(`
      <div class="grid two">
        <div class="card">
          <h1>방송 기록 추가</h1>
          <p class="muted">${escapeHtml(vt.display_name)} · <span class="kbd">${escapeHtml(slug)}</span></p>
          <div class="hr"></div>

          <form id="streamForm" class="grid gap12">
            <label class="field"><div class="label">플랫폼</div>
              <select id="stPlatform">
                <option value="twitch">twitch</option>
                <option value="youtube">youtube</option>
                <option value="chzzk">chzzk</option>
                <option value="afreeca">afreeca</option>
                <option value="other">other</option>
              </select>
            </label>
            <label class="field"><div class="label">제목</div><input id="stTitle" placeholder="예: 저스트 채팅" /></label>
            <label class="field"><div class="label">URL</div><input id="stUrl" placeholder="https://..." /></label>
            <label class="field"><div class="label">시작 시간</div><input id="stAt" placeholder="2026-01-15T20:00:00+09:00" /></label>
            <label class="field"><div class="label">길이(초, 선택)</div><input id="stDur" placeholder="3600" /></label>
            <div class="row gap10 flex-wrap">
              <button class="btn ok" type="submit">저장</button>
              <a class="btn" href="#/v/${encodeURIComponent(slug)}">문서로</a>
            </div>
          </form>
          <div class="hr"></div>
          <details class="cardlite">
            <summary class="muted">문서에 자동 삽입</summary>
            <div class="muted small" style="margin-top:10px">
              이 페이지에서 저장된 방송 기록은 문서 상단의 <b>최근 방송</b> 위젯에 자동 표시됩니다.
            </div>
          </details>
        </div>

        <div class="card">
          <h2 style="margin-top:0">최근 기록</h2>
          <div class="hr"></div>
          <div class="grid" style="gap:10px">
            ${recent.map(s => `
              <div class="cardlite">
                <div class="row gap10 flex-wrap">
                  <span class="pill">${escapeHtml(s.platform || "")}</span>
                  <span class="kbd">${escapeHtml(fmtTime(s.started_at))}</span>
                </div>
                <div class="muted" style="margin-top:8px">${escapeHtml(s.title || "")}</div>
                ${s.url ? `<div class="mono small" style="margin-top:6px"><a href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">${escapeHtml(s.url)}</a></div>` : ""}
              </div>
            `).join("") || `<p class="muted">없음</p>`}
          </div>
        </div>
      </div>
    `);

    $("#streamForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const ok = RL.check("stream");
      if (!ok.ok) return toast("제한", ok.msg, "error");
      try {
        const platform = $("#stPlatform").value;
        const title = $("#stTitle").value.trim().slice(0, 160);
        const url = $("#stUrl").value.trim().slice(0, 500) || null;
        const at = $("#stAt").value.trim();
        const started_at = at ? new Date(at).toISOString() : new Date().toISOString();
        const duration_sec = $("#stDur").value.trim() ? Number($("#stDur").value.trim()) : null;

        await dbInsertStream({ vtuber_slug: slug, platform, title, url, started_at, duration_sec });
        RL.bump("stream");
        toast("저장됨");
        location.hash = `#/streams/${encodeURIComponent(slug)}`;
      } catch (err) {
        toast("실패", err?.message || String(err), "error");
      }
    });
  }

  async function vtNewView() {
    const user = await getUser();
    if (!user) {
      toast("로그인 필요", "VTuber 등록은 로그인 후 가능합니다.");
      $("#authModal").showModal();
      location.hash = "#/";
      return;
    }

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <h1>VTuber 등록</h1>
          <p>VTuber 프로필 + 동일 슬러그의 위키 문서를 함께 운영합니다.</p>
        </div>
        <div class="card">
          <form id="vtForm" class="grid gap12">
            <label class="field"><div class="label">슬러그</div><input id="vtSlug" placeholder="예: airina" required /></label>
            <label class="field"><div class="label">표시 이름</div><input id="vtName" placeholder="예: Airina" required /></label>
            <label class="field"><div class="label">소속</div><input id="vtAgency" placeholder="예: 개인 / hololive / ..." /></label>
            <label class="field"><div class="label">세대/기수</div><input id="vtGen" placeholder="예: 0기 / 1기 / 2nd gen" /></label>
            <label class="field"><div class="label">데뷔일</div><input id="vtDebut" placeholder="YYYY-MM-DD" /></label>
            <label class="field"><div class="label">팬덤</div><input id="vtFandom" placeholder="예: Airinators" /></label>
            <label class="field"><div class="label">해시태그</div><input id="vtHash" placeholder="#fanart #live" /></label>
            <label class="field"><div class="label">태그</div><input id="vtTags" placeholder="#kawaii #twitch #korea" /></label>
            <label class="field"><div class="label">플랫폼 링크(JSON)</div>
              <textarea id="vtPlatforms" style="min-height:120px" placeholder='{"twitch":"https://twitch.tv/...","youtube":"https://youtube.com/@..."}'></textarea>
            </label>
            <label class="field"><div class="label">짧은 소개</div><textarea id="vtBio" style="min-height:140px" placeholder="프로필 카드 소개"></textarea></label>
            <div class="row gap10 flex-wrap">
              <button class="btn ok" type="submit">등록</button>
              <a class="btn" href="#/">취소</a>
            </div>
          </form>
        </div>
      </div>
    `);

    $("#vtForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const slug = normalizeSlug($("#vtSlug").value);
        const display_name = $("#vtName").value.trim();
        if (!slug || !display_name) throw new Error("슬러그/이름 필수");

        let platforms = {};
        const txt = $("#vtPlatforms").value.trim();
        if (txt) {
          try { platforms = JSON.parse(txt); }
          catch { throw new Error("플랫폼 JSON이 올바르지 않습니다."); }
        }

        const tags = parseTags($("#vtTags").value);
        const hashtags = parseTags($("#vtHash").value).map(t => t.startsWith("#") ? t : "#"+t);

        await dbUpsertVtuber({
          slug,
          display_name,
          agency: $("#vtAgency").value.trim() || null,
          generation: $("#vtGen").value.trim() || null,
          debut_date: $("#vtDebut").value.trim() || null,
          fandom: $("#vtFandom").value.trim() || null,
          hashtags,
          bio: $("#vtBio").value || "",
          platforms,
          tags,
          is_deleted: false,
        });

        await dbEnsurePage(slug, display_name);
        toast("등록 완료", slug);
        location.hash = `#/v/${encodeURIComponent(slug)}`;
      } catch (err) {
        toast("등록 실패", err?.message || String(err), "error");
      }
    });
  }

  async function talkView({ slug }) {
    slug = normalizeSlug(slug);
    const page = await dbGetPage(slug);
    if (!page) {
      render(layoutCard("토론", `
        <p>문서가 없습니다.</p>
        <div class="hr"></div>
        <a class="btn ok" href="#/edit/${encodeURIComponent(slug)}">문서 만들기</a>
      `));
      return;
    }

    const threads = await dbThreads(slug, 60);
    const items = threads.map(t => `
      <a class="cardlite" href="#/thread/${encodeURIComponent(t.id)}">
        <div class="toolbar">
          <div class="left flex-wrap">
            <b>${escapeHtml(t.title)}</b>
            ${t.is_locked ? `<span class="pill warn">🔒</span>` : ""}
          </div>
          <div class="right">
            <span class="kbd">${escapeHtml(fmtTime(t.created_at))}</span>
          </div>
        </div>
      </a>
    `).join("");

    render(`
      <div class="grid two">
        <div class="card">
          <h1>토론: ${escapeHtml(page.title)}</h1>
          <p>문서 단위 토론 스레드</p>
          <div class="hr"></div>
          <form id="threadForm" class="grid gap12">
            <label class="field">
              <div class="label">새 토론 제목</div>
              <input id="threadTitle" placeholder="예: 정보 출처 논의" required />
            </label>
            <div class="row gap10 flex-wrap">
              <button class="btn ok" type="submit">스레드 생성</button>
              <a class="btn" href="#/v/${encodeURIComponent(slug)}">문서로</a>
            </div>
          </form>
          <div class="hr"></div>
          <div class="grid" style="gap:10px">${items || `<p class="muted">스레드 없음</p>`}</div>
        </div>

        <div class="card">
          <h2>토론 가이드</h2>
          <p>• 출처 링크/타임스탬프를 함께 달면 검증이 쉬움</p>
          <p>• 비방/허위정보는 신고될 수 있음</p>
          <div class="hr"></div>
          <button class="btn danger" data-report="page:${escapeHtml(page.id)}">🚩 문서 신고</button>
        </div>
      </div>
    `);

    $("#threadForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = await getUser();
      if (!user) { toast("로그인 필요", "토론 생성은 로그인 필요"); $("#authModal").showModal(); return; }
      try {
        const th = await dbCreateThread(slug, $("#threadTitle").value.trim());
        toast("스레드 생성", th.title);
        location.hash = `#/thread/${encodeURIComponent(th.id)}`;
      } catch (err) {
        toast("실패", err?.message || String(err), "error");
      }
    });
  }

  async function threadView({ id }) {
    const { data: thread, error } = await sb.from("discussion_threads").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!thread) { render(notFoundView("/thread/" + id)); return; }

    const posts = await dbPosts(id, 300);
    const list = posts.map(p => `
      <div class="cardlite">
        <div class="toolbar">
          <div class="left">
            <span class="kbd">${escapeHtml(fmtTime(p.created_at))}</span>
          </div>
          <div class="right">
            <button class="btn danger" data-report="post:${escapeHtml(p.id)}">🚩 신고</button>
          </div>
        </div>
        <div class="hr"></div>
        <div style="white-space:pre-wrap">${escapeHtml(p.body_md)}</div>
      </div>
    `).join("");

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="toolbar">
            <div class="left" style="flex-wrap:wrap">
              <div>
                <h1 style="margin:0 0 6px">${escapeHtml(thread.title)}</h1>
                <div class="muted">thread <span class="kbd">${escapeHtml(thread.id)}</span> ${thread.is_locked ? `<span class="pill warn">🔒 잠김</span>` : ""}</div>
              </div>
            </div>
            <div class="right">
              <a class="btn" href="javascript:history.back()">뒤로</a>
              <button class="btn danger" data-report="thread:${escapeHtml(thread.id)}">🚩 스레드 신고</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2 style="margin-top:0">댓글</h2>
          <div class="hr"></div>
          <div class="grid" style="gap:10px">${list || `<p class="muted">댓글 없음</p>`}</div>
          <div class="hr"></div>

          <form id="postForm" class="grid gap12">
            <label class="field">
              <div class="label">답글</div>
              <textarea id="postBody" style="min-height:140px" placeholder="내용..." required></textarea>
            </label>
            <div class="row gap10 flex-wrap">
              <button class="btn ok" type="submit">등록</button>
              <button class="btn" type="button" data-action="reloadThread">새로고침</button>
            </div>
          </form>
        </div>
      </div>
    `);

    $("#postForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = await getUser();
      if (!user) { toast("로그인 필요", "댓글은 로그인 필요"); $("#authModal").showModal(); return; }
      if (thread.is_locked) { toast("잠김", "이 스레드는 잠겼습니다.", "error"); return; }

      const ok = RL.check("post");
      if (!ok.ok) return toast("제한", ok.msg, "error");

      try {
        await dbCreatePost(id, $("#postBody").value.slice(0, 5000));
        RL.bump("post");
        toast("등록 완료");
        location.hash = `#/thread/${encodeURIComponent(id)}`;
      } catch (err) {
        toast("실패", err?.message || String(err), "error");
      }
    });
  }


  async function categoryView({ name }) {
    const category = decodeURIComponent(name || "").trim();
    if (!category) { render(layoutCard("분류", "<p class='muted'>분류명이 없습니다.</p>")); return; }
    const pages = await dbPagesByCategory(category, 120);
    const items = pages.map(p => `
      <a class="cardlite" href="#/v/${encodeURIComponent(p.slug)}">
        <div class="toolbar">
          <div class="left flex-wrap">
            <b>${escapeHtml(p.title)}</b>
            <span class="kbd">/v/${escapeHtml(p.slug)}</span>
          </div>
          <div class="right"><span class="kbd">${escapeHtml(fmtTime(p.updated_at))}</span></div>
        </div>
      </a>
    `).join("");

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <h1>분류: ${escapeHtml(category)}</h1>
          <p class="muted">문서 ${pages.length}개</p>
          <div class="hr"></div>
          <div class="row gap10 flex-wrap">
            <a class="btn" href="#/search?q=${encodeURIComponent("#"+category)}">태그 검색</a>
            <a class="btn" href="#/">홈</a>
          </div>
        </div>
        <div class="card">
          <div class="grid" style="gap:10px">${items || `<p class="muted">비어있음</p>`}</div>
        </div>
      </div>
    `);
  }

  async function adminView() {
    const user = await getUser();
    if (!user) { toast("로그인 필요", "관리자 페이지"); $("#authModal").showModal(); location.hash="#/"; return; }
    const profile = await getProfile(user.id);
    const role = profile?.role || "user";
    if (!["admin","mod"].includes(role)) {
      render(layoutCard("권한 없음", `
        <p>스태프만 접근 가능합니다.</p>
        <div class="hr"></div>
        <div class="muted">현재 role: <span class="kbd">${escapeHtml(role)}</span></div>
      `));
      return;
    }

    const [open, closed] = await Promise.all([dbAdminReports("open"), dbAdminReports("closed")]);
    const renderReports = (arr) => arr.map(r => `
      <div class="cardlite">
        <div class="toolbar">
          <div class="left flex-wrap">
            <span class="pill">${escapeHtml(r.target_type)}</span>
            <span class="kbd">${escapeHtml(r.target_id)}</span>
          </div>
          <div class="right">
            <span class="kbd">${escapeHtml(fmtTime(r.created_at))}</span>
            ${r.status === "open" ? `<button class="btn ok" data-action="closeReport" data-id="${escapeHtml(r.id)}">닫기</button>` : ""}
          </div>
        </div>
        <div class="hr"></div>
        <div class="muted" style="white-space:pre-wrap">${escapeHtml(r.reason)}</div>
      </div>
    `).join("");

    render(`
      <div class="grid" style="gap:14px">
        <div class="card">
          <div class="toolbar">
            <div class="left">
              <div>
                <h1 style="margin:0 0 6px">관리자</h1>
                <div class="muted">role: <span class="kbd">${escapeHtml(role)}</span> · 사용자: <span class="kbd">${escapeHtml(user.email || user.id)}</span></div>
              </div>
            </div>
            <div class="right">
              <a class="btn" href="#/">홈</a>
            </div>
          </div>
        </div>

        <div class="grid two">
          <div class="card">
            <h2 style="margin-top:0">신고(open)</h2>
            <div class="hr"></div>
            <div class="grid" style="gap:10px">${renderReports(open) || `<p class="muted">없음</p>`}</div>
          </div>
          <div class="card">
            <h2 style="margin-top:0">신고(closed)</h2>
            <div class="hr"></div>
            <div class="grid" style="gap:10px">${renderReports(closed) || `<p class="muted">없음</p>`}</div>
          </div>
        </div>
      </div>
    `);
  }

  // ===========================
  // 8) EVENTS
  // ===========================
  function bindViewEvents() {
    // data-action buttons
    $$("[data-action]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.action;
        try {
          if (action === "goNew") {
            const slug = normalizeSlug($("#newSlug").value);
            if (!slug) return toast("슬러그 필요");
            location.hash = `#/edit/${encodeURIComponent(slug)}`;
          }

          if (action === "previewWiki") {
            const md = $("#editMd").value;
            const { md: mdNoTpl, tpl } = extractTemplate(md, ["infoboxvtuber","infobox vtuber"]);
            let ib = "";
            if (tpl) ib = infoboxHtmlFromArgs(parseTemplateArgs(tpl));
            setHTML("previewBox", renderMarkdownWithToc(mdNoTpl, { infoboxHtml: ib }));
            toast("미리보기 갱신");
          }

          if (action === "saveWiki") {
            const slug = normalizeSlug(btn.dataset.slug);
            const title = $("#editTitle").value.trim().slice(0,120) || slug;
            const summary = $("#editSummary").value.trim().slice(0,160);
            const content_md = $("#editMd").value;

            if (!content_md.trim()) throw new Error("내용이 비었습니다.");
            if (content_md.length > CONFIG.maxMd) throw new Error("문서가 너무 깁니다.");

            const user = await getUser();
            if (!user) { $("#authModal").showModal(); throw new Error("로그인 필요"); }

            const ok = RL.check("edit");
            if (!ok.ok) throw new Error(ok.msg);

            // warn on vandal-like changes (client warning only)
            const { content_md: oldMd } = await dbGetCurrentContent(slug);
            const warn = vandalHeuristic(oldMd, content_md);
            if (warn) toast("주의", warn);

            const page = await dbEnsurePage(slug, title);

            const rev = await dbInsertRevision({ pageId: page.id, summary, content_md });
            await dbSetCurrentRevision(page.id, rev.id);

            RL.bump("edit");
            toast("저장됨", `rev ${rev.id}`);
            location.hash = `#/v/${encodeURIComponent(slug)}`;
          }

          if (action === "revert") {
            const slug = normalizeSlug(btn.dataset.slug);
            const revId = btn.dataset.rev;

            const user = await getUser();
            if (!user) { $("#authModal").showModal(); throw new Error("로그인 필요"); }

            const ok = RL.check("edit");
            if (!ok.ok) throw new Error(ok.msg);

            const page = await dbGetPage(slug);
            const rev = await dbGetRevision(revId);
            if (!page || !rev) throw new Error("대상 없음");

            const newRev = await dbInsertRevision({ pageId: page.id, summary: `Revert to ${revId}`, content_md: rev.content_md });
            await dbSetCurrentRevision(page.id, newRev.id);

            RL.bump("edit");
            toast("되돌림 완료", newRev.id);
            location.hash = `#/v/${encodeURIComponent(slug)}`;
          }

          if (action === "openCompare") {
            const slug = normalizeSlug(btn.dataset.slug);
            const revId = btn.dataset.rev;
            const { content_md: currentMd } = await dbGetCurrentContent(slug);
            const other = await dbGetRevision(revId);
            if (!other) throw new Error("리비전 없음");

            $("#comparePanel").style.display = "block";
            setText("cmpRev", revId);
            setHTML("cmpBox", diffHtml(other.content_md, currentMd));
            toast("비교 표시");
          }

          if (action === "closeCompare") $("#comparePanel").style.display = "none";

          if (action === "lockPage") {
            const slug = normalizeSlug(btn.dataset.slug);
            const lock = btn.dataset.lock === "1";
            const reason = ($("#lockReason")?.value || "").trim();

            const user = await getUser();
            if (!user) { $("#authModal").showModal(); throw new Error("로그인 필요"); }
            const profile = await getProfile(user.id);
            if (!profile || !["admin","mod"].includes(profile.role)) throw new Error("스태프만 가능");

            await dbLockPage(slug, lock, reason);
            toast(lock ? "잠김" : "잠금 해제");
            location.hash = `#/edit/${encodeURIComponent(slug)}`;
          }

          if (action === "setProtection") {
            const slug = normalizeSlug(btn.dataset.slug);
            const level = Number(btn.dataset.level || 0);

            const user = await getUser();
            if (!user) { $("#authModal").showModal(); throw new Error("로그인 필요"); }
            const profile = await getProfile(user.id);
            if (!profile || !["admin","mod"].includes(profile.role)) throw new Error("스태프만 가능");

            await dbSetProtection(slug, level);
            toast("보호레벨 변경", protectionLabel(level));
            location.hash = `#/edit/${encodeURIComponent(slug)}`;
          }

          if (action === "reloadThread") {
            const path = parseHash();
            location.hash = "#/"; 
            await sleep(10);
            location.hash = path;
          }

          if (action === "closeReport") {
            const id = btn.dataset.id;

            const user = await getUser();
            if (!user) { $("#authModal").showModal(); throw new Error("로그인 필요"); }
            const profile = await getProfile(user.id);
            if (!profile || !["admin","mod"].includes(profile.role)) throw new Error("스태프만 가능");

            await dbAdminCloseReport(id, "closed");
            toast("처리 완료");
            location.hash = "#/admin";
          }

        } catch (err) {
          toast("실패", err?.message || String(err), "error");
        }
      });
    });

    // report buttons
    $$("[data-report]").forEach(btn => btn.addEventListener("click", () => openReport(btn.dataset.report)));
  }

  function diffHtml(a, b) {
    const parts = Diff.diffLines(String(a||""), String(b||""));
    const html = parts.map(p => {
      const klass = p.added ? "oktxt" : p.removed ? "warn" : "muted";
      const sign = p.added ? "+ " : p.removed ? "- " : "  ";
      return `<div class="${klass} mono" style="white-space:pre-wrap">${escapeHtml(sign + p.value)}</div>`;
    }).join("");
    return `<div class="cardlite">${html}</div>`;
  }

  // ===========================
  // 9) AUTH MODAL
  // ===========================
  let authMode = "login";

  function setAuthMode(mode) {
    authMode = mode;
    $$(".tab").forEach(t => t.classList.toggle("is-active", t.dataset.tab === mode));
    setText("authSubmit", mode === "signup" ? "회원가입" : "로그인");
    $("#authUserWrap").style.display = mode === "signup" ? "block" : "none";
    $("#authPass").setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
  }

  async function refreshAuthBtn() {
    const user = await getUser();
    const btn = $("#authBtn");
    const logout = $("#authLogout");
    if (btn) {
        if (user) btn.textContent = "계정"; else btn.textContent = "로그인";
      }
      if (logout) {
        logout.style.display = user ? "inline-block" : "none";
      }
  }

  async function refreshStatusLine() {
    const user = await getUser();
    if (!user) return setStatus("게스트 · 읽기 전용(쓰기=로그인+RLS)");
    const profile = await getProfile(user.id);
    setStatus(`${profile?.username || user.email || "user"} · role:${profile?.role || "user"} · ${user.id.slice(0,8)}…`);
  }

  
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

  function isAbortError(err) {
    return (err && (err.name === "AbortError" || String(err?.message || "").toLowerCase().includes("aborted")));
  }

  function isEmailConfirmError(err) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("confirm") || msg.includes("verify") || msg.includes("not confirmed") || msg.includes("email not confirmed");
  }

function bindAuthModal() {
    const modal = $("#authModal");
    $("#authBtn").addEventListener("click", () => modal.showModal());
    $$(".tab", modal).forEach(t => t.addEventListener("click", () => setAuthMode(t.dataset.tab)));

    $("#authMagic").addEventListener("click", async () => {
      try {
        const email = $("#authEmail").value.trim().toLowerCase();
        if (!email) throw new Error("이메일 필요");
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: (location.origin + location.pathname)} });
        if (error) throw error;
        toast("매직링크 발송", email);
      } catch (e) { toast("실패", e?.message || String(e), "error"); }
    });

    $("#oauthGithub").addEventListener("click", async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: "github" });
      if (error) toast("OAuth 실패", error.message, "error");
    });
    $("#oauthGoogle").addEventListener("click", async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: "google" });
      if (error) toast("OAuth 실패", error.message, "error");
    });

    $("#authLogout").addEventListener("click", async () => {
      await sb.auth.signOut();
      toast("로그아웃");
      await refreshAuthBtn();
      await refreshStatusLine();
    });

    $("#authForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const email = $("#authEmail").value.trim().toLowerCase();
        const pass = $("#authPass").value;
        const username = ($("#authUsername")?.value || "").trim();
        if (!email || !pass) throw new Error("이메일/비밀번호 필요");

        if (authMode === "signup") {
          const { data, error } = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: (location.origin + location.pathname)} });
          if (error) throw error;
          await ensureProfile(data.user, username);
          toast("가입 완료", "이메일로 인증 링크가 갔어. 메일에서 확인 후 로그인해줘. (필요하면 매직링크 버튼도 사용 가능)");
        } else {
          let data, error;
          try {
            ({ data, error } = await sb.auth.signInWithPassword({ email, password: pass }));
          } catch (e) {
            if (isAbortError(e)) {
              // retry once after a short delay (often fixes aborted fetch caused by rapid state changes)
              await sleep(300);
              ({ data, error } = await sb.auth.signInWithPassword({ email, password: pass }));
            } else {
              throw e;
            }
          }
          if (error) {
            // Supabase requires email confirmation before password sign-in.
            if (isEmailConfirmError(error)) {
              // Auto-send a magic link to finish verification / login.
              const { error: otpErr } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: (location.origin + location.pathname) } });
              if (otpErr && isAbortError(otpErr)) { return; }
              if (!otpErr) {
                toast("이메일 인증 필요", "비밀번호 로그인 전에 이메일 인증이 필요해. 방금 로그인 링크를 이메일로 보냈어.", "warn");
                return;
              }
            }
            throw error;
          }
          await ensureProfile(data.user, null);
          toast("로그인 완료");
        }

        await refreshAuthBtn();
        await refreshStatusLine();
        $("#authModal").close();
      } catch (err) {
        if (isAbortError(err)) {
          toast("요청이 취소됨", "로그인 요청이 중간에 취소됐어. (중복 클릭/페이지 이동/확장프로그램 영향) 다시 시도해줘.", "warn");
        } else if (isEmailConfirmError(err)) {
          toast("이메일 인증 필요", "메일함에서 인증 링크를 눌러야 비밀번호 로그인이 가능해. 또는 매직링크로 로그인해줘.", "warn");
        } else {
          toast("인증 실패", err?.message || String(err), "error");
        }
      }
    });

    setAuthMode("login");
  }

  // ===========================
  // 10) REPORT MODAL
  // ===========================
  let currentReport = null;
  function openReport(str) {
    const [type, id] = String(str || "").split(":");
    currentReport = { type, id };
    setText("reportTarget", `${type}:${id || "unknown"}`);
    setVal("reportReason", "");
    $("#reportModal").showModal();
  }

  function bindReportModal() {
    $("#reportForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const user = await getUser();
        if (!user) { $("#authModal").showModal(); throw new Error("로그인 필요"); }
        if (!currentReport?.type || !currentReport?.id) throw new Error("대상 없음");
        const reason = $("#reportReason").value.trim();
        if (!reason) throw new Error("사유 필요");

        await dbReport({ target_type: currentReport.type, target_id: currentReport.id, reason });
        toast("신고 접수", "검토 후 조치됩니다.");
        $("#reportModal").close();
      } catch (err) { toast("신고 실패", err?.message || String(err), "error"); }
    });
  }

  // ===========================
  // 11) COMMAND PALETTE + HOTKEYS
  // ===========================
  function bindCmdPalette() {
    const modal = $("#cmdModal");
    const input = $("#cmdInput");

    $("#cmdForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const cmd = input.value.trim();
      modal.close();
      runCmd(cmd);
    });

    function open() {
      modal.showModal();
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }

    document.addEventListener("keydown", (e) => {
  const key = (typeof e?.key === "string") ? e.key.toLowerCase() : "";
  if (!key) return;

  // 기존 단축키 로직 유지
  if (key === "escape") {
    const modal = document.querySelector("dialog[open]");
    if (modal) modal.close();
  }
  if (key === "enter") {
    const btn = document.querySelector("button.ok");
    if (btn) btn.click();
  }
});
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
  }

  function getActiveSlug() {
    const path = parseHash();
    const m =
      path.match(/^\/v\/(?<slug>[^\/\?]+)$/) ||
      path.match(/^\/edit\/(?<slug>[^\/\?]+)$/) ||
      path.match(/^\/history\/(?<slug>[^\/\?]+)$/) ||
      path.match(/^\/talk\/(?<slug>[^\/\?]+)$/);
    return m?.groups?.slug ? normalizeSlug(decodeURIComponent(m.groups.slug)) : null;
  }

  function runCmd(cmd) {
    if (!cmd) return;
    const lower = cmd.toLowerCase();
    if (cmd.startsWith("/")) return (location.hash = `#/v/${encodeURIComponent(normalizeSlug(cmd.slice(1)))}`);
    if (lower.startsWith("search ")) return (location.hash = `#/search?q=${encodeURIComponent(cmd.slice(7).trim())}`);
    if (lower === "recent") return (location.hash = "#/recent");
    if (lower === "new") return (location.hash = "#/new");
    if (lower === "admin") return (location.hash = "#/admin");
    if (lower === "vt") return (location.hash = "#/vt/new");
    return (location.hash = `#/v/${encodeURIComponent(normalizeSlug(cmd))}`);
  }

  // ===========================
  // 12) ROUTES
  // ===========================
  route(/^\/$/, () => homeView());
  route(/^\/new$/, () => newDocView());
  route(/^\/search(?:\?.*)?$/, () => searchView());
  route(/^\/recent$/, () => recentView());
  route(/^\/admin$/, () => adminView());
  route(/^\/cat\/(?<name>[^\/\?]+)$/, (p) => categoryView({ name: p.name }));
  route(/^\/streams\/(?<slug>[^\/\?]+)$/, (p) => streamsFormView({ slug: decodeURIComponent(p.slug) }));
  route(/^\/vt\/new$/, () => vtNewView());
  route(/^\/v\/(?<slug>[^\/\?]+)$/, (p) => viewPageView({ slug: decodeURIComponent(p.slug) }));
  route(/^\/edit\/(?<slug>[^\/\?]+)$/, (p) => editView({ slug: decodeURIComponent(p.slug) }));
  route(/^\/history\/(?<slug>[^\/\?]+)$/, (p) => historyView({ slug: decodeURIComponent(p.slug) }));
  route(/^\/talk\/(?<slug>[^\/\?]+)$/, (p) => talkView({ slug: decodeURIComponent(p.slug) }));
  route(/^\/thread\/(?<id>[^\/\?]+)$/, (p) => threadView({ id: decodeURIComponent(p.id) }));

  // ===========================
  // 13) THEME TOGGLE
  // ===========================
  function bindTheme() {
    const btn = $("#themeBtn");
    if (!btn) return;

    const KEY = "vtwiki_theme";
    function apply(mode) {
      const m = (mode === "light") ? "light" : "dark";
      document.documentElement.dataset.theme = m;
      btn.textContent = (m === "dark") ? "테마: 다크" : "테마: 라이트";
      localStorage.setItem(KEY, m);
    }

    apply(localStorage.getItem(KEY) || "dark");

    btn.addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || "dark";
      apply(cur === "dark" ? "light" : "dark");
    });
  }

  // ===========================
  // 14) BOOT
  // ===========================
  async function boot() {
    document.title = CONFIG.siteName;
    if (!window.supabase || !window.marked || !window.DOMPurify) {
      render(layoutCard("CDN 로드 실패", `<p>필수 라이브러리를 불러오지 못했습니다. 인터넷 연결/CSP를 확인하세요.</p>`));
      return;
    }
    initSupabase();
    bindAuthModal();
    bindReportModal();
    bindCmdPalette();
    bindTheme();

    sb.auth.onAuthStateChange(async () => {
      await refreshAuthBtn();
      await refreshStatusLine();
      navigate();
    });

    await refreshAuthBtn();
    await refreshStatusLine();
    window.addEventListener("hashchange", navigate);
    navigate();
  }

  boot();
})();


// --- global: ignore AbortError noise so it doesn't break UX ---
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev?.reason;
  if (r && (r.name === "AbortError" || String(r?.message || "").toLowerCase().includes("aborted"))) {
    ev.preventDefault();
  }
});
