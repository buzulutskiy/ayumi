/* ══════════════════════════════════════════════════════════════════
   Каркас — заготовка приложения без сборки.

   Здесь лежит только то, что одинаково у всех: оболочка, хранилище,
   синхронизация через личный гист, профили, настройки и обновление.
   Своё приложение делается в разделе «Экраны» ниже: остальное можно
   не трогать вовсе.

   Ни сборщика, ни зависимостей: три файла отдаются как есть.
   ══════════════════════════════════════════════════════════════════ */

const APP_NAME = "Аюми";
const APP_VERSION = "Аюми 5";           // выпуск: поднять здесь, в version.json и в sw.js
const GIST_DESC = "Аюми — данные пробежек";

const $ = (sel) => document.querySelector(sel);
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* Дата днём, без часовых поясов: строка «2026-08-14» одинакова везде,
   а Date со временем сдвигает день на границе суток. */
const dateStr = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")
  + "-" + String(d.getDate()).padStart(2, "0");
const fromStr = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const todayStr = () => dateStr(new Date());
const daysBetween = (a, b) => Math.round((fromStr(b) - fromStr(a)) / 864e5);

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2300);
}

/* ══════════ Шторка ══════════ */
function openSheet(html) {
  $("#sheetBox").innerHTML = `<div class="sheet-grab"></div>` + html;
  $("#sheet").classList.add("show");
}
const closeSheet = () => $("#sheet").classList.remove("show");
const sheetOpen = () => $("#sheet").classList.contains("show");

/* ══════════════════════════════════════════════════════════════════
   Хранилище
   ══════════════════════════════════════════════════════════════════ */

const LS_PROFILE = "ayumi-profile-id";
let profileId = null;
let PROFILES = [];
const profile = () => PROFILES.find((p) => p.id === profileId)
  || { id: profileId || "", name: profileId || "", hint: "" };
const suffix = () => (profileId ? "-" + profileId : "");

const LS = {
  get data() { return "ayumi-data-v1" + suffix(); },
  get cfg() { return "ayumi-cfg-v1"; },     // токен и гист общие для всех профилей
};

let data = null;
let cfg = { token: "", gistId: "", lastSync: 0, tab: "home", theme: "dark", profileIds: [] };
const saveCfg = () => localStorage.setItem(LS.cfg, JSON.stringify(cfg));

function emptyData() {
  return {
    runs: [],         // пробежки: id, date, dist, min, kind, rpe, updatedAt
    theme: "dark", themeAt: 0,
  };
}

/* Приводим приехавшее к ожидаемой форме. Здесь же место для переездов
   со старых схем: пришло чужое или неполное — берём заготовку. */
function migrate(obj) {
  const base = emptyData();
  if (!obj || typeof obj !== "object") return base;
  if (Array.isArray(obj.runs)) base.runs = obj.runs;
  // первые версии держали пробежки в отдельном ключе — забираем их к себе
  if (!base.runs.length && Array.isArray(obj.items)) base.runs = obj.items;
  if (typeof obj.theme === "string") base.theme = obj.theme;
  if (Number(obj.themeAt) > 0) base.themeAt = Number(obj.themeAt);
  return base;
}

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(LS.data) || "null"); } catch {}
  data = migrate(raw);
  try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem(LS.cfg)) || {}); } catch {}
}

/* Запись обязана пережить что угодно, поэтому она перечитывается: место
   в хранилище кончается молча, и «сохранённое» могло не дожить до
   перезапуска. Сеть тут ни при чём — гист получит своё позже, а на
   устройстве всё уже лежит. */
function saveData() {
  const txt = JSON.stringify(data);
  try {
    localStorage.setItem(LS.data, txt);
    if (localStorage.getItem(LS.data) !== txt) throw new Error("запись не перечиталась");
  } catch (e) {
    toast(noRoom(e) ? "Кончилось место на устройстве" : "Не удалось сохранить");
    return false;
  }
  return true;
}

/* Место кончается обязательно. Отличаем эту беду от прочих, иначе она
   выдаёт себя за что попало и человек чинит не то. */
const noRoom = (e) => !!e && (e.name === "QuotaExceededError"
  || e.name === "NS_ERROR_DOM_QUOTA_REACHED"
  || /quota|exceeded|storage/i.test(String(e.message || "")));

/* Слияние списков по updatedAt. Всё, что синхронизируется, должно быть
   списком записей с id и updatedAt: только так две стороны могут сойтись
   без потерь. Удаление — это пометка deleted, а не исчезновение: иначе
   удалённое воскресает с другого устройства. */
function mergeLists(local, remote) {
  const map = new Map();
  for (const i of remote || []) map.set(i.id, i);
  for (const i of local || []) {
    const o = map.get(i.id);
    if (!o || (i.updatedAt || 0) >= (o.updatedAt || 0)) map.set(i.id, i);
  }
  return [...map.values()];
}

/* ══════════════════════════════════════════════════════════════════
   Синхронизация: личный гист как хранилище
   ══════════════════════════════════════════════════════════════════ */

const GIST_FILE = "ayumi.json";                    // общий файл первых версий
const PROF_FILE = (id) => "ayumi-" + id + ".json"; // свой файл у каждого профиля

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("нет связи")), ms)),
  ]);
}

function gh(path, opts = {}) {
  const headers = Object.assign(
    { "Authorization": "Bearer " + cfg.token, "Accept": "application/vnd.github+json" },
    opts.headers || {});
  return withTimeout(fetch("https://api.github.com" + path,
    Object.assign({}, opts, { headers })), 12000);
}

const gistReady = () => !!(cfg.token && cfg.gistId);
const exportData = () => ({ v: 1, savedAt: now(), ...data });

let syncing = false, online = navigator.onLine;
/* Слепок последнего ответа. Пока он есть, можно спрашивать «а не
   изменилось ли» условным запросом и получать 304 без тела: раньше
   каждая отметка тянула файл целиком, хотя чаще всего там ничего
   не менялось. */
let gistEtag = "", gistBox = null;

function setSyncDot(state) {
  const d = $("#syncDot");
  if (d) d.className = "sync-dot " + state;
}

let pushTimer = 0;
function schedulePush() {
  if (!gistReady()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(false), 1500);
}

async function syncNow(manual) {
  if (!gistReady() || syncing) { if (manual && !cfg.token) openSettings(); return; }
  if (!navigator.onLine) { online = false; setSyncDot("off"); renderBanner(); return; }
  syncing = true; setSyncDot("busy");
  try {
    const cond = gistEtag && gistBox ? { headers: { "If-None-Match": gistEtag } } : {};
    const r = await gh("/gists/" + cfg.gistId, cond);
    if (r.status === 401 || r.status === 404) throw new Error("гист недоступен (" + r.status + ")");
    if (!r.ok && r.status !== 304) throw new Error("ошибка сети (" + r.status + ")");

    let mine, remote;
    if (r.status === 304 && gistBox) { mine = gistBox; remote = null; }
    else {
      const g = await r.json();
      gistEtag = r.headers.get("etag") || "";
      const files = g.files || {};
      const read = async (f) => {
        if (!f) return null;
        if (!f.truncated) return f.content;
        return f.raw_url ? await (await fetch(f.raw_url)).text() : null;
      };
      mine = null;
      const own = await read(files[PROF_FILE(profileId)]);
      if (own) { try { mine = JSON.parse(own); } catch {} }
      if (!mine) {                       // своего файла ещё нет — берём себя из общего
        const txt = await read(files[GIST_FILE]);
        if (txt) { try { const p = JSON.parse(txt); mine = (p.profiles && p.profiles[profileId]) || p; } catch {} }
      }
      remote = migrate(mine);
      gistBox = mine;

      const ids = Object.keys(files).map((n) => /^ayumi-(.+)\.json$/.exec(n))
        .filter(Boolean).map((m) => m[1]);
      if (ids.length) { cfg.profileIds = ids; saveCfg(); profilesFromKeys(ids); }
    }

    if (remote) {
      data.runs = mergeLists(data.runs, remote.runs);
      /* Одиночные значения — не списки, и слить их «по свежести файла»
         нельзя: чужая вчерашняя правка победила бы твою сегодняшнюю,
         потому что скачивание идёт раньше отправки. Поэтому у каждого
         своя отметка времени, как updatedAt у записей. */
      if (remote.theme && (remote.themeAt || 0) > (data.themeAt || 0)) {
        data.theme = remote.theme; data.themeAt = remote.themeAt;
        applyTheme(data.theme);
      }
      saveData();
    }

    /* Сравниваем профиль целиком: если смотреть только на записи, новые
       настройки навсегда останутся на одном устройстве. */
    const norm = (o) => JSON.stringify(migrate(o));
    if (norm(mine) !== norm(exportData())) {
      const payload = JSON.stringify(exportData());
      const pr = await gh("/gists/" + cfg.gistId, {
        method: "PATCH",
        body: JSON.stringify({ files: { [PROF_FILE(profileId)]: { content: payload } } }),
      });
      if (!pr.ok) throw new Error("не сохранилось");
      /* Слепок кладём разобранный заново, а не сам объект: exportData
         отдаёт живые массивы приложения, и слепок менялся бы вместе с
         ними — сравнение «изменилось ли» всегда говорило бы «нет». */
      gistEtag = pr.headers.get("etag") || "";
      gistBox = JSON.parse(payload);
    }

    cfg.lastSync = now(); cfg.syncErr = ""; saveCfg();
    online = true; setSyncDot("ok");
  } catch (e) {
    cfg.syncErr = String(e.message || e); saveCfg();
    setSyncDot("err");
  } finally {
    syncing = false;
    renderBanner();
    if (manual) toast(cfg.syncErr ? "Не вышло: " + cfg.syncErr : "Синхронизировано");
  }
}

async function ensureGist(create) {
  if (cfg.gistId) return cfg.gistId;
  const r = await gh("/gists?per_page=100");
  if (!r.ok) throw new Error("список гистов недоступен");
  const found = (await r.json()).find((g) => g.files
    && (g.files[GIST_FILE] || Object.keys(g.files).some((n) => /^ayumi-.+\.json$/.test(n))));
  if (found) { cfg.gistId = found.id; saveCfg(); return found.id; }
  if (!create) return "";
  const cr = await gh("/gists", {
    method: "POST",
    body: JSON.stringify({
      description: GIST_DESC, public: false,
      files: { [PROF_FILE(profileId || "me")]: { content: JSON.stringify(exportData()) } },
    }),
  });
  if (!cr.ok) throw new Error("гист не создался");
  cfg.gistId = (await cr.json()).id; saveCfg();
  return cfg.gistId;
}

const profilesFromKeys = (keys) => {
  PROFILES = (keys || []).map((id) => ({ id, name: id, hint: "из гиста" }));
};

/* ══════════════════════════════════════════════════════════════════
   Обновление приложения
   ══════════════════════════════════════════════════════════════════ */

let newVersion = "";

/* Версия лежит отдельным файлом и мимо кэша: так приложение узнаёт о
   выпуске, не выгружая себя целиком. Служебный работник может держать
   старую оболочку сколько угодно — здесь спрашивается сеть. */
async function checkForUpdate() {
  try {
    const r = await fetch("version.json?ts=" + now(), { cache: "no-store" });
    if (!r.ok) return;
    const v = (await r.json()).version || "";
    if (v && v !== APP_VERSION) { newVersion = v; renderBanner(); }
  } catch {}
}

async function applyUpdate() {
  try {
    const rs = await navigator.serviceWorker.getRegistrations();
    for (const r of rs) await r.unregister();
    for (const k of await caches.keys()) if (k.startsWith("ayumi-v")) await caches.delete(k);
  } catch {}
  location.replace(location.origin + location.pathname + "?v=" + encodeURIComponent(newVersion));
}

function renderBanner() {
  const box = $("#banner") || (() => {
    const d = document.createElement("div"); d.id = "banner";
    $("#view").prepend(d); return d;
  })();
  if (newVersion) {
    box.innerHTML = `<div class="banner news">✨<span>Есть новая версия — <b>${esc(newVersion)}</b>.
      Сейчас стоит ${esc(APP_VERSION)}.</span>
      <button class="btn" id="updBtn" type="button">Обновить</button></div>`;
    $("#updBtn").addEventListener("click", applyUpdate);
    return;
  }
  if (cfg.syncErr) {
    box.innerHTML = `<div class="banner warn">⚠️<span><b>Данные сохранены на устройстве</b>,
      но не ушли в гист: ${esc(cfg.syncErr)}</span>
      <button class="btn" id="retryBtn" type="button">Повторить</button></div>`;
    $("#retryBtn").addEventListener("click", () => syncNow(true));
    return;
  }
  box.innerHTML = "";
}

/* ══════════════════════════════════════════════════════════════════
   Оформление
   ══════════════════════════════════════════════════════════════════ */

const THEMES = [{ id: "dark", name: "Тёмная" }, { id: "light", name: "Светлая" }];
function applyTheme(id) {
  document.documentElement.setAttribute("data-theme", id === "light" ? "light" : "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", id === "light" ? "#f6f4fa" : "#0d0b14");
}

/* ══════════════════════════════════════════════════════════════════
   Настройки
   ══════════════════════════════════════════════════════════════════ */

function openSettings() {
  const when = cfg.lastSync ? new Date(cfg.lastSync).toLocaleString("ru") : "ещё не было";
  openSheet(`
    <h3 class="blk-head">Настройки</h3>

    <div class="group">Синхронизация</div>
    <p class="empty-note" style="text-align:left;padding:0 2px 10px">
      Данные лежат в личном секретном гисте на гитхабе. Нужен ключ доступа
      с одним правом — <b>gist</b>. Ключ хранится только на этом устройстве.
    </p>
    <input class="note-input pick-text" id="stToken" type="password" placeholder="ключ доступа"
      autocomplete="off" value="${esc(cfg.token)}">
    <div style="height:8px"></div>
    <input class="note-input pick-text" id="stGist" placeholder="адрес гиста — найдётся сам"
      autocomplete="off" value="${esc(cfg.gistId)}">
    <div class="sheet-actions">
      <button class="btn gold" id="stSave" type="button">Сохранить и синхронизировать</button>
      <div class="empty-note" style="padding:2px">Последняя сверка: ${esc(when)}</div>
    </div>

    <div class="group">Профиль</div>
    <button class="row" id="stProfile" type="button">
      <i>👤</i><span><b>${esc(profile().name || "не выбран")}</b>
      <em>у каждого профиля свои данные и свой файл в гисте</em></span><span class="go">›</span>
    </button>

    <div class="group">Оформление</div>
    ${THEMES.map((t) => `
      <button class="row" data-theme="${t.id}" type="button">
        <i>${t.id === "light" ? "☀️" : "🌙"}</i><span><b>${esc(t.name)}</b></span>
        <span class="go">${data.theme === t.id ? "✓" : ""}</span>
      </button>`).join("")}

    <div class="group">Пробежки</div>
    <button class="row" id="stPick" type="button">
      <i>⤓</i><span><b>Загрузить из файла</b><em>tcx, gpx, csv, json или zip с часов</em></span></button>
    <button class="row" id="stLevel" type="button">
      <i>↺</i><span><b>Сбросить уровень</b><em>ответы о самочувствии сотрутся, пробежки останутся</em></span></button>

    <div class="group">Копия</div>
    <button class="row" id="stSaveFile" type="button">
      <i>⤓</i><span><b>Сохранить файлом</b><em>на случай, если гист недоступен</em></span></button>
    <button class="row" id="stLoadFile" type="button">
      <i>⤒</i><span><b>Восстановить из файла</b><em>записи сольются, ничего не затрётся</em></span></button>
    <input type="file" id="stFile" accept="application/json" hidden>

    <div class="group">О приложении</div>
    <div class="empty-note" style="text-align:left">
      ${esc(APP_VERSION)}${newVersion ? " · есть обновление " + esc(newVersion) : " · последняя"}
    </div>
    <div class="sheet-actions">
      <button class="btn" id="stCheck" type="button">Проверить обновление</button>
      <button class="btn" id="stClose" type="button">Закрыть</button>
    </div>`);

  $("#stPick").addEventListener("click", () => { closeSheet(); pickRuns(); });
  $("#stLevel").addEventListener("click", () => {
    if (!confirm("Убрать ответы о самочувствии? Пробежки останутся, уровень начнётся заново.")) return;
    for (const r of data.runs || []) if (r.rpe) { delete r.rpe; r.updatedAt = now(); }
    saveData(); schedulePush(); closeSheet(); render(); toast("Уровень сброшен");
  });
  $("#stClose").addEventListener("click", closeSheet);
  $("#stCheck").addEventListener("click", async () => {
    await checkForUpdate();
    toast(newVersion ? "Есть обновление: " + newVersion : "Установлена последняя версия");
    closeSheet();
  });

  $("#stSave").addEventListener("click", async () => {
    cfg.token = $("#stToken").value.trim();
    cfg.gistId = $("#stGist").value.trim();
    saveCfg();
    if (!cfg.token) { toast("Без ключа синхронизации не будет"); return; }
    try {
      await ensureGist(true);
      gistEtag = ""; gistBox = null;
      await syncNow(true);
      closeSheet(); render();
    } catch (e) { toast(String(e.message || e)); }
  });

  document.querySelectorAll("[data-theme]").forEach((b) =>
    b.addEventListener("click", () => {
      data.theme = b.dataset.theme; data.themeAt = now();
      applyTheme(data.theme); saveData(); schedulePush(); openSettings();
    }));

  $("#stProfile").addEventListener("click", switchProfile);
  $("#stSaveFile").addEventListener("click", saveBackup);
  $("#stLoadFile").addEventListener("click", () => $("#stFile").click());
  $("#stFile").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) restoreBackup(f);
  });
}

/* Копия — только данные. Ключ доступа в неё не кладём: файл уезжает в
   облака и мессенджеры, а ключ должен остаться на устройстве. */
function saveBackup() {
  const pack = { app: APP_NAME, v: 1, savedAt: now(), version: APP_VERSION, profile: profileId, data: exportData() };
  const blob = new Blob([JSON.stringify(pack, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${APP_NAME}-${profileId || "me"}-${todayStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Копия сохранена");
}

// восстановление сливает копию с тем, что есть: ничего не затирается
function restoreBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let pack;
    try { pack = JSON.parse(reader.result); } catch { toast("Файл не читается"); return; }
    const d = migrate(pack && (pack.data || pack));
    data.items = mergeLists(data.items, d.items);
    saveData(); schedulePush(); closeSheet(); render();
    toast("Данные восстановлены");
  };
  reader.readAsText(file);
}

function switchProfile() {
  if (!confirm("Сменить профиль?\n\nЗаписи текущего останутся на месте.")) return;
  localStorage.removeItem(LS_PROFILE);
  location.replace(location.origin + location.pathname);
}

function renderProfilePick() {
  bootDone();
  $("#tabbar").innerHTML = "";
  $("#view").innerHTML = `
    <div class="panel">
      <h3 class="blk-head">Кто занимается</h3>
      ${(PROFILES.length ? PROFILES : [{ id: "me", name: "Я", hint: "новый профиль" }]).map((p) => `
        <button class="row" data-profile="${esc(p.id)}" type="button">
          <i>👤</i><span><b>${esc(p.name)}</b><em>${esc(p.hint || "")}</em></span>
          <span class="go">›</span>
        </button>`).join("")}
      <div class="empty-note">У каждого профиля свои данные и свой файл в гисте.</div>
    </div>`;
  document.querySelectorAll("[data-profile]").forEach((b) =>
    b.addEventListener("click", () => {
      localStorage.setItem(LS_PROFILE, b.dataset.profile);
      location.replace(location.origin + location.pathname);
    }));
}

function renderConnect() {
  bootDone();
  $("#tabbar").innerHTML = "";
  $("#view").innerHTML = `
    <div class="panel">
      <h3 class="blk-head">Подключить хранилище</h3>
      <div class="empty-note" style="text-align:left">
        Данные лежат в личном секретном гисте на гитхабе — не в этом приложении
        и не на чужом сервере. Нужен ключ доступа с одним правом: <b>gist</b>.
      </div>
      <div style="height:10px"></div>
      <button class="btn gold" id="goSet" type="button">Ввести ключ</button>
    </div>`;
  $("#goSet").addEventListener("click", openSettings);
}

/* ══════════════════════════════════════════════════════════════════
   Занятия, маршрут, индекс — суть приложения
   ══════════════════════════════════════════════════════════════════ */

const runs = () => (data.runs || []).filter((r) => !r.deleted);
const medianOf = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const sortedRuns = () => runs().slice().sort((a, b) => (a.date < b.date ? -1 : 1));
const iso = dateStr, fromISO = fromStr;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); x.setHours(0, 0, 0, 0); return x; };
const daysApart = (a, b) => Math.round((b - a) / 864e5);
const MON = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
const fmtDate = (d) => d.getDate() + " " + MON[d.getMonth()];
const DOW = ["пн","вт","ср","чт","пт","сб","вс"];
const dow = (d) => (d.getDay() + 6) % 7;
function km(x) { const v = Math.round(x * 10) / 10; return v % 1 === 0 ? String(v) : v.toFixed(1).replace(".", ","); }
function pace(minutes, dist) {
  if (!minutes || !dist) return null;
  const p = minutes / dist, m = Math.floor(p), s = Math.round((p - m) * 60);
  return m + ":" + String(s === 60 ? 0 : s).padStart(2, "0");
}

const ROUTES=[
 {name:'Карельский перешеек',sub:'от города вдоль залива на Выборг, через перешеек к Ладоге и обратно',ic:'🌲',stops:[
  {km:12, c:'Лахта',                f:'Отсюда начинается перешеек — полоса суши между Финским заливом и Ладогой шириной от 45 до 110 километров. Всё, что дальше, лежит на ней.'},
  {km:18, c:'Ольгино',              f:'Дюны вдоль берега — древние пляжи Литоринового моря, которое стояло здесь после ледника и было заметно выше нынешнего залива.'},
  {km:25, c:'Лисий Нос',            f:'Мелководье уходит от берега на сотни метров. Зимой по нему намерзает такой лёд, что до Кронштадта в старину ездили на санях.'},
  {km:34, c:'Сестрорецк',           f:'Оружейный завод, основанный Петром, работал больше двух веков. Ради заводских нужд запрудили реку Сестру — так появился Разлив.'},
  {km:38, c:'Разлив',               f:'Тот самый шалаш. Место обозначено гранитным шалашом-памятником 1928 года — редкий случай, когда в граните повторили сено.'},
  {km:42, c:'Сестрорецкое болото',  f:'Верховое болото, которому около восьми тысяч лет: оно старше почти всего, что вокруг, и его ни разу не осушали. Ледник ушёл — болото осталось.'},
  {km:46, c:'Солнечное',            f:'Сосны на песке держатся корнями у самой поверхности. Поэтому по здешним дюнам нельзя ездить: колея убивает лес быстрее пожара.'},
  {km:50, c:'Репино, «Пенаты»',     f:'Усадьба Репина. Он завёл круглый стол с вертушкой, чтобы гости передавали блюда сами: прислуги за столом он не терпел.'},
  {km:54, c:'Комарово',             f:'На здешнем кладбище лежат Ахматова, Лихачёв, Гердт. Дачи давали академикам и писателям — посёлок так и остался учёным.'},
  {km:58, c:'Зеленогорск',          f:'До 1948 года — финский Терийоки, дачная столица начала века. На лето сюда уезжал едва ли не весь литературный Петербург.'},
  {km:64, c:'Ушково',               f:'Финские названия на перешейке держатся в озёрах и станциях. «Ярви» значит просто «озеро» — их тут больше семисот.'},
  {km:70, c:'Серово',               f:'Береговые валы идут параллельно морю несколькими грядами: каждая — линия прибоя, отступавшая по мере того, как поднималась суша.'},
  {km:76, c:'Молодёжное',           f:'Суша здесь продолжает подниматься примерно на три миллиметра в год — земля до сих пор распрямляется после снятой тяжести ледника.'},
  {km:84, c:'Приветнинское',        f:'Открытый берег, где хорошо видно, как мелка Балтика: отойти можно на сотню метров, а воды всё по колено.'},
  {km:95, c:'Озеро Красавица',      f:'Одно из самых чистых озёр перешейка. Финское имя Каукъярви значит «дальнее озеро» — дальним оно было от всех дорог.'},
  {km:105,c:'Рощино',               f:'Сосновые боры стоят на песчаных грядах — это озы и камы, насыпанные талыми водами ледника. Такой рельеф тянется через весь перешеек.'},
  {km:115,c:'Каннельярви',          f:'Перешеек — водораздел: реки с одной стороны идут в залив, с другой в Ладогу, и разделяет их всего несколько километров.'},
  {km:135,c:'Приморск',             f:'Бывший Койвисто. Кирха 1904 года из серого гранита — одна из самых крупных, что финны успели построить на этом берегу.'},
  {km:150,c:'Ермилово',             f:'Дальше начинается самая изрезанная часть побережья: шхеры — затопленные скалы, по которым Балтика заходит в сушу сотнями проток.'},
  {km:165,c:'Выборгский залив',     f:'Шхерные острова здесь — вершины гранитных холмов. Ледник срезал с них всё мягкое, оставив голый камень, отполированный до блеска.'},
  {km:175,c:'Выборгский замок',     f:'Единственный в России целиком сохранившийся западноевропейский рыцарский замок. Шведы поставили его в 1293 году на голой скале посреди пролива.'},
  {km:182,c:'Парк Монрепо',         f:'Скальный пейзажный парк: гранитные лбы, вылизанные ледником, среди сосен. Камни здесь — главные экспонаты, их специально не трогали.'},
  {km:190,c:'Библиотека Аалто',     f:'Библиотека Алвара Аалто 1935 года. Её волнистый деревянный потолок до сих пор разбирают как образцовое решение акустики.'},
  {km:205,c:'Гвардейское',          f:'Поворот на восток. Дальше дорога идёт поперёк перешейка — от залива к Ладоге, через самую его середину.'},
  {km:215,c:'Каменногорск',         f:'Гранитные карьеры. Отсюда шёл камень на ленинградские набережные и станции метро — тот самый рапакиви с крупными округлыми зёрнами.'},
  {km:230,c:'Светогорск',           f:'Город стоит на самой границе. За рекой Вуоксой начинается финская Иматра, и водопад там пускают по расписанию, как аттракцион.'},
  {km:245,c:'Мельниково',           f:'Бывший Ряйсяля. Вуокса здесь разливается на протоки и озёра: единой реки нет, есть система, в которой легко заблудиться.'},
  {km:255,c:'Лосево',               f:'Лосевские пороги рукотворные. В 1857 году прорыли канал, чтобы связать Суходольское озеро с Вуоксой, вода пошла не туда и переписала гидрографию всего перешейка.'},
  {km:265,c:'Суходольское озеро',   f:'После той же аварии 1857 года озеро упало на несколько метров и обнажило берега. Старая береговая линия видна до сих пор.'},
  {km:275,c:'Вуокса',               f:'Островов на Вуоксе больше, чем их успели сосчитать: протоки постоянно меняются, и карты расходятся между собой.'},
  {km:285,c:'Крепость Корела',      f:'Шесть веков переходила из рук в руки. В её башне держали семью Емельяна Пугачёва — жену и детей, много лет после его казни.'},
  {km:295,c:'Бухта Владимирская',   f:'Отсюда ходят на Коневец. На острове лежит Конь-камень — валун весом под семьсот тонн, которому поклонялись задолго до крещения этих мест.'},
  {km:310,c:'Берег Ладоги',         f:'Ладога — самое большое озеро Европы. Волна на ней бывает морская, и штормы топили корабли не хуже балтийских.'},
  {km:325,c:'Громово',              f:'Кругом озёрные котловины, выпаханные ледником. Их вытянутость с северо-запада на юго-восток — это направление, в котором он двигался.'},
  {km:340,c:'Сосново',              f:'Граница тайги: отсюда на север лес идёт почти без перерыва. Южнее перешейка такого сплошного массива уже нет.'},
  {km:355,c:'Орехово',              f:'Озёра здесь лежат цепочками в ложбинах между камами. Вода в них тёмная от торфа, но чистая.'},
  {km:365,c:'Токсово',              f:'Лыжная столица под городом. Здешние горки — тоже камы: ледник насыпал их из песка и гравия, а люди приспособили под трамплины.'},
  {km:375,c:'Всеволожск',           f:'Отсюда начиналась Дорога жизни. Километровые столбы вдоль неё стоят до сих пор, и счёт на них идёт от Ленинграда.'},
  {km:385,c:'Ржевка',               f:'Круг замкнулся: перешеек пройден по кругу — вдоль залива на север, поперёк к Ладоге и обратно вдоль неё к городу.'},
 ]},
];
const STOPS=(()=>{const a=[];let off=0;
  ROUTES.forEach((r,ri)=>{r.stops.forEach(s=>a.push({...s,abs:off+s.km,ri}));off+=r.stops[r.stops.length-1].km});
  return a})();
const ROUTE_TOTAL=STOPS[STOPS.length-1].abs;


/* ==================== занятие ====================
   Расписания нет. Есть одно следующее занятие, которое собирается из
   прошлого опыта: сколько получилось в прошлый раз и как это далось.
   Тип чередуется — интервалы, потом непрерывный бег, и снова интервалы. */
function T_(work,rest,reps,restType){return {work,rest:reps>1?rest:0,reps,restType:restType||'walk'}}
const WARM=5,COOL=5,WALK_PACE=9;   // разминка, заминка и темп шага, мин/км
const REST_NAME={walk:'шагом',jog:'трусцой'};
const L0=8;                        // минут бега в первом занятии

/* Как далось занятие — единственный вопрос, который приложение задаёт. */
const RPE=[
  {v:1,t:'Легко',        d:'Мог бы ещё столько же',            k:1.14},
  {v:2,t:'Нормально',    d:'Устал, но бежал ровно',            k:1.07},
  {v:3,t:'Тяжело',       d:'Последние отрезки дались с трудом',k:1.00},
  {v:4,t:'Очень тяжело', d:'Пришлось сбавить или перейти на шаг',k:0.88},
];
const RPEK=v=>(RPE.find(x=>x.v===v)||{k:1.03}).k;

function runMin(t){return Math.round(t.work*t.reps*10)/10}
function restMin(t){return Math.round(t.rest*(t.reps-1)*10)/10}
function allMin(t){return Math.round((WARM+COOL+runMin(t)+restMin(t))*10)/10}
function estKm(t,pace){
  const rest=t.restType==='jog'?restMin(t)/(pace*1.1):restMin(t)/WALK_PACE;
  return Math.round((runMin(t)/(t.restType==='jog'?pace*.9:pace)+rest+(WARM+COOL)/WALK_PACE)*10)/10;
}
function clock(m){const w=Math.floor(m),s=Math.round((m-w)*60);return `${w}:${String(s).padStart(2,'0')}`}
function mins(m){return km(m)+' мин'}

/* Уровень — сколько минут бега приложение считает посильными сейчас.
   Он не хранится, а пересчитывается из всей истории: ответы про самочувствие
   двигают его вверх или вниз, длинный перерыв откатывает назад. */
function levelNow(){
  const R=sortedRuns();
  let L=L0;
  for(const r of R){
    // шаг не больше 14% за занятие — это и есть защита от резкого скачка
    if(r.rpe)L*=RPEK(r.rpe);
    else if(r.min)L=Math.max(L,Math.min(L*1.1,r.min*0.6)); // старые данные без ответа тянут мягко
    L=Math.max(6,Math.min(90,L));
  }
  const last=R[R.length-1];
  if(last){
    const gap=daysApart(fromISO(last.date),today());
    if(gap>28)L*=0.7; else if(gap>14)L*=0.85;
  }
  return Math.max(6,Math.min(90,Math.round(L*2)/2));
}
function nextKind(){
  const R=sortedRuns().filter(r=>r.kind);
  const last=R[R.length-1];
  return last&&last.kind==='int'?'cont':'int';
}
/* Чем выше уровень, тем длиннее рабочий отрезок и короче отдых. */
const INT_TABLE=[[10,1,1.5],[13,1.5,1.5],[16,2,1.5],[20,3,1.5],[25,4,1.5],[32,5,2],[45,6,2],[999,8,2]];
function buildSession(L,kind,pace){
  if(kind==='cont'){
    const work=Math.max(5,Math.round(L*0.75));
    return makeSession(T_(work,0,1),pace,'cont',{
      title:'Непрерывный бег',
      goal:`Пробежать ${mins(work)} и ни разу не перейти на шаг. Скорость не важна.`});
  }
  const row=INT_TABLE.find(r=>L<r[0]);
  const work=row[1],rest=row[2];
  const reps=Math.max(3,Math.round(L/work));
  return makeSession(T_(work,rest,reps),pace,'int',{
    title:'Интервалы',
    goal:`Отбежать все ${reps} ${plural(reps,'отрезок','отрезка','отрезков')} целиком. Последний не медленнее первого.`});
}
function makeSession(t,pace,kind,extra){
  return Object.assign({t,kind,type:kind==='int'?'intervals':'long',
    work:t.work,rest:t.rest,reps:t.reps,
    runMin:runMin(t),allMin:allMin(t),dist:estKm(t,pace),
    plan:t.reps>1?`${t.reps} × ${mins(t.work)} бегом через ${mins(t.rest)} ${REST_NAME[t.restType]}`
                 :`${mins(t.work)} бегом без перерыва`,
    watch:watchRows(t)},extra||{});
}
/* Строки ровно под поля интервального таймера на часах */
function watchRows(t){
  const rows=[['Разминка',`${WARM} мин шагом`],['Работа',clock(t.work)]];
  if(t.reps>1)rows.push(['Отдых',`${clock(t.rest)} ${REST_NAME[t.restType]}`]);
  rows.push(['Повторов',String(t.reps)]);
  rows.push(['Заминка',`${COOL} мин шагом`]);
  return rows;
}

/* Всё состояние приложения в одном месте. */
function plan(){
  const paceRaw=easyPace(),pace=paceRaw||8.5;
  const L=levelNow(),kind=nextKind();
  const R=sortedRuns();
  const last=R[R.length-1];
  return {L,kind,pace,paceKnown:!!paceRaw,
    next:buildSession(L,kind,pace),
    other:buildSession(L,kind==='int'?'cont':'int',pace),
    done:R.length,last,
    gap:last?daysApart(fromISO(last.date),today()):null,
    pending:R.filter(r=>!r.rpe&&r.kind).slice(-1)[0]||null,
    cadence:cadenceDays(),kmPer:kmPerSession(pace,L)};
}
/* Как часто он бегает на самом деле — медиана промежутков между пробежками. */
function cadenceDays(){
  const R=sortedRuns();
  if(R.length<3)return 3.5;
  const g=[];
  for(let i=1;i<R.length;i++){
    const d=daysApart(fromISO(R[i-1].date),fromISO(R[i].date));
    if(d>0&&d<30)g.push(d);
  }
  if(!g.length)return 3.5;
  g.sort((a,b)=>a-b);
  return Math.max(1.5,Math.min(10,g[Math.floor(g.length/2)]));
}
function kmPerSession(pace,L){
  const R=sortedRuns().filter(r=>r.dist>0).slice(-6);
  if(R.length>=3){const d=R.map(r=>r.dist).sort((a,b)=>a-b);return d[Math.floor(d.length/2)]}
  return Math.max(1.5,Math.round((L/pace+(WARM+COOL)/WALK_PACE)*10)/10);
}
function easyPace(){
  const R=runs().filter(r=>r.min>0&&r.dist>=1).slice(-10);
  if(R.length<3)return 0;
  const p=R.map(r=>r.min/r.dist).sort((a,b)=>a-b);
  return Math.max(4,Math.min(14,p[Math.floor(p.length/2)]));
}


/* ==================== индекс бегуна ====================
   Из файла приходят только дистанция и время, поэтому берём то, что из них
   действительно выводится: оценку VO2max по формулам Дэниелса и Гилберта (1979).
   Первая считает кислородную стоимость скорости, вторая — какую долю максимума
   человек способен держать столько минут; отношение и есть VDOT.
   Считаем только по непрерывному бегу: в интервальном занятии средний темп
   размазан ходьбой и сравнивать его не с чем. */
function vdotOf(distKm,minutes){
  if(!(distKm>=1)||!(minutes>=5))return 0;
  const v=distKm*1000/minutes;                       // метров в минуту
  const vo2=-4.60+0.182258*v+0.000104*v*v;
  const pct=0.8+0.1894393*Math.exp(-0.012778*minutes)+0.2989558*Math.exp(-0.1932605*minutes);
  return vo2/pct;
}
const WIN=42;                                        // окно наблюдения, дней
function indexWindow(from,to){
  const R=runs().filter(r=>{const d=fromISO(r.date);return d>addDays(today(),-to)&&d<=addDays(today(),-from)});
  const cont=R.filter(r=>r.kind!=='int'&&r.min>=5&&r.dist>=1);
  const easy=R.filter(r=>r.min>0&&r.dist>=1&&(!r.rpe||r.rpe<=2));
  // если часы отдают пульс — считаем экономичность: сколько метров в минуту на удар
  const withHr=R.filter(r=>r.hr>40&&r.min>0&&r.dist>=1);
  return {
    n:R.length,
    vdot:cont.length?Math.max(...cont.map(r=>vdotOf(r.dist,r.min))):0,
    endur:cont.length?Math.max(...cont.map(r=>r.min)):0,
    pace:easy.length?medianOf(easy.map(r=>r.min/r.dist)):0,
    hr:withHr.length?medianOf(withHr.map(r=>r.hr)):0,
    ei:withHr.length?medianOf(withHr.map(r=>r.dist*1000/r.min/r.hr)):0,
  };
}
/* Направление: лучше, так же или хуже. Порог нужен, чтобы шум не выдавался за рост. */
function dir(cur,prev,higherBetter,tol){
  if(!cur||!prev)return null;
  const d=(cur-prev)/prev;
  if(Math.abs(d)<tol)return {s:'same',t:'без изменений',v:0};
  const better=higherBetter?d>0:d<0;
  return {s:better?'up':'down',t:better?'лучше':'хуже',v:Math.abs(d)};
}
function runnerIndex(){
  const cur=indexWindow(0,WIN),prev=indexWindow(WIN,WIN*2);
  return {cur,prev,
    vdotDir:dir(cur.vdot,prev.vdot,true,.02),
    endurDir:dir(cur.endur,prev.endur,true,.05),
    paceDir:dir(cur.pace,prev.pace,false,.02),
    eiDir:dir(cur.ei,prev.ei,true,.02),
    score:cur.vdot?Math.round(cur.vdot):0};
}
/* Словами: что вообще значит это число */
function vdotWord(v){
  if(v<30)return 'начальный уровень';
  if(v<38)return 'уверенный любитель';
  if(v<46)return 'хорошая форма';
  if(v<54)return 'сильный любитель';
  return 'высокий уровень';
}


/* ==================== награды ==================== */
const AWARDS=[
  {id:'first',ic:'👟',t:'Первый шаг',d:'Первая пробежка',g:s=>[s.count,1]},
  {id:'r10',ic:'🔟',t:'Десять стартов',d:'10 пробежек',g:s=>[s.count,10]},
  {id:'r50',ic:'📅',t:'Полсотни',d:'50 пробежек',g:s=>[s.count,50]},
  {id:'d5',ic:'🥉',t:'Пятёрка',d:'5 км за раз',g:s=>[s.longest,5]},
  {id:'d10',ic:'🥈',t:'Десятка',d:'10 км за раз',g:s=>[s.longest,10]},
  {id:'d15',ic:'🥇',t:'Пятнашка',d:'15 км за раз',g:s=>[s.longest,15]},
  {id:'d21',ic:'🏆',t:'Полумарафон',d:'21,1 км за раз',g:s=>[s.longest,21.1]},
  {id:'t50',ic:'🌱',t:'50 км',d:'Всего набегано',g:s=>[s.total,50]},
  {id:'t100',ic:'🌿',t:'100 км',d:'Всего набегано',g:s=>[s.total,100]},
  {id:'t250',ic:'🌳',t:'250 км',d:'Всего набегано',g:s=>[s.total,250]},
  {id:'t500',ic:'⛰',t:'500 км',d:'Всего набегано',g:s=>[s.total,500]},
  {id:'t1000',ic:'🌍',t:'1000 км',d:'Всего набегано',g:s=>[s.total,1000]},
  {id:'w30',ic:'📦',t:'30 за неделю',d:'Недельный объём',g:s=>[s.weekMax,30]},
  {id:'w50',ic:'🚚',t:'50 за неделю',d:'Недельный объём',g:s=>[s.weekMax,50]},
  {id:'m100',ic:'🗓',t:'100 за месяц',d:'Календарный месяц',g:s=>[s.monthMax,100]},
  {id:'s4',ic:'🔥',t:'Без пауз',d:'8 занятий без длинного перерыва',g:s=>[s.best,8]},
  {id:'s12',ic:'💎',t:'Втянулся',d:'25 занятий без длинного перерыва',g:s=>[s.best,25]},
  {id:'early',ic:'🌅',t:'Ранняя пташка',d:'Побежал до 7 утра',g:s=>[s.early?1:0,1]},
  {id:'night',ic:'🌙',t:'Ночной',d:'Побежал после 21:00',g:s=>[s.night?1:0,1]},
  {id:'pace',ic:'⚡️',t:'Быстрее',d:'Темп вырос на 20 с/км',g:s=>[Math.max(0,s.gain),20]},
  {id:'m20',ic:'🧭',t:'Двадцатка',d:'20 минут бега за раз',g:s=>[s.longestMin,20]},
  {id:'m45',ic:'👑',t:'Сорок пять',d:'45 минут бега за раз',g:s=>[s.longestMin,45]},
];
function awardState(s){return AWARDS.map(a=>{const[c,t]=a.g(s);return{...a,cur:c,tgt:t,got:c>=t}})}


/* ==================== статистика ==================== */
function stats(P){
  const R=sortedRuns();
  const total=R.reduce((s,r)=>s+r.dist,0);
  const longest=R.reduce((m,r)=>Math.max(m,r.dist),0);
  const longestMin=R.reduce((m,r)=>Math.max(m,r.min||0),0);
  const byMonth={},byWeek={};
  for(const r of R){
    byMonth[r.date.slice(0,7)]=(byMonth[r.date.slice(0,7)]||0)+r.dist;
    const wk=r.date.slice(0,7)+'-'+Math.floor(Number(r.date.slice(8))/7);byWeek[wk]=(byWeek[wk]||0)+r.dist;
    
  }
  const weekMax=Math.max(0,...Object.values(byWeek));
  const monthMax=Math.max(0,...Object.values(byMonth));
  // серия: сколько занятий подряд без перерыва длиннее двух недель
  let streak=0,best=0;
  for(let i=0;i<R.length;i++){
    const gap=i?daysApart(fromISO(R[i-1].date),fromISO(R[i].date)):0;
    streak=(i&&gap>14)?1:streak+1;
    best=Math.max(best,streak);
  }
  const paced=R.filter(r=>r.min>0&&r.dist>=1);
  const avg=a=>a.length?a.reduce((s,r)=>s+r.min,0)/a.reduce((s,r)=>s+r.dist,0):0;
  const p0=avg(paced.slice(0,5)),p1=avg(paced.slice(-5));
  const gain=(paced.length>=8&&p0&&p1)?(p0-p1)*60:0;
  return {R,total,longest,longestMin,count:R.length,byMonth,byWeek,weekMax,monthMax,streak,best,gain,
    early:R.some(r=>r.h!=null&&r.h<7),night:R.some(r=>r.h!=null&&r.h>=21),
    level:P.L,curPace:p1?pace(p1,1):null};
}


function routeInfo(total){
  const passed=STOPS.filter(s=>total>=s.abs);
  const next=STOPS.find(s=>total<s.abs);
  const last=passed[passed.length-1];
  const from=last?last.abs:0;
  const p=next?(total-from)/(next.abs-from):1;
  return {passed,next,last,p:Math.max(0,Math.min(1,p))};
}
/* Через сколько занятий и дней будет следующая точка.
   Пока не набралось хотя бы трёх пробежек за неделю, считать не из чего:
   ни средней длины пробежки, ни того, как часто он вообще бегает. */
function routeEta(st,P){
  const R=routeInfo(st.total);
  if(!R.next)return null;
  const left=Math.max(0,R.next.abs-st.total);
  const runs=sortedRuns();
  const span=runs.length>1?daysApart(fromISO(runs[0].date),fromISO(runs[runs.length-1].date)):0;
  if(runs.length<3||span<7)return {left,ready:false,have:runs.length,span};
  const per=Math.max(.8,P.kmPer);
  const ses=Math.max(1,Math.ceil(left/per));
  const days=Math.max(1,Math.round(ses*P.cadence));
  return {left,ready:true,ses,days,per,cadence:P.cadence,runs:runs.length,
    rough:runs.length<8,when:addDays(today(),days)};
}
function etaText(e){
  if(!e)return '';
  if(!e.ready)return e.have<3
    ? `Срок появится, когда наберётся ${3-e.have} ${plural(3-e.have,'пробежка','пробежки','пробежек')}: пока не из чего считать, как часто ты бегаешь.`
    : 'Срок появится, когда пройдёт первая полная неделя — тогда станет видно, с какой частотой ты бегаешь.';
  return `${e.ses} ${plural(e.ses,'пробежка','пробежки','пробежек')} по ${km(e.per)} км — это около ${e.days} ${plural(e.days,'дня','дней','дней')}, к ${fmtDate(e.when)}`;
}
function etaBasis(e){
  if(!e||!e.ready)return '';
  return `Считаю по твоим ${km(e.per)} км за пробежку и ${km(e.cadence)} ${plural(Math.round(e.cadence),'дню','дням','дням')} между ними.`
    +(e.rough?' Прогноз пока грубый — с каждой неделей будет точнее.':'');
}

function runBars(R){
  const D=R.slice(-20);
  if(!D.length)return '<div class="empty-note">Нет данных</div>';
  const W=520,H=170,l=6,r=30,n=D.length;
  const max=Math.max(10,...D.map(x=>x.min||0))*1.12;
  const bw=(W-l-r)/n;
  const y=v=>H-22-(v/max)*(H-40);
  return `<svg viewBox="0 0 ${W} ${H}" style="margin-top:10px">
    ${[0,.5,1].map(f=>`<line x1="${l}" x2="${W-r+2}" y1="${y(max*f)}" y2="${y(max*f)}" stroke="var(--glass-line)"/>`).join('')}
    ${D.map((x,i)=>{
      const bx=l+i*bw,iw=Math.max(4,bw*.58),ox=bx+(bw-iw)/2,v=x.min||0;
      const col=x.kind==='int'?'var(--accent)':(x.kind==='cont'?'#5ac8fa':'var(--glass-line)');
      return `<rect x="${ox}" y="${y(v)}" width="${iw}" height="${Math.max(2,H-22-y(v))}" rx="3" fill="${col}"/>`;
    }).join('')}
    ${[.5,1].map(f=>`<text x="${W-r+7}" y="${y(max*f)+3}" fill="var(--muted)" font-size="10">${Math.round(max*f)}</text>`).join('')}
    <text x="${l}" y="${H-6}" fill="var(--muted)" font-size="10">${fmtDate(fromISO(D[0].date))}</text>
    <text x="${W-r+2}" y="${H-6}" fill="var(--muted)" font-size="10" text-anchor="end">${fmtDate(fromISO(D[D.length-1].date))}</text>
  </svg>`;
}
function paceChart(R){
  const P=R.filter(r=>r.min>0&&r.dist>=2).map(r=>({d:fromISO(r.date),p:r.min/r.dist,dist:r.dist}));
  if(P.length<3)return '<div class="empty-note">Нужно 3+ пробежки со временем</div>';
  const W=520,H=170,pad=44;
  const t0=+P[0].d,t1=Math.max(+P[P.length-1].d,t0+86400000);
  const ps=P.map(p=>p.p),lo=Math.min(...ps)-.3,hi=Math.max(...ps)+.3;
  const X=p=>pad+((+p.d-t0)/(t1-t0))*(W-pad*2);
  const Y=p=>18+((p.p-lo)/(hi-lo))*(H-46);
  // сглаженная линия по 3 точкам
  const sm=P.map((p,i)=>{const a=P.slice(Math.max(0,i-2),i+1);return{d:p.d,p:a.reduce((s,x)=>s+x.p,0)/a.length}});
  return `<svg viewBox="0 0 ${W} ${H}" style="margin-top:10px">
    ${[lo,(lo+hi)/2,hi].map(v=>`<line x1="${pad}" x2="${W-pad}" y1="${Y({p:v,d:P[0].d})}" y2="${Y({p:v,d:P[0].d})}" stroke="var(--glass-line)"/>`).join('')}
    <polyline fill="none" stroke="#5ac8fa" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"
      points="${sm.map(p=>X(p)+','+Y(p)).join(' ')}"/>
    ${P.map(p=>`<circle cx="${X(p)}" cy="${Y(p)}" r="${Math.min(6,2.4+p.dist/6)}" fill="var(--bg)" stroke="var(--accent)" stroke-width="1.8"/>`).join('')}
    ${[lo,(lo+hi)/2,hi].map(v=>`<text x="${pad-4}" y="${Y({p:v,d:P[0].d})+3}" fill="var(--muted)" font-size="10" text-anchor="end">${pace(v,1)}</text>`).join('')}
    <text x="${pad}" y="${H-4}" fill="var(--muted)" font-size="10">${fmtDate(P[0].d)}</text>
    <text x="${W-pad}" y="${H-4}" fill="var(--muted)" font-size="10" text-anchor="end">${fmtDate(P[P.length-1].d)}</text>
  </svg>
  <div class="sub" style="margin-top:8px">Ниже — быстрее. Размер точки — длина пробежки.</div>`;
}


/* Выбор файла открывается сразу: промежуточный экран тут лишний. */
function pickRuns(){
  let i=document.getElementById('pickFile');
  if(!i){
    i=document.createElement('input');
    i.type='file';i.id='pickFile';i.multiple=true;
    i.style.cssText='position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    i.addEventListener('change',()=>readFiles(i));
    document.body.appendChild(i);
  }
  i.value='';i.click();
}
function readFiles(inp){
  const fs=[...inp.files];if(!fs.length)return;
  inp.value='';
  toast('Разбираю…');
  Promise.all(fs.map(f=>f.arrayBuffer().then(buf=>ingestBuf(buf,f.name)).catch(()=>({add:0,skip:0,bad:1}))))
    .then(res=>{
      const t=res.reduce((a,x)=>({add:a.add+x.add,skip:a.skip+x.skip,bad:a.bad+x.bad}),{add:0,skip:0,bad:0});
      finishImport(t.add,t.skip,t.bad);
    });
}
/* Формат определяем по содержимому, а не по расширению: имена бывают любые. */
async function ingestBuf(buf,name){
  const u=new Uint8Array(buf);
  if(u.length<8)return {add:0,skip:0,bad:1};
  if(u[0]===0x50&&u[1]===0x4B)return unzipAll(u);            // PK — архив
  const text=new TextDecoder('utf-8').decode(u);
  return ingest(text);
}
function ingest(text){
  const head=text.slice(0,400).replace(/^﻿/,'').trimStart();
  if(!head)return {add:0,skip:0,bad:1};
  if(head[0]==='<')return parseXML(text);
  if(head[0]==='{'||head[0]==='[')return parseJSON(text);
  return parseCSV(text);
}
/* Минимальный разбор zip: центральный каталог плюс распаковка через DecompressionStream. */
async function unzipAll(u){
  const dv=new DataView(u.buffer,u.byteOffset,u.byteLength);
  let end=-1;
  for(let i=u.length-22;i>=0&&i>u.length-70000;i--){if(dv.getUint32(i,true)===0x06054b50){end=i;break}}
  if(end<0)return {add:0,skip:0,bad:1};
  const n=dv.getUint16(end+10,true);let off=dv.getUint32(end+16,true);
  const total={add:0,skip:0,bad:0};
  for(let k=0;k<n;k++){
    if(dv.getUint32(off,true)!==0x02014b50)break;
    const method=dv.getUint16(off+10,true);
    const csize=dv.getUint32(off+20,true);
    const nameLen=dv.getUint16(off+28,true),extraLen=dv.getUint16(off+30,true),cmtLen=dv.getUint16(off+32,true);
    const lho=dv.getUint32(off+42,true);
    const fname=new TextDecoder().decode(u.subarray(off+46,off+46+nameLen));
    off+=46+nameLen+extraLen+cmtLen;
    if(/\/$/.test(fname)||csize===0)continue;
    const lNameLen=dv.getUint16(lho+26,true),lExtra=dv.getUint16(lho+28,true);
    const start=lho+30+lNameLen+lExtra;
    const raw=u.subarray(start,start+csize);
    try{
      let data=raw;
      if(method===8){
        const ds=new DecompressionStream('deflate-raw');
        data=new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
      } else if(method!==0){continue}
      const r=await ingestBuf(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),fname);
      total.add+=r.add;total.skip+=r.skip;
    }catch(e){/* один файл не разобрался — идём дальше */}
  }
  if(!total.add&&!total.skip)total.bad=1;
  return total;
}
/* JSON произвольной формы: ищем в дереве объекты с датой, дистанцией и временем.
   Экспортёры вроде Health Auto Export пишут числа как {qty: 4.12, units: "km"},
   поэтому величину и единицы разбираем отдельно. */
function qty(v){
  if(v==null)return null;
  if(typeof v==='number')return {n:v,u:''};
  if(typeof v==='string'){const n=parseFloat(v.replace(',','.'));return isNaN(n)?null:{n,u:v.replace(/[\d.,\s-]/g,'').toLowerCase()}}
  if(typeof v==='object'){
    const k=Object.keys(v).find(x=>/^(qty|value|amount|val)$/i.test(x));
    if(k==null)return null;
    const n=parseFloat(v[k]);
    if(isNaN(n))return null;
    const uk=Object.keys(v).find(x=>/^(unit|units)$/i.test(x));
    return {n,u:uk?String(v[uk]).toLowerCase():''};
  }
  return null;
}
function toKm(q){
  if(!q)return 0;
  if(/^m$|meter|метр/.test(q.u))return q.n/1000;
  if(/mi|mile|миля/.test(q.u))return q.n*1.609344;
  if(/km|км/.test(q.u))return q.n;
  return q.n>300?q.n/1000:q.n;          // единиц нет — решаем по величине
}
function toMin(q){
  if(!q)return 0;
  if(/^s$|sec|сек/.test(q.u))return q.n/60;
  if(/^h$|hour|час/.test(q.u))return q.n*60;
  if(/min|мин/.test(q.u))return q.n;
  return q.n>600?q.n/60:q.n;
}
function parseJSON(text){
  let j;try{j=JSON.parse(text)}catch(e){return {add:0,skip:0,bad:1}}
  const found=[];
  const key=(o,re)=>Object.keys(o).find(k=>re.test(k));
  const walk=(v,depth)=>{
    if(!v||typeof v!=='object'||depth>8)return;
    if(Array.isArray(v)){v.forEach(x=>walk(x,depth+1));return}
    const kD=key(v,/^(start_?date|start_?time|date|start|begin|timestamp|time)$/i)||key(v,/date|time|start/i);
    const kL=key(v,/^(distance|dist|total_?distance|km|meters?)$/i)||key(v,/dist/i);
    const kT=key(v,/^(duration|moving_?time|elapsed_?time|total_?time|active_?time|sport_?time)$/i)||key(v,/duration|elapsed|moving/i);
    const L=kL?qty(v[kL]):null;
    if(kD&&L){
      const type=String(v.type||v.sport||v.name||v.workoutActivityType||v.category||v.activity||'Run');
      if(!isNotRun(type)){
        const kH=key(v,/^(avg_?heart_?rate|average_?heart_?rate|heart_?rate|avg_?hr|hr_?avg)$/i)||key(v,/heart|pulse|пульс/i);
        found.push({d:v[kD],dist:L,dur:kT?qty(v[kT]):null,hr:kH?qty(v[kH]):null});
      }
    }
    Object.values(v).forEach(x=>walk(x,depth+1));
  };
  walk(j,0);
  let add=0,skip=0;
  for(const f of found){
    const D=jsonDate(f.d);if(!D)continue;
    const dist=toKm(f.dist);
    if(!(dist>0))continue;
    const hr=f.hr?Math.round(f.hr.n):0;
    if(pushRun(D.d,D.h,dist,toMin(f.dur),'json',{hr:hr>40&&hr<230?hr:0}))add++;else skip++;
  }
  return {add,skip,bad:found.length?0:1};
}
function jsonDate(v){
  if(typeof v==='number'){
    const ms=v>1e12?v:v*1000;                      // секунды или миллисекунды
    const d=new Date(ms);
    return isNaN(+d)||d.getFullYear()<2000?null:{d,h:d.getHours()};
  }
  return parseDate(String(v));
}

function finishImport(add,skip,bad){
  if(add){
    const R=sortedRuns(),last=R[R.length-1];
    if(last&&!last.kind){last.kind=nextKindBefore(last);last.updatedAt=now()}
    saveData();schedulePush();
  }
  closeSheet();render();
  if(!add){toast(skip?'Всё это уже загружено':(bad?'Файл не разобрался':'Пробежек в файле не нашлось'));return}
  const R2=sortedRuns(),last2=R2[R2.length-1];
  toast(`Добавлено ${add} ${plural(add,'пробежка','пробежки','пробежек')}`);
  if(last2&&!last2.rpe)setTimeout(()=>askRpe(last2.id),450);
}
/* каким должен был быть тип занятия перед этой пробежкой */
function nextKindBefore(r){
  const prev=sortedRuns().filter(x=>x.kind&&x.id!==r.id).slice(-1)[0];
  return prev&&prev.kind==='int'?'cont':'int';
}
/* общая точка добавления: дубли режутся по паре «дата + дистанция» */
function pushRun(d,h,dist,min,src,extra){
  dist=Math.round(dist*100)/100;
  if(!(dist>0))return false;
  const key=iso(d)+'|'+Math.round(dist*10);
  if((data.runs||[]).some(r=>!r.deleted&&r.date+'|'+Math.round(r.dist*10)===key))return false;
  const r={id:uid(),date:iso(d),dist,min:Math.round((min||0)*10)/10,h,src,
    createdAt:now(),updatedAt:now()};
  // пустые поля не храним, чтобы не мусорить в облаке
  if(extra)for(const k of ['hr','hrMax','kcal','up'])if(extra[k])r[k]=extra[k];
  data.runs.push(r);
  return true;
}

/* ---------- TCX и GPX ----------
   Берём всё, что файл вообще может дать: кроме даты, дистанции и времени —
   пульс (средний и максимальный), калории и набор высоты. Если ничего этого
   в выгрузке нет, поля просто останутся пустыми. */
function parseXML(text){
  let doc;
  try{doc=new DOMParser().parseFromString(text,'application/xml')}catch(e){return {add:0,skip:0,bad:1}}
  if(!doc||doc.getElementsByTagName('parsererror').length)return {add:0,skip:0,bad:1};
  const tag=(el,n)=>el.getElementsByTagName(n);
  const num=(el,n)=>{const x=tag(el,n)[0];return x?parseFloat(x.textContent)||0:0};
  let add=0,skip=0;

  for(const a of tag(doc,'Activity')){
    const sport=(a.getAttribute('Sport')||'')+' '+(tag(a,'Notes')[0]?.textContent||'');
    if(isNotRun(sport))continue;
    const laps=tag(a,'Lap');
    let dist=0,sec=0,kcal=0,hrSum=0,hrN=0,hrMax=0;
    for(const l of laps){
      dist+=num(l,'DistanceMeters');sec+=num(l,'TotalTimeSeconds');kcal+=num(l,'Calories');
      const avg=tag(l,'AverageHeartRateBpm')[0],mx=tag(l,'MaximumHeartRateBpm')[0];
      if(avg){const v=parseFloat(tag(avg,'Value')[0]?.textContent||avg.textContent)||0;if(v){hrSum+=v;hrN++}}
      if(mx){const v=parseFloat(tag(mx,'Value')[0]?.textContent||mx.textContent)||0;hrMax=Math.max(hrMax,v)}
    }
    const when=tag(a,'Id')[0]?.textContent||(laps[0]&&laps[0].getAttribute('StartTime'));
    const t=when?new Date(when):null;
    if(!t||isNaN(+t))continue;
    if(dist<=0)dist=trackLength(a,'Trackpoint');
    // пульса не было в кругах — соберём по точкам трека
    if(!hrN){const s=hrSeries(a,'Trackpoint');if(s.n){hrSum=s.sum/s.n;hrN=1;hrMax=Math.max(hrMax,s.max)}}
    const extra={hr:hrN?Math.round(hrSum/hrN):0,hrMax:Math.round(hrMax)||0,
                 kcal:Math.round(kcal)||0,up:Math.round(elevGain(a,'Trackpoint'))||0};
    if(pushRun(t,t.getHours(),dist/1000,sec/60,'tcx',extra))add++;else skip++;
  }
  for(const tr of tag(doc,'trk')){
    const nm=(tag(tr,'name')[0]?.textContent||'')+' '+(tag(tr,'type')[0]?.textContent||'');
    if(isNotRun(nm))continue;
    const pts=tag(tr,'trkpt');
    if(!pts.length)continue;
    const times=[...pts].map(p=>tag(p,'time')[0]?.textContent).filter(Boolean);
    const t=times.length?new Date(times[0]):null;
    if(!t||isNaN(+t))continue;
    const sec=times.length>1?(new Date(times[times.length-1])-t)/1000:0;
    const hs=hrSeries(tr,'trkpt');
    const extra={hr:hs.n?Math.round(hs.sum/hs.n):0,hrMax:Math.round(hs.max)||0,kcal:0,
                 up:Math.round(elevGain(tr,'trkpt'))||0};
    if(pushRun(t,t.getHours(),trackLength(tr,'trkpt')/1000,sec/60,'gpx',extra))add++;else skip++;
  }
  return {add,skip,bad:0};
}
/* пульс из точек трека: у Garmin он в HeartRateBpm, у GPX — в расширениях */
function hrSeries(root,tagName){
  let sum=0,n=0,max=0;
  for(const p of root.getElementsByTagName(tagName)){
    let v=0;
    const h=p.getElementsByTagName('HeartRateBpm')[0];
    if(h)v=parseFloat(h.getElementsByTagName('Value')[0]?.textContent||h.textContent)||0;
    if(!v)for(const e of p.getElementsByTagName('*')){
      if(/(^|:)(hr|heartrate)$/i.test(e.tagName)){v=parseFloat(e.textContent)||0;break}
    }
    if(v>30&&v<230){sum+=v;n++;max=Math.max(max,v)}
  }
  return {sum,n,max};
}
/* набор высоты: считаем только подъёмы больше метра, чтобы не ловить дрожь высотомера */
function elevGain(root,tagName){
  let up=0,prev=null;
  for(const p of root.getElementsByTagName(tagName)){
    const e=p.getElementsByTagName('AltitudeMeters')[0]||p.getElementsByTagName('ele')[0];
    if(!e)continue;
    const v=parseFloat(e.textContent);
    if(isNaN(v))continue;
    if(prev!==null&&v-prev>1)up+=v-prev;
    if(prev===null||Math.abs(v-prev)>1)prev=v;
  }
  return up;
}
function isNotRun(s){return /bik|cycl|ride|swim|велос|плаван|walk|hik/i.test(s||'')}
/* длина трека по координатам, метры */
function trackLength(root,tagName){
  const pts=root.getElementsByTagName(tagName);
  let sum=0,pa=null;
  for(const p of pts){
    let la,lo;
    if(p.hasAttribute('lat')){la=+p.getAttribute('lat');lo=+p.getAttribute('lon')}
    else{const pos=p.getElementsByTagName('Position')[0];if(!pos)continue;
      la=parseFloat(pos.getElementsByTagName('LatitudeDegrees')[0]?.textContent);
      lo=parseFloat(pos.getElementsByTagName('LongitudeDegrees')[0]?.textContent)}
    if(isNaN(la)||isNaN(lo))continue;
    if(pa)sum+=haversine(pa[0],pa[1],la,lo);
    pa=[la,lo];
  }
  return sum;
}
function haversine(a1,o1,a2,o2){
  const R=6371000,r=Math.PI/180;
  const dA=(a2-a1)*r,dO=(o2-o1)*r;
  const x=Math.sin(dA/2)**2+Math.cos(a1*r)*Math.cos(a2*r)*Math.sin(dO/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(x)));
}

function splitCSV(text){
  const rows=[];let row=[],cur='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){cur+='"';i++} else q=false } else cur+=c }
    else { if(c==='"')q=true;
      else if(c===','){row.push(cur);cur=''}
      else if(c==='\n'){row.push(cur);rows.push(row);row=[];cur=''}
      else if(c!=='\r')cur+=c }
  }
  if(cur||row.length){row.push(cur);rows.push(row)}
  return rows.filter(r=>r.length>1);
}
const RUMON={'янв':0,'фев':1,'мар':2,'апр':3,'мая':4,'май':4,'июн':5,'июл':6,'авг':7,'сен':8,'окт':9,'ноя':10,'дек':11};
function parseDate(s){
  s=(s||'').trim();if(!s)return null;
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return{d:new Date(+m[1],+m[2]-1,+m[3]),h:+(s.match(/[T ](\d{1,2}):/)?.[1]??12)};
  m=s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);if(m)return{d:new Date(+m[3],+m[2]-1,+m[1]),h:+(s.match(/ (\d{1,2}):/)?.[1]??12)};
  m=s.match(/(\d{1,2})\s+([а-яё]{3})[а-яё.]*\s+(\d{4})/i);
  if(m&&RUMON[m[2].toLowerCase()]!=null)return{d:new Date(+m[3],RUMON[m[2].toLowerCase()],+m[1]),h:+(s.match(/,\s*(\d{1,2}):/)?.[1]??12)};
  const t=Date.parse(s.replace(/(\d)\s*(AM|PM)/i,'$1 $2'));
  if(!isNaN(t)){const d=new Date(t);return{d,h:d.getHours()}}
  return null;
}
function parseTime(s){
  s=(s||'').trim();if(!s)return 0;
  if(/:/.test(s)){const p=s.split(':').map(Number);return p.length===3?p[0]*60+p[1]+p[2]/60:p[0]+p[1]/60}
  const n=parseFloat(s.replace(',','.'));return isNaN(n)?0:n/60; // Strava отдаёт секунды
}
function parseCSV(text){
  const rows=splitCSV(text);if(rows.length<2)return {add:0,skip:0,bad:1};
  const H=rows[0].map(h=>h.replace(/^\ufeff/,'').trim().toLowerCase());
  const find=(...re)=>{for(const r of re){const i=H.findIndex(h=>r.test(h));if(i>=0)return i}return -1};
  const iDate=find(/^activity date$/,/дата занятия/,/^date$/,/дата/);
  const iType=find(/^activity type$/,/тип занятия/,/^type$/,/тип/);
  const iDist=find(/^distance$/,/^расстояние$/,/^дистанция$/,/distance/,/расстояние/);
  const iTime=find(/^moving time$/,/время в движении/,/^elapsed time$/,/общее время/,/^time$/);
  if(iDate<0||iDist<0)return {add:0,skip:0,bad:1};
  let add=0,skip=0;
  for(let i=1;i<rows.length;i++){
    const c=rows[i];
    const type=(iType>=0?c[iType]:'Run')||'';
    if(!/run|бег|jog|trail/i.test(type)||isNotRun(type))continue;
    const D=parseDate(c[iDate]);if(!D||isNaN(+D.d))continue;
    let dist=parseFloat(String(c[iDist]||'').replace(/\s/g,'').replace(',','.'));
    if(!dist||dist<=0)continue;
    if(dist>300)dist=dist/1000; // метры
    const iHr=find(/average heart rate/,/средний пульс/,/^hr$/);
    const hr=iHr>=0?Math.round(parseFloat(String(c[iHr]||'').replace(',','.'))||0):0;
    if(pushRun(D.d,D.h,dist,parseTime(iTime>=0?c[iTime]:''),'csv',{hr}))add++;else skip++;
  }
  return {add,skip,bad:0};
}



/* ══════════════════════════════════════════════════════════════════
   Экраны
   ══════════════════════════════════════════════════════════════════ */

const TABS = [
  ["today", "◎", "Сегодня"],
  ["log",   "▤", "Занятия"],
  ["stats", "▲", "Прогресс"],
  ["route", "⛰", "Путь"],
];
let tab = "today";

function renderTabbar() {
  $("#tabbar").innerHTML = TABS.map(([id, ic, name]) =>
    `<button data-tab="${id}" class="${tab === id ? "on" : ""}" type="button">
      <i>${ic}</i>${esc(name)}</button>`).join("");
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab; cfg.tab = tab; saveCfg(); render();
    }));
}

/* ---------- занятие ---------- */
function sessionCard(x, P) {
  const band = P.paceKnown
    ? `${pace(P.pace * 0.94, 1)}–${pace(P.pace * 1.12, 1)} /км — твой обычный лёгкий темп.`
    : "медленнее, чем кажется правильным.";
  return `
    <div class="panel">
      <span class="tag ${x.kind === "int" ? "cool" : ""}">${esc(x.title)}</span>
      <div class="big" style="margin:14px 0 4px">${km(x.runMin)} <span>мин бега</span></div>
      <div class="sub">${esc(x.plan)}</div>
      <div class="watch">
        <div class="group" style="margin:0 0 7px">На часы</div>
        ${x.watch.map(([k, v]) => `<div class="wl"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}
        <div class="sub" style="margin-top:9px;font-size:0.7rem">Разминку и заминку отсчитываешь сам, в интервальный таймер идут только работа, отдых и повторы.</div>
      </div>
      <div class="hr"></div>
      <div class="sub"><b style="color:var(--ink)">Темп:</b> ${band} Проверка простая — на бегу можешь сказать фразу из пяти слов и не задохнуться. Не можешь — сбавь, это не ошибка.</div>
      <div class="sub"><b style="color:var(--ink)">Цель:</b> ${esc(x.goal)}</div>
      <div class="sub">Около ${km(x.allMin)} мин на ногах, примерно ${km(x.dist)} км.</div>
    </div>`;
}

function renderToday() {
  const P = plan(), st = stats(P);
  const doneToday = runs().find((r) => r.date === todayStr());
  const eta = routeEta(st, P);
  const R = routeInfo(st.total);
  $("#view").innerHTML = `
    <div id="banner"></div>
    ${P.pending ? `<button class="banner news" data-ask="${P.pending.id}" type="button" style="width:100%;text-align:left">
      <span><b>Как далась пробежка ${esc(fmtDate(fromISO(P.pending.date)))}?</b><br>
      ${km(P.pending.dist)} км за ${km(P.pending.min || 0)} мин. От ответа зависит следующее занятие.</span>
      <span class="btn">Ответить</span></button>` : ""}
    ${doneToday ? `<div class="panel">
        <span class="tag">Сделано сегодня</span>
        <div class="big" style="margin:14px 0 4px">${km(doneToday.min || 0)} <span>мин</span></div>
        <div class="sub">${km(doneToday.dist)} км${doneToday.min ? ", " + pace(doneToday.min, doneToday.dist) + " /км" : ""}</div>
        <div class="hr"></div>
        <div class="sub">Следующее занятие — ${esc(P.next.title.toLowerCase())}, ${esc(mins(P.next.runMin))} бега. Отдохни день-другой.</div>
      </div>` : sessionCard(P.next, P)}
    <button class="btn gold" id="pick" type="button">Загрузить пробежку из файла</button>
    <div class="sub" style="text-align:center;margin:8px 0 14px;font-size:0.72rem">Любой файл из приложения часов — tcx, gpx, csv, json или zip.</div>
    <div class="stats">
      <div class="stat"><b>${km(P.L)}</b><em>мин — твой уровень</em></div>
      <div class="stat"><b>${st.count}</b><em>занятий сделано</em></div>
      <div class="stat"><b>${runnerIndex().score || "—"}</b><em>индекс бегуна</em></div>
    </div>
    ${R.next ? `<button class="panel" data-go="route" type="button" style="width:100%;text-align:left;display:block">
      <div class="group" style="margin:0">Путь · ${esc(ROUTES[0].name)}</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px">
        <b style="flex:1">${esc(R.next.c)} — через ${km(R.next.abs - st.total)} км</b>
        <span class="km" style="color:var(--dim);font-size:0.76rem">${km(st.total)} км</span></div>
      <div class="bar" style="margin-top:9px"><i style="width:${Math.min(100, st.total / ROUTE_TOTAL * 100)}%"></i></div>
      <div class="sub" style="margin-top:8px;font-size:0.72rem">${esc(etaText(eta))}${eta && eta.ready ? "." : ""}</div>
    </button>` : ""}`;
  renderBanner();
}

/* ---------- занятия ---------- */
function renderLog() {
  const P = plan(), st = stats(P);
  const list = sortedRuns().reverse();
  $("#view").innerHTML = `
    <div id="banner"></div>
    <div class="panel">
      <h3 class="blk-head">Следующее</h3>
      <div style="display:flex;gap:12px;align-items:baseline">
        <div style="font-size:1.9rem;font-weight:850;letter-spacing:-.03em">${km(P.next.runMin)}<span style="font-size:0.9rem;color:var(--muted);font-weight:700"> мин</span></div>
        <div style="flex:1"><b>${esc(P.next.title)}</b><div class="sub" style="font-size:0.75rem">${esc(P.next.plan)}</div></div>
      </div>
      <div class="sub" style="margin-top:12px">А следом — ${esc(P.other.title.toLowerCase())}, ${esc(mins(P.other.runMin))} бега. Типы чередуются: интервалы учат держать темп, непрерывный бег — держаться дольше.</div>
    </div>
    <div class="panel">
      <h3 class="blk-head">Как считается</h3>
      <div class="sub">Сейчас твой уровень — <b style="color:var(--ink)">${km(P.L)} мин бега</b> за занятие. Двигают его только твои ответы после пробежки: «легко» прибавляет 14%, «нормально» — 7%, «тяжело» оставляет как есть, «очень тяжело» снимает 12%.</div>
      <div class="sub">Больше 14% за раз уровень вырасти не может: резкий скачок одной пробежки предсказывает травмы лучше, чем недельный объём. Перерыв больше двух недель откатывает на 15%, больше месяца — на 30%.</div>
    </div>
    <div class="group">История · ${st.count}</div>
    ${list.length ? list.map((r) => {
      const d = fromISO(r.date), a = r.rpe ? RPE.find((x) => x.v === r.rpe) : null;
      return `<button class="row" data-ask="${r.id}" type="button">
        <i>${r.kind === "int" ? "▮▯" : "▬"}</i>
        <span style="flex:1;min-width:0"><b>${km(r.min || 0)} мин · ${km(r.dist)} км</b>
        <em>${esc(fmtDate(d))} · ${r.kind ? (r.kind === "int" ? "интервалы" : "непрерывный бег") : "из файла"}${a ? " · " + esc(a.t.toLowerCase()) : ""}${r.hr ? " · пульс " + r.hr : ""}</em></span>
        <span class="go">${r.rpe ? "⋯" : "?"}</span></button>`;
    }).join("") : `<div class="empty-note">Пока пусто. Загрузи файл после первой пробежки.</div>`}`;
  renderBanner();
}

/* ---------- прогресс ---------- */
function renderStats() {
  const P = plan(), st = stats(P);
  const I = runnerIndex();
  const arrow = (d) => !d ? "" : d.s === "up" ? "↑" : d.s === "down" ? "↓" : "→";
  const col = (d) => !d ? "var(--dim)" : d.s === "up" ? "var(--accent)" : d.s === "down" ? "var(--red)" : "var(--dim)";
  const word = (d) => d ? `<span style="color:${col(d)}">${arrow(d)} ${d.t}${d.v ? ", " + Math.round(d.v * 100) + "%" : ""}</span>`
                        : `<span style="color:var(--dim)">первое измерение</span>`;
  $("#view").innerHTML = `
    <div id="banner"></div>
    <div class="stats">
      <div class="stat"><b>${km(st.longestMin)}</b><em>макс. мин за раз</em></div>
      <div class="stat"><b>${km(st.longest)}</b><em>макс. км за раз</em></div>
      <div class="stat"><b>${st.gain > 0 ? "−" + Math.round(st.gain) + "с" : "—"}</b><em>темп /км</em></div>
    </div>
    <div class="panel">
      <h3 class="blk-head">Индекс бегуна</h3>
      ${I.score ? `
        <div style="display:flex;align-items:baseline;gap:12px">
          <div class="big" style="font-size:2.6rem">${I.score}</div>
          <div style="flex:1"><b>${esc(vdotWord(I.cur.vdot))}</b>
            <div class="sub" style="font-size:0.76rem">${word(I.vdotDir)}</div></div>
        </div>
        <div style="margin-top:14px">
          <div class="wl"><span>Выносливость · ${km(Math.round(I.cur.endur))} мин подряд</span><b style="font-weight:600;font-size:0.76rem">${word(I.endurDir)}</b></div>
          <div class="wl"><span>Лёгкий темп · ${I.cur.pace ? pace(I.cur.pace, 1) + " /км" : "—"}</span><b style="font-weight:600;font-size:0.76rem">${word(I.paceDir)}</b></div>
          ${I.cur.ei ? `<div class="wl"><span>Экономичность · ${km(Math.round(I.cur.ei * 100) / 100)} м на удар, пульс ${Math.round(I.cur.hr)}</span><b style="font-weight:600;font-size:0.76rem">${word(I.eiDir)}</b></div>` : ""}
        </div>
        <div class="sub" style="margin-top:12px;font-size:0.72rem">Оценка МПК по формулам Дэниелса и Гилберта: считается по самому быстрому непрерывному бегу за 6 недель и сравнивается с предыдущими шестью. Число занижено, если ты не бежал в полную силу, — важна не величина, а куда она идёт.</div>
        ${I.cur.ei ? "" : `<div class="sub" style="margin-top:10px;font-size:0.72rem;opacity:.8">Пульса в файлах нет. Появится — здесь добавится экономичность: сколько метров ты пробегаешь на один удар сердца.</div>`}`
      : `<div class="sub">Появится после первого занятия с непрерывным бегом: в интервальном средний темп размазан ходьбой, и считать по нему нечего.</div>`}
    </div>
    <div class="panel">
      <h3 class="blk-head">Минуты бега по занятиям</h3>
      ${runBars(st.R)}
      <div class="sub" style="margin-top:10px;font-size:0.72rem">Жёлтым интервалы, синим непрерывный бег.</div>
    </div>
    <div class="panel">
      <h3 class="blk-head">Темп</h3>
      ${paceChart(st.R)}
    </div>`;
  renderBanner();
}

/* ---------- путь ---------- */
function stopRow(s, done, isNext, line, total, eta) {
  return `<div class="stop ${done ? "done" : ""} ${isNext ? "next" : ""}">
    <div class="line"><div class="dot"></div>${line ? `<div class="rail"></div>` : ""}</div>
    <div class="body">
      <div class="top"><b>${esc(s.c)}</b><span class="km">${km(s.abs)} км</span></div>
      ${done ? `<div class="sub" style="margin-top:5px;font-size:0.76rem">${esc(s.f)}</div>`
             : `<div class="sub" style="margin-top:5px;font-size:0.76rem;color:var(--accent)">Ещё ${km(s.abs - total)} км — и место откроется.</div>
                ${eta ? `<div class="sub" style="margin-top:3px;font-size:0.72rem">${esc(etaText(eta))}${eta.ready ? "." : ""}</div>
                  ${eta.ready ? `<div class="sub" style="margin-top:3px;font-size:0.72rem;opacity:.75">${esc(etaBasis(eta))}</div>` : ""}` : ""}`}
    </div></div>`;
}

function renderRoute() {
  const P = plan(), st = stats(P);
  const R = routeInfo(st.total), eta = routeEta(st, P), r = ROUTES[0];
  const A = awardState(st), got = A.filter((a) => a.got).length;
  const locked = STOPS.length - R.passed.length - (R.next ? 1 : 0);
  $("#view").innerHTML = `
    <div id="banner"></div>
    <div class="panel">
      <h3 class="blk-head">${esc(r.name)}</h3>
      <div class="sub">${esc(r.sub)}</div>
      <div class="bar" style="margin-top:12px"><i style="width:${Math.min(100, st.total / ROUTE_TOTAL * 100)}%"></i></div>
      <div class="sub" style="margin-top:8px;font-size:0.72rem">${km(st.total)} из ${ROUTE_TOTAL} км · ${R.passed.length} ${plural(R.passed.length, "место", "места", "мест")} позади. Дорога открывается по мере бега: что впереди — видно только на шаг вперёд.</div>
    </div>
    <div class="panel">
      ${R.passed.length ? R.passed.map((s, i) => stopRow(s, true, false, i < R.passed.length - 1 || !!R.next)).join("")
        : `<div class="sub">Пока ни одного места. Первое — ${esc(STOPS[0].c)}, через ${km(STOPS[0].abs)} км.</div>`}
      ${R.next ? stopRow(R.next, false, true, locked > 0, st.total, eta) : ""}
      ${locked > 0 ? `<div class="stop"><div class="line"><div class="dot"></div></div>
        <div class="body" style="padding-bottom:0"><div class="sub" style="font-size:0.76rem">Дальше ещё ${locked} ${plural(locked, "место", "места", "мест")} и ${km(ROUTE_TOTAL - (R.next ? R.next.abs : 0))} км. Что там — узнаешь, когда добежишь.</div></div></div>` : ""}
    </div>
    <div class="group">Медали · ${got} из ${A.length}</div>
    <div class="aw">${A.map((a) => `
      <div class="${a.got ? "got" : ""}">
        <div class="ic">${a.ic}</div>
        <div class="t">${esc(a.t)}</div>
        <div class="p">${a.got ? "открыто" : km(Math.min(a.cur, a.tgt)) + " / " + km(a.tgt)}</div>
      </div>`).join("")}</div>`;
  renderBanner();
}

/* ---------- как далась ---------- */
function askRpe(id) {
  const r = (data.runs || []).find((x) => x.id === id);
  if (!r) return;
  openSheet(`<h3 class="blk-head">Как далась пробежка?</h3>
    <div class="sub">${esc(fmtDate(fromISO(r.date)))} · ${km(r.dist)} км${r.min ? " за " + km(r.min) + " мин" : ""}. Это единственное, что решает, каким будет следующее занятие.</div>
    <div class="sheet-actions">
      ${RPE.map((x) => `<button class="btn ${r.rpe === x.v ? "gold" : ""}" data-rpe="${x.v}" type="button" style="text-align:left">
        ${esc(x.t)}<em style="display:block;font-style:normal;font-weight:500;opacity:.65;font-size:0.74rem;margin-top:2px">${esc(x.d)}</em></button>`).join("")}
      ${r.kind ? "" : `<div class="sub" style="margin-top:6px">Загружено из файла — приложение не знает, интервалы это были или непрерывный бег:</div>
        <button class="btn" data-kind="int" type="button">Это были интервалы</button>
        <button class="btn" data-kind="cont" type="button">Это был непрерывный бег</button>`}
    </div>`);
  document.querySelectorAll("[data-rpe]").forEach((b) =>
    b.addEventListener("click", () => setRpe(id, Number(b.dataset.rpe))));
  document.querySelectorAll("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => { r.kind = b.dataset.kind; r.updatedAt = now(); saveData(); askRpe(id); }));
}

function setRpe(id, v) {
  const r = (data.runs || []).find((x) => x.id === id);
  if (!r) return;
  r.rpe = v;
  if (!r.kind) r.kind = nextKindBefore(r);
  r.updatedAt = now();
  saveData(); schedulePush(); closeSheet(); render();
  toast("Следующее занятие: " + mins(plan().next.runMin) + " бега");
}

function render() {
  renderTabbar();
  if (tab === "log") renderLog();
  else if (tab === "stats") renderStats();
  else if (tab === "route") renderRoute();
  else renderToday();
  document.querySelectorAll("[data-ask]").forEach((b) =>
    b.addEventListener("click", () => askRpe(b.dataset.ask)));
  document.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => { tab = b.dataset.go; cfg.tab = tab; saveCfg(); render(); }));
  const pick = $("#pick");
  if (pick) pick.addEventListener("click", pickRuns);
}

/* ══════════════════════════════════════════════════════════════════
   Запуск
   ══════════════════════════════════════════════════════════════════ */

/* Заставка уходит, когда на экране уже есть что показать: и после обычного
   запуска, и после экрана подключения, и после выбора профиля, и после
   срыва — на белый лист смотреть не должно доводиться ни в одном случае. */
function bootDone() {
  const el = document.getElementById("boot");
  if (!el) return;
  el.classList.add("gone");
  setTimeout(() => el.remove(), 320);
}

function crashScreen(e) {
  bootDone();
  $("#view").innerHTML = `<div class="panel"><h3 class="blk-head">Что-то сломалось</h3>
    <div class="empty-note" style="text-align:left">${esc(String(e && e.message || e))}</div></div>`;
}

function boot() {
  profileId = localStorage.getItem(LS_PROFILE);
  try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem(LS.cfg)) || {}); } catch {}
  if (cfg.profileIds && cfg.profileIds.length) profilesFromKeys(cfg.profileIds);

  if (!gistReady()) { renderConnect(); return; }   // пока нет гиста — показывать нечего
  if (!profileId) { renderProfilePick(); return; } // кто занимается

  load();
  applyTheme(data.theme);
  if (TABS.some(([id]) => id === cfg.tab)) tab = cfg.tab;
  render();
  syncNow(false);
  checkForUpdate();

  /* Служебный работник ставится с задержкой и только если запуск прошёл без
     сбоев: иначе сломанная оболочка закэшируется и починить её будет нечем. */
  if ("serviceWorker" in navigator) {
    setTimeout(() => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {}), 2500);
  }
}

function init() {
  try { boot(); } catch (e) { console.error(e); crashScreen(e); }
  bootDone();
}

$("#gearBtn").addEventListener("click", openSettings);
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
window.addEventListener("online", () => { online = true; setSyncDot(""); syncNow(false); });
window.addEventListener("offline", () => { online = false; setSyncDot("off"); renderBanner(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !data) return;
  checkForUpdate();
  syncNow(false);
});

init();
