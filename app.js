const COIN_ICON = `<img src="${chrome.runtime.getURL('icons/coin.png')}" class="currency-icon" />`;
const CASH_ICON = `<img src="${chrome.runtime.getURL('icons/cash.png')}" class="currency-icon" />`;
const SHOP_ICON = `<svg class="shop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;
const TAG_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z"/><circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const CART_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`;

// Sends a Google Analytics event. Does nothing if the Google tag hasn't loaded.
function trackEvent(name, params) {
  if (typeof gtag === "function") gtag("event", name, params);
}

function storeBadge(activeInStore) {
  return activeInStore ? `<span class="shop-badge" data-tooltip="Available in the YoWorld store">${SHOP_ICON}</span>` : "";
}

// ── Supabase Config ────────────────────────────────────────────
const SUPABASE_URL      = "https://zprdwdbqqispxijlhkdi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpwcmR3ZGJxcWlzcHhpamxoa2RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MDA0ODcsImV4cCI6MjA5NjQ3NjQ4N30.jIHoxWdNxGlZ2ulR2zPsRhooFNy_BHiZukopQJC95Fg";

async function getCachedOrFetch(key, ttlMinutes, fetchFn) {
  const cached = await chrome.storage.local.get(key);

  if (cached[key]) {
    const { data, timestamp } = cached[key];
    const ageMinutes = (Date.now() - timestamp) / 1000 / 60;

    if (ageMinutes < ttlMinutes) {
      return data;
    }
  }

  const data = await fetchFn();
  await chrome.storage.local.set({
    [key]: { data, timestamp: Date.now() }
  });
  return data;
}

async function fetchSupabasePrices(itemIds) {
  if (!itemIds.length || SUPABASE_URL.includes("YOUR_PROJECT")) return {};

  const now = Date.now();
  const PRICE_TTL_MS = 1440 * 60 * 1000;

  const cacheKeys = itemIds.map(id => `prices_${id}`);
  const cachedData = await chrome.storage.local.get(cacheKeys);

  const result = {};
  const idsToFetch = [];

  for (const id of itemIds) {
    const entry = cachedData[`prices_${id}`];
    if (entry && (now - entry.timestamp) < PRICE_TTL_MS) {
      result[String(id)] = entry.data;
    } else {
      idsToFetch.push(id);
    }
  }

  if (!idsToFetch.length) return result;

  try {
    const ids = idsToFetch.map(String).join(",");
    const url = `${SUPABASE_URL}/rest/v1/prices?item_id=in.(${ids})&select=item_id,min_price,max_price,buy_count,sell_count`;
    const res = await fetch(url, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
    });
    const body = await res.json();
    if (!res.ok) {
      console.error("[Supabase] error response:", res.status, body);
      return result;
    }

    const toCache = {};
    const fetchTime = Date.now();
    for (const row of body) {
      const idStr = String(row.item_id);
      const priceData = { min: row.min_price, max: row.max_price };
      result[idStr] = priceData;
      toCache[`prices_${idStr}`] = { data: priceData, timestamp: fetchTime };
      toCache[`counts_${idStr}`] = { data: { buyCount: row.buy_count ?? 0, sellCount: row.sell_count ?? 0 }, timestamp: fetchTime };
    }
    await chrome.storage.local.set(toCache);
    return result;
  } catch (e) {
    console.error("[Supabase] fetch exception:", e);
    return result;
  }
}

// ── Community state & RPC ──────────────────────────────────────
async function getOrCreateUserId() {
  return new Promise(resolve => {
    chrome.storage.local.get("yoworld_user_id", result => {
      if (result.yoworld_user_id) {
        resolve(result.yoworld_user_id);
      } else {
        const id = crypto.randomUUID();
        chrome.storage.local.set({ yoworld_user_id: id }, () => resolve(id));
      }
    });
  });
}

async function getItemState(itemId) {
  return new Promise(resolve => {
    chrome.storage.local.get(`state_${itemId}`, result => {
      resolve(result[`state_${itemId}`] ?? "none");
    });
  });
}

async function setItemState(itemId, state) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [`state_${itemId}`]: state }, resolve);
  });
}

async function getRequestedFlag(itemId) {
  return new Promise(resolve => {
    chrome.storage.local.get(`requested_${itemId}`, result => {
      resolve(!!result[`requested_${itemId}`]);
    });
  });
}

async function setRequestedFlag(itemId, itemName) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [`requested_${itemId}`]: { name: itemName || "" } }, resolve);
  });
}

// ── Unsubmitted price log reminder ─────────────────────────────
function getUnsubmittedPriceLogs() {
  const history = loadPriceHistory();
  const pending = [];
  for (const entry of Object.values(history)) {
    (entry.pricechecks ?? []).forEach((pc, index) => {
      if (!pc.communityStatus) {
        pending.push({ itemId: String(entry.id), index, price: pc.price, date: pc.date });
      }
    });
  }
  return pending;
}

function renderSubmitReminderBanner() {
  const banner = document.getElementById("submit-reminder-banner");
  if (!banner) return;

  const today = new Date().toISOString().split("T")[0];
  const dismissedDate = localStorage.getItem("submitReminderDismissedDate");
  const pending = getUnsubmittedPriceLogs();

  if (!pending.length || dismissedDate === today) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    return;
  }

  const label = pending.length === 1
    ? "You have a price to submit to the community"
    : `You have ${pending.length} prices to submit to the community`;

  banner.innerHTML = `
    <span class="price-request-banner-text">📤 ${label}</span>
    <div class="submit-reminder-actions">
      <button class="submit-reminder-btn" data-action="submit-all-pending">Submit</button>
      <button class="price-request-banner-dismiss" data-action="dismiss-submit-reminder" title="Dismiss">✕</button>
    </div>
  `;
  banner.classList.remove("hidden");
}

function renderPriceLogActionButtons(itemId, hasData, alreadyRequested) {
  const requestBtn = hasData
    ? ""
    : alreadyRequested
      ? `<button class="add-pc-btn" disabled>Requested ✓</button>`
      : `<button class="add-pc-btn" data-action="request-price" data-id="${itemId}">Request price</button>`;
  return `${requestBtn}<button class="add-pc-btn" data-action="open-detail-log">+ Log price</button>`;
}


async function callToggleItemState(userId, itemId, newState) {
  await ensurePricesRow(itemId);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/toggle_item_state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ p_user_id: userId, p_item_id: Number(itemId), p_new_state: newState })
    });
    if (!res.ok) {
      console.error("[Supabase] toggle_item_state error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[Supabase] toggle_item_state exception:", e);
    return false;
  }
}

async function fetchItemCounts(itemId) {
  return getCachedOrFetch(`counts_${itemId}`, 5, async () => {
    try {
      const url = `${SUPABASE_URL}/rest/v1/prices?item_id=eq.${itemId}&select=buy_count,sell_count`;
      const res = await fetch(url, {
        headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
      });
      const body = await res.json();
      if (!res.ok || !body.length) return { buyCount: 0, sellCount: 0 };
      return { buyCount: body[0].buy_count ?? 0, sellCount: body[0].sell_count ?? 0 };
    } catch {
      return { buyCount: 0, sellCount: 0 };
    }
  });
}

async function updateCountsCacheOnToggle(itemId, prevState, newState) {
  const cacheKey = `counts_${itemId}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (!cached[cacheKey]) return null;

  const { data, timestamp } = cached[cacheKey];
  let { buyCount, sellCount } = data;

  if (prevState === "buy") buyCount = Math.max(0, buyCount - 1);
  else if (prevState === "sell") sellCount = Math.max(0, sellCount - 1);

  if (newState === "buy") buyCount++;
  else if (newState === "sell") sellCount++;

  const updated = { buyCount, sellCount };
  await chrome.storage.local.set({ [cacheKey]: { data: updated, timestamp } });
  return updated;
}

async function ensurePricesRow(itemId) {
  const history = loadPriceHistory();
  const watchlist = loadWatchlist();
  const entry = history[String(itemId)];
  const watchItem = watchlist.find(i => String(i.id) === String(itemId));
  const searchItem = searchResultsMap[String(itemId)];
  const itemName = entry?.name ?? watchItem?.name ?? searchItem?.name ?? "";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ensure_prices_row`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify({ p_item_id: Number(itemId), p_item_name: itemName })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[ensurePricesRow] ${res.status}: ${body}`);
  }
}

async function fetchApprovedPriceLogs(itemId) {
  return getCachedOrFetch(`approved_logs_${itemId}`, 60, async () => {
    try {
      const url = `${SUPABASE_URL}/rest/v1/price_logs?item_id=eq.${itemId}&status=eq.approved&select=id,price,submitted_at,price_date&order=submitted_at.desc&limit=20`;
      const res = await fetch(url, {
        headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  });
}

async function submitPriceLog(itemId, price, priceDate) {
  await ensurePricesRow(itemId);
  const userId = await getOrCreateUserId();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_price_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ p_user_id: userId, p_item_id: Number(itemId), p_price: Math.round(price), p_price_date: priceDate ?? null })
    });
    if (res.ok) {
      trackEvent("price_log_submitted", { item_id: String(itemId) });
      return { ok: true };
    }
    const body = await res.text();
    if (body.includes("already submitted a price for this item today")) {
      return { ok: false, alreadySubmitted: true };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function requestPriceCheck(itemId, itemName) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/request_price_check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ p_item_id: Number(itemId), p_item_name: itemName ?? null })
    });
    if (res.ok) trackEvent("price_check_requested", { item_id: String(itemId) });
    return res.ok;
  } catch (e) {
    console.error("[Supabase] request_price_check exception:", e);
    return false;
  }
}

// Called when Buy/Sell is clicked. Requests a price only if the item has none yet and hasn't been requested.
async function requestPriceIfMissing(itemId, itemName) {
  if (itemCoinRange(itemId) !== null) return;
  if (await getRequestedFlag(itemId)) return;
  const ok = await requestPriceCheck(itemId, itemName);
  if (ok) await setRequestedFlag(itemId, itemName);
}

function updateDetailButtons(itemId, state) {
  const actionsEl = document.getElementById("detail-header-actions");
  if (!actionsEl) return;
  const buyActive = state === "buy";
  const sellActive = state === "sell";
  actionsEl.innerHTML = `
    <button class="watch-btn ${buyActive ? "watched" : ""}" data-action="detail-watch-buy" data-id="${itemId}">${buyActive ? "✓" : "+"} Buy</button>
    <button class="watch-btn ${sellActive ? "watched" : ""}" data-action="detail-watch-sell" data-id="${itemId}">${sellActive ? "✓" : "+"} Sell</button>
  `;
}

function updateDetailCounters(buyCount, sellCount) {
  const el = document.getElementById("detail-community-counts");
  if (!el) return;
  el.innerHTML = `
    <span>Users Buying: <strong>${buyCount}</strong></span>
    <span>Users Selling: <strong>${sellCount}</strong></span>
  `;
}

async function handleItemToggle(itemId, isBuy) {
  const currentState = await getItemState(itemId);
  const newState = isBuy
    ? (currentState === "buy" ? "none" : "buy")
    : (currentState === "sell" ? "none" : "sell");
  await setItemState(itemId, newState);
  if (newState !== "none") {
    trackEvent(newState === "buy" ? "add_to_buy_list" : "add_to_sell_list", { item_id: String(itemId) });
  }
  const resolvedItem = searchResultsMap[itemId]
    ?? loadWatchlist().find(i => i.id === itemId)
    ?? (() => { const h = loadPriceHistory()[itemId]; return h ? { id: itemId, name: h.name } : null; })();
  if (newState === "buy") {
    const bl = loadBuyList().filter(i => i.id !== itemId);
    if (resolvedItem) bl.push(resolvedItem);
    saveBuyList(bl);
    saveSellList(loadSellList().filter(i => i.id !== itemId));
  } else if (newState === "sell") {
    const sl = loadSellList().filter(i => i.id !== itemId);
    if (resolvedItem) sl.push(resolvedItem);
    saveSellList(sl);
    saveBuyList(loadBuyList().filter(i => i.id !== itemId));
  } else {
    saveBuyList(loadBuyList().filter(i => i.id !== itemId));
    saveSellList(loadSellList().filter(i => i.id !== itemId));
  }
  renderAll();
  return newState;
}


async function syncSupabasePrices() {
  const allItems = [...loadBuyList(), ...loadSellList()];
  if (!allItems.length) return;
  const ids = [...new Set(allItems.map(i => String(i.id)))];
  const prices = await fetchSupabasePrices(ids);
  if (!Object.keys(prices).length) return;

  const history = loadPriceHistory();
  const today   = new Date().toISOString().split("T")[0];
  let changed = false;

  for (const [itemId, { min, max }] of Object.entries(prices)) {
    if (!history[itemId]) {
      const item = allItems.find(i => String(i.id) === itemId);
      if (!item) continue;
      history[itemId] = { id: Number(itemId), name: item.name, pricechecks: [], supabasePrices: [] };
      changed = true;
    }
    const prev = (history[itemId].supabasePrices ?? []).at(-1);
    if (prev?.min === min && prev?.max === max) continue;
    history[itemId].supabasePrices = [...(history[itemId].supabasePrices ?? []), { min, max, date: today }];
    changed = true;
  }

  if (changed) { savePriceHistory(history); renderAll(); }
}

async function syncApprovedPriceLogs() {
  const allItems = [...loadBuyList(), ...loadSellList()];
  if (!allItems.length) return;
  const ids = [...new Set(allItems.map(i => String(i.id)))];

  const results = await Promise.all(ids.map(async id => ({ id, logs: await fetchApprovedPriceLogs(id) })));

  const history = loadPriceHistory();
  let changed = false;
  for (const { id, logs } of results) {
    if (!logs.length) continue;
    if (!history[id]) {
      const item = allItems.find(i => String(i.id) === id);
      if (!item) continue;
      history[id] = { id: Number(id), name: item.name, pricechecks: [], supabasePrices: [] };
    }
    history[id].approvedLogPrices = logs.map(l => l.price);
    changed = true;
  }
  if (changed) { savePriceHistory(history); renderAll(); }
}

let currentDetailId = null;
let currentDetailName = "";
let detailApprovedLogs = [];
let sparklineCurrency = 1;

// Coin min/max = Supabase prices table aggregate only (not the user's own logs or approved community logs)
function computeDetailCoinRange(entry) {
  const latest = (entry?.supabasePrices ?? []).at(-1);
  if (!latest) return null;
  const min = latest.min > 0 ? latest.min : null;
  const max = latest.max > 0 ? latest.max : null;
  return (min != null || max != null) ? { min, max } : null;
}
const submitBlockedToday = new Map();
let buyPage  = 1;
let sellPage = 1;
let detailLogPage = 1;
const PRICES_PAGE_SIZE = 12;
// Buy and Sell show a fixed number of rows, so the page size follows the number of columns
const LIST_ROWS_PER_PAGE = 4;
function listPageSize(listType) {
  const grid = document.getElementById(`${listType}-cards`);
  const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length : 1;
  return Math.max(1, cols) * LIST_ROWS_PER_PAGE;
}
const DETAIL_LOG_PAGE_SIZE = 3;

// ── Price History Storage ──────────────────────────────────────
function loadPriceHistory() {
  return JSON.parse(localStorage.getItem("priceHistory") || "{}");
}

function savePriceHistory(history) {
  localStorage.setItem("priceHistory", JSON.stringify(history));
}

// Category written to the item's prices row by the admin extension, or null if none.
async function fetchSupabaseItemCategory(itemId) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/prices?item_id=eq.${encodeURIComponent(String(itemId))}&select=category`;
    const res = await fetch(url, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0]?.category ?? null;
  } catch {
    return null;
  }
}

// Category and store status from the item's prices row in Supabase.
async function fetchItemInfo(itemId) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/prices?item_id=eq.${encodeURIComponent(String(itemId))}&select=category,active_in_store`;
    const res = await fetch(url, {
      headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) return null;
    const row = (await res.json())[0];
    if (!row) return null;
    return {
      category: row.category ?? null,
      parentCategory: null,
      subCategoryName: null,
      activeInStore: !!row.active_in_store,
    };
  } catch {
    return null;
  }
}

async function resolveCategories() {
  const history = loadPriceHistory();
  let historyUpdated = false;

  // Resolve for price history entries
  for (const entry of Object.values(history)) {
    if (entry.subCategory && "activeInStore" in entry) continue;
    const info = await fetchItemInfo(entry.id);
    if (info) {
      if (info.category) history[entry.id].subCategory = info.category;
      if (info.parentCategory) history[entry.id].parentCategory = info.parentCategory;
      history[entry.id].activeInStore = info.activeInStore;
      historyUpdated = true;
    }
  }
  if (historyUpdated) savePriceHistory(history);

  // Resolve for buy/sell list items
  const buyList = loadBuyList();
  let buyUpdated = false;
  for (let i = 0; i < buyList.length; i++) {
    if (buyList[i].subCategory && "activeInStore" in buyList[i]) continue;
    const info = await fetchItemInfo(buyList[i].id);
    if (info) {
      if (info.category) buyList[i].subCategory = info.category;
      if (info.parentCategory) buyList[i].parentCategory = info.parentCategory;
      buyList[i].activeInStore = info.activeInStore;
      buyUpdated = true;
    }
  }
  if (buyUpdated) saveBuyList(buyList);

  const sellList = loadSellList();
  let sellUpdated = false;
  for (let i = 0; i < sellList.length; i++) {
    if (sellList[i].subCategory && "activeInStore" in sellList[i]) continue;
    const info = await fetchItemInfo(sellList[i].id);
    if (info) {
      if (info.category) sellList[i].subCategory = info.category;
      if (info.parentCategory) sellList[i].parentCategory = info.parentCategory;
      sellList[i].activeInStore = info.activeInStore;
      sellUpdated = true;
    }
  }
  if (sellUpdated) saveSellList(sellList);

  const watchlistUpdated = buyUpdated || sellUpdated;

  if (historyUpdated || watchlistUpdated) renderAll();
}




function removePricecheck(itemId, index) {
  const history = loadPriceHistory();
  if (!history[itemId]) return;
  history[itemId].pricechecks.splice(index, 1);
  savePriceHistory(history);
}

// In-memory store for search results (keyed by id) so buttons can look up by id
let searchResultsMap = {};

// ── Storage ────────────────────────────────────────────────────
function loadBuyList() {
  const stored = localStorage.getItem("buyList");
  if (stored) return JSON.parse(stored);
  // Migrate legacy watchlist to buy list on first load
  const legacy = localStorage.getItem("watchlist");
  return legacy ? JSON.parse(legacy) : [];
}

function saveBuyList(list) {
  localStorage.setItem("buyList", JSON.stringify(list));
}

function loadSellList() {
  return JSON.parse(localStorage.getItem("sellList") || "[]");
}

function saveSellList(list) {
  localStorage.setItem("sellList", JSON.stringify(list));
}

function loadWatchlist() {
  return [...loadBuyList(), ...loadSellList()];
}

function isInBuyList(id) {
  return loadBuyList().some(i => i.id === id);
}

function isInSellList(id) {
  return loadSellList().some(i => i.id === id);
}

function removeFromBuyList(id) {
  saveBuyList(loadBuyList().filter(i => i.id !== id));
  renderAll();
}

function removeFromSellList(id) {
  saveSellList(loadSellList().filter(i => i.id !== id));
  renderAll();
}


// ── Image URL ──────────────────────────────────────────────────
function itemImage(id) {
  const s = String(id);
  return `https://yw-web.yoworld.com/cdn/items/${s.slice(0,2)}/${s.slice(2,4)}/${s}/${s}.png`;
}

function itemImageFallback(id) {
  const s = String(id);
  return `https://yoworld.com/cdn/items/${s.slice(0,2)}/${s.slice(2,4)}/${s}/${s}_60_60.gif`;
}

// ── Helpers ────────────────────────────────────────────────────
function formatCoins(n) {
  if (!n && n !== 0) return "—";
  return Number(n).toLocaleString();
}

function thumbImg(id, name) {
  return `<img src="${itemImage(id)}" alt="${name}" class="item-thumb" data-id="${id}" />`;
}

function formatCoinsShort(n) {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + "m";
  }
  if (n >= 1000) {
    const v = n / 1000;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + "k";
  }
  return String(n);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function statusPillHtml(item) {
  if (!("activeInStore" in item)) return "";
  return item.activeInStore
    ? `<span class="status-pill in-store">In Store</span>`
    : `<span class="status-pill discontinued">Discontinued</span>`;
}

function itemCoinRange(itemId) {
  const entry = loadPriceHistory()[itemId];
  const pcCoins = (entry?.pricechecks ?? []).filter(p => p.currency === 1).map(p => p.price);
  const communityCoins = (entry?.supabasePrices ?? []).flatMap(p => [p.min, p.max]).filter(v => v > 0);
  const approvedLogCoins = (entry?.approvedLogPrices ?? []).filter(v => v > 0);
  const allCoins = [...pcCoins, ...communityCoins, ...approvedLogCoins];
  if (!allCoins.length) return null;
  return { min: Math.min(...allCoins), max: Math.max(...allCoins) };
}

// ── Buy/Sell export selection & paintboard state ────────────────
let buyExportSelection = new Set();
let sellExportSelection = new Set();

// null (sidebar closed) or "board" (390x260 paintboard) —
// the sidebar opens in board mode by default. In-memory only, resets on reload.
// On narrow screens the buy and sell sidebars start closed; the "Generate paintboards" button opens them.
const isNarrowScreen = window.matchMedia("(max-width: 800px)").matches;
const paintboardMode = { buy: isNarrowScreen ? null : "board", sell: isNarrowScreen ? null : "board" };
// The format last chosen in the panel, used when the panel is reopened
const paintboardFormat = { buy: "board", sell: "board" };

const CARD_BG_DEFAULT = "#ffffff";
const CARD_BG_OPTIONS = [
  { value: "transparent", label: "Transparent" },
  { value: "#ffffff", label: "White" },
  { value: "#f4f4f4", label: "Light grey" },
  { value: "#9c9c9c", label: "Dark grey" },
];

// Background, badge colour, and card effect are independent axes so any
// combination can be mixed and matched, rather than one bundled "theme".
const EXPORT_BACKGROUNDS = [
  // Background colours (first is the default)
  { key: "light-grey", label: "Light grey", swatch: "#f3f4f6", pageBg: "#f3f4f6", tileBg: "transparent", tileBorder: "#d1d5db" },
  // nameColor: item names switch to a light shade on dark backgrounds so they stay readable
  { key: "dark-grey", label: "Dark grey", swatch: "#4b5563", pageBg: "#4b5563", tileBg: "transparent", tileBorder: "#374151", nameColor: "#f3f4f6" },
  { key: "white", label: "White", swatch: "#ffffff", pageBg: "#ffffff", tileBg: "transparent", tileBorder: "#d8d8d8" },
  { key: "cream", label: "Cream", swatch: "#fdf6e3", pageBg: "#fdf6e3", tileBg: "transparent", tileBorder: "#e7d9b0" },
  { key: "baby-pink", label: "Baby pink", swatch: "#fce7f3", pageBg: "#fce7f3", tileBg: "transparent", tileBorder: "#f472b6" },
  { key: "baby-blue", label: "Baby blue", swatch: "#cffafe", pageBg: "#cffafe", tileBg: "transparent", tileBorder: "#06b6d4" },
  { key: "baby-green", label: "Baby green", swatch: "#d1fae5", pageBg: "#d1fae5", tileBg: "transparent", tileBorder: "#10b981" },
  { key: "baby-yellow", label: "Baby yellow", swatch: "#fef9c3", pageBg: "#fef9c3", tileBg: "transparent", tileBorder: "#eab308" },
];

const EXPORT_BADGE_COLORS = [
  // Text colours (first is the default). Sets item names, prices and the Buying/Selling badge
  { key: "black-text", label: "Black", swatch: "#000000", nameColor: "#000000", priceColor: "#000000", badgeBg: "#e5e7eb", badgeText: "#000000" },
  { key: "white-text", label: "White", swatch: "#ffffff", nameColor: "#ffffff", priceColor: "#ffffff", badgeBg: "#1f2937", badgeText: "#ffffff" },
  { key: "brown-text", label: "Brown", swatch: "#78350f", nameColor: "#78350f", priceColor: "#78350f", badgeBg: "#f3e6d3", badgeText: "#78350f" },
  { key: "pink-text", label: "Pink", swatch: "#db2777", nameColor: "#db2777", priceColor: "#db2777", badgeBg: "#fce7f3", badgeText: "#db2777" },
  { key: "blue-text", label: "Blue", swatch: "#2563eb", nameColor: "#2563eb", priceColor: "#2563eb", badgeBg: "#dbeafe", badgeText: "#2563eb" },
  { key: "green-text", label: "Green", swatch: "#16a34a", nameColor: "#16a34a", priceColor: "#16a34a", badgeBg: "#dcfce7", badgeText: "#16a34a" },
  { key: "dark-yellow-text", label: "Dark yellow", swatch: "#a16207", nameColor: "#a16207", priceColor: "#a16207", badgeBg: "#fef9c3", badgeText: "#a16207" },
];

const EXPORT_CARD_EFFECTS = [
  // Glow colours (first is the default)
  { key: "none", label: "None", swatch: "transparent", tileGlow: "none", tileBorder: null },
  { key: "glow-white", label: "White", swatch: "#ffffff", tileGlow: "0 0 8px 2px rgba(255,255,255,0.65), 0 0 18px 5px rgba(255,255,255,0.35), inset 0 0 10px rgba(255,255,255,0.2)", tileBorder: "#ffffff" },
  { key: "glow-beige", label: "Beige", swatch: "#d6c7a1", tileGlow: "0 0 8px 2px rgba(214,199,161,0.65), 0 0 18px 5px rgba(214,199,161,0.35), inset 0 0 10px rgba(214,199,161,0.2)", tileBorder: "#d6c7a1" },
  { key: "glow-pink", label: "Pink", swatch: "#f472b6", tileGlow: "0 0 8px 2px rgba(244,114,182,0.65), 0 0 18px 5px rgba(244,114,182,0.35), inset 0 0 10px rgba(244,114,182,0.2)", tileBorder: "#f472b6" },
  { key: "glow-blue", label: "Blue", swatch: "#06b6d4", tileGlow: "0 0 8px 2px rgba(6,182,212,0.65), 0 0 18px 5px rgba(6,182,212,0.35), inset 0 0 10px rgba(6,182,212,0.2)", tileBorder: "#06b6d4" },
  { key: "glow-green", label: "Green", swatch: "#22c55e", tileGlow: "0 0 8px 2px rgba(34,197,94,0.65), 0 0 18px 5px rgba(34,197,94,0.35), inset 0 0 10px rgba(34,197,94,0.2)", tileBorder: "#22c55e" },
  { key: "glow-yellow", label: "Yellow", swatch: "#facc15", tileGlow: "0 0 8px 2px rgba(250,204,21,0.65), 0 0 18px 5px rgba(250,204,21,0.35), inset 0 0 10px rgba(250,204,21,0.2)", tileBorder: "#facc15" },
];

const EXPORT_BORDER_OPTIONS = [
  { key: "none", label: "None", hasBorder: false, radius: 0 },
  { key: "rounded", label: "Rounded", hasBorder: true, radius: 8 },
  { key: "sharp", label: "Sharp", hasBorder: true, radius: 0 },
];

function loadExportBorder() {
  const key = localStorage.getItem("exportBorder");
  return EXPORT_BORDER_OPTIONS.find(o => o.key === key) || EXPORT_BORDER_OPTIONS[0];
}

function setExportBorder(key) {
  localStorage.setItem("exportBorder", key);
  renderAll();
}

const CUSTOM_DEFAULTS = { background: "#ffffff", badgecolor: "#000000", effect: "#7525e2" };
const CUSTOM_HEX_KEYS = { background: "exportCustomBackground", badgecolor: "exportCustomBadgeColor", effect: "exportCustomGlow" };
const CUSTOM_SELECT_KEYS = { background: "exportBackground", badgecolor: "exportBadgeColor", effect: "exportCardEffect" };
const HEX_RE = /^#[0-9a-f]{6}$/i;

function loadCustomHex(kind) {
  const saved = (localStorage.getItem(CUSTOM_HEX_KEYS[kind]) || "").trim();
  return HEX_RE.test(saved) ? saved.toLowerCase() : CUSTOM_DEFAULTS[kind];
}

function applyCustomHex(kind, hex) {
  localStorage.setItem(CUSTOM_HEX_KEYS[kind], hex.toLowerCase());
  localStorage.setItem(CUSTOM_SELECT_KEYS[kind], "custom");
  renderAll();
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(hex, target, amount) {
  const a = hexRgb(hex), b = hexRgb(target);
  const mixed = a.map((v, i) => Math.round(v + (b[i] - v) * amount));
  return "#" + mixed.map(v => v.toString(16).padStart(2, "0")).join("");
}

function customBackgroundOption(hex) {
  return { key: "custom", label: hex.toUpperCase(), swatch: hex, pageBg: hex, tileBg: "transparent", tileBorder: mixHex(hex, "#000000", 0.25) };
}

function customBadgeOption(hex) {
  return { key: "custom", label: hex.toUpperCase(), swatch: hex, nameColor: hex, priceColor: hex, badgeBg: mixHex(hex, "#ffffff", 0.85), badgeText: hex };
}

function customEffectOption(hex) {
  const [r, g, b] = hexRgb(hex);
  return {
    key: "custom",
    label: hex.toUpperCase(),
    swatch: hex,
    tileGlow: `0 0 8px 2px rgba(${r},${g},${b},0.65), 0 0 18px 5px rgba(${r},${g},${b},0.35), inset 0 0 10px rgba(${r},${g},${b},0.2)`,
    tileBorder: hex,
  };
}

function loadExportBackground() {
  const key = localStorage.getItem("exportBackground");
  if (key === "custom") return customBackgroundOption(loadCustomHex("background"));
  return EXPORT_BACKGROUNDS.find(b => b.key === key) || EXPORT_BACKGROUNDS[0];
}

function setExportBackground(key) {
  localStorage.setItem("exportBackground", key);
  renderAll();
}

function loadExportBadgeColor() {
  const key = localStorage.getItem("exportBadgeColor");
  if (key === "custom") return customBadgeOption(loadCustomHex("badgecolor"));
  return EXPORT_BADGE_COLORS.find(b => b.key === key) || EXPORT_BADGE_COLORS[0];
}

function setExportBadgeColor(key) {
  localStorage.setItem("exportBadgeColor", key);
  renderAll();
}

function loadExportCardEffect() {
  const key = localStorage.getItem("exportCardEffect");
  if (key === "custom") return customEffectOption(loadCustomHex("effect"));
  return EXPORT_CARD_EFFECTS.find(e => e.key === key) || EXPORT_CARD_EFFECTS[0];
}

function setExportCardEffect(key) {
  localStorage.setItem("exportCardEffect", key);
  renderAll();
}

// Merges the independent picks into one theme-shaped object so the
// rendering code (boardCellHtml, buildBoardHtml, resolveBadgeColors) doesn't
// need to know they're separate settings.
function getExportStyle() {
  const bg = loadExportBackground();
  const badge = loadExportBadgeColor();
  const effect = loadExportCardEffect();
  const border = loadExportBorder();
  const tileBorder = "#d1d5db";
  return {
    swatch: bg.swatch,
    pageBg: bg.pageBg,
    tileBg: bg.tileBg,
    tileBorder: tileBorder,
    // Item names and the Buying/Selling badge keep their fixed look.
    // Only the price (the free text under each item) uses the text colour.
    nameColor: bg.nameColor ?? "#374151",
    priceColor: badge.priceColor,
    tileGlow: effect.tileGlow,
    tileRadius: border.radius,
    tileBorderOn: border.hasBorder || (effect.tileGlow !== "none"),
    badgeBg: "#e5e7eb",
    badgeText: "#000000",
  };
}

const EXPORT_FONTS = [
  { key: "sans", label: "Default", family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { key: "serif", label: "Serif", family: "Georgia, 'Times New Roman', serif" },
  { key: "mono", label: "Code", family: "'Roboto Mono', 'SF Mono', Menlo, Consolas, monospace" },
];

function loadExportFont() {
  const key = localStorage.getItem("exportFont");
  return EXPORT_FONTS.find(f => f.key === key) || EXPORT_FONTS[0];
}

function setExportFont(key) {
  localStorage.setItem("exportFont", key);
  renderAll();
}

const EXPORT_COUNT_OPTIONS = [
  { count: 2, cols: 2, rows: 1, badgeSize: 10, nameSize: 12, priceSize: 18, rowGap: 8 },
  { count: 6, cols: 3, rows: 2, badgeSize: 8, nameSize: 9, priceSize: 13, rowGap: 8 },
];

const FB_POST_COLS = [3, 4, 5, 6];
const FB_POST_MAX_RATIO = 2;
const FB_POST_MAX_ITEMS = 36;
const FB_POST_CELL_H = 290;
const FB_POST_ROW_GAP = 18;
const FB_POST_FONTS = { badgeSize: 16, nameSize: 18, priceSize: 20 };

const FB_POST_COL_GAP = 18;
const LOGO_SVG = "<svg width=\"150\" height=\"150\" viewBox=\"0 0 150 150\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M133.333 0H16.6667C7.5 0 0 7.5 0 16.6667V133.333C0 142.5 7.5 150 16.6667 150H133.333C142.5 150 150 142.5 150 133.333V16.6667C150 7.5 142.5 0 133.333 0ZM50 116.667H33.3333V75H50V116.667ZM83.3333 116.667H66.6667V91.6667H83.3333V116.667ZM83.3333 75H66.6667V58.3333H83.3333V75ZM116.667 116.667H100V33.3333H116.667V116.667Z\" fill=\"#7525E2\"/>\n<path d=\"M133.333 0H16.6667C7.5 0 0 7.5 0 16.6667V133.333C0 142.5 7.5 150 16.6667 150H133.333C142.5 150 150 142.5 150 133.333V16.6667C150 7.5 142.5 0 133.333 0ZM50 116.667H33.3333V75H50V116.667ZM83.3333 116.667H66.6667V91.6667H83.3333V116.667ZM83.3333 75H66.6667V58.3333H83.3333V75ZM116.667 116.667H100V33.3333H116.667V116.667Z\" fill=\"#7525E2\" fill-opacity=\"0.2\"/>\n</svg>";
const FB_POST_BASE_W = 1080;

function loadExportItemCount() {
  const stored = Number(localStorage.getItem("exportItemCount"));
  return EXPORT_COUNT_OPTIONS.find(o => o.count === stored) || EXPORT_COUNT_OPTIONS[1];
}

function setExportItemCount(count) {
  localStorage.setItem("exportItemCount", String(count));
  renderAll();
}

const EXPORT_TITLE_DEFAULTS = { buy: "Want to Buy", sell: "Want to Sell" };

function getExportTitle(listType) {
  const saved = (localStorage.getItem(`exportTitle-${listType}`) || "").trim();
  return saved || EXPORT_TITLE_DEFAULTS[listType];
}

function setExportTitle(listType, text) {
  localStorage.setItem(`exportTitle-${listType}`, text.trim());
  renderAll();
}

function fbPostHeight(rows) {
  return 180 + rows * FB_POST_CELL_H + (rows - 1) * FB_POST_ROW_GAP;
}

// Picks the fewest columns whose post stays within FB_POST_MAX_RATIO of its width
function fbPostLayout(itemCount) {
  const n = Math.max(1, Math.min(itemCount, FB_POST_MAX_ITEMS));
  for (const cols of FB_POST_COLS) {
    const rows = Math.ceil(n / cols);
    const width = FB_POST_BASE_W * cols / 5;
    if (fbPostHeight(rows) <= width * FB_POST_MAX_RATIO) {
      return { cols, rows, rowGap: FB_POST_ROW_GAP, width };
    }
  }
  const cols = 6;
  return { cols, rows: Math.ceil(n / cols), rowGap: FB_POST_ROW_GAP, width: FB_POST_BASE_W * cols / 5 };
}

// Category headings were removed from the FB Post options, so they are always off
function loadFBCategoryHeadings() {
  return false;
}

function loadExportShowBadge() {
  return localStorage.getItem("exportShowBadge") === "true";
}

function setExportShowBadge(show) {
  localStorage.setItem("exportShowBadge", String(show));
  renderAll();
}

function exportSelectionFor(listType) {
  return listType === "buy" ? buyExportSelection : sellExportSelection;
}

function toggleExportSelection(listType, id) {
  const sel = exportSelectionFor(listType);
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  renderAll();
}

// Items are selected by default when they first appear in a list.
// Once you deselect one, it stays deselected.
const seenExportIds = { buy: new Set(), sell: new Set() };

function selectNewExportItems(listType, list) {
  const sel = exportSelectionFor(listType);
  const seen = seenExportIds[listType];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    sel.add(item.id);
  }
}

function pruneExportSelection(listType, list) {
  const sel = exportSelectionFor(listType);
  const seen = seenExportIds[listType];
  const ids = new Set(list.map(i => i.id));
  for (const id of sel) if (!ids.has(id)) sel.delete(id);
  for (const id of seen) if (!ids.has(id)) seen.delete(id);
}

function setItemBg(listType, id, color) {
  const list = listType === "buy" ? loadBuyList() : loadSellList();
  const item = list.find(i => i.id === id);
  if (!item) return;
  item.bgColor = color;
  if (listType === "buy") saveBuyList(list); else saveSellList(list);
  renderAll();
}

function bulkSetCardBg(listType, color) {
  const list = listType === "buy" ? loadBuyList() : loadSellList();
  const selected = exportSelectionFor(listType);
  for (const item of list) {
    if (selected.has(item.id)) {
      item.bgColor = color;
    }
  }
  if (listType === "buy") saveBuyList(list); else saveSellList(list);
  renderAll();
}

function setOfferPrice(listType, id, rawValue) {
  const list = listType === "buy" ? loadBuyList() : loadSellList();
  const item = list.find(i => i.id === id);
  if (!item) return;
  const value = rawValue.trim();
  if (value === "") delete item.offerPrice;
  else item.offerPrice = value;
  if (listType === "buy") saveBuyList(list); else saveSellList(list);
  renderAll();
}

function buildListCategoryOptions() {
  const names = Object.keys(CATEGORY_ID_MAP).sort();
  return `<option value="">All categories</option>` +
    names.map(n => `<option value="${n}">${n}</option>`).join("");
}

function getFilteredList(listType) {
  const list = listType === "buy" ? loadBuyList() : loadSellList();
  const query = document.getElementById(`${listType}-search`)?.value.toLowerCase() ?? "";
  const words = query.split(/\s+/).filter(Boolean);
  const selectedCats = loadCategorySelection(listType);
  const instore = loadInstoreSelection(listType);
  const sortOption = loadSortOption(listType);

  let filtered = list.filter(i => {
    if (!i.name) return false;
    const nameOk = !words.length || (() => { const n = i.name.toLowerCase(); return words.every(w => n.includes(w)); })();
    const catOk = selectedCats.size === 0 || selectedCats.has(i.subCategory || "");
    const instoreOk = !instore || (String(i.activeInStore) === instore);
    return nameOk && catOk && instoreOk;
  });

  // Apply sorting
  if (sortOption === "category") {
    filtered.sort((a, b) => {
      const catA = (a.subCategory || "").toLowerCase();
      const catB = (b.subCategory || "").toLowerCase();
      if (catA !== catB) return catA.localeCompare(catB);
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }

  return filtered;
}

function hasActiveFilter(listType) {
  const query = document.getElementById(`${listType}-search`)?.value ?? "";
  const selectedCats = loadCategorySelection(listType);
  const instore = loadInstoreSelection(listType);
  return !!(query || selectedCats.size > 0 || instore);
}

function toggleSelectAll(listType) {
  const filtered = getFilteredList(listType);
  const sel = exportSelectionFor(listType);
  const allSelected = filtered.length > 0 && filtered.every(i => sel.has(i.id));
  filtered.forEach(i => allSelected ? sel.delete(i.id) : sel.add(i.id));
  renderAll();
}

// ── Cards (no inline event handlers) ──────────────────────────
// Grid card for the Buy/Sell tabs, styled like the search results tiles.
function listGridCard(item, listType) {
  const range = itemCoinRange(item.id);
  const priceRange = range ? `<div class="search-tile-price">${COIN_ICON} ${range.min === range.max ? formatCoinsShort(range.min) : `${formatCoinsShort(range.min)} – ${formatCoinsShort(range.max)}`}</div>` : `<div class="search-tile-price search-tile-price--empty">No data</div>`;
  const selected = exportSelectionFor(listType).has(item.id);
  const bgColor = item.bgColor || CARD_BG_DEFAULT;
  const swatches = CARD_BG_OPTIONS.map(opt => `
    <button class="bg-swatch-option ${bgColor === opt.value ? "active" : ""}" data-action="set-${listType}-bg" data-id="${item.id}" data-color="${opt.value}">
      <span class="bg-swatch-dot" data-color="${opt.value}" style="background:${opt.value}"></span>
      <span class="bg-swatch-label">${opt.label}</span>
    </button>
  `).join("");
  const offerLabel = listType === "buy" ? "Your offer" : "Your price";
  const removeAction = listType === "sell" ? "remove-sell" : "remove-buy";

  return `
    <div class="search-tile-card" data-detail-id="${item.id}" draggable="true">
      <div class="search-tile" style="background:${bgColor}">
        <button class="wl-export-check ${selected ? "checked" : ""}" data-action="toggle-export-${listType}" data-id="${item.id}" title="Select for PNG export">${selected ? "✓" : ""}</button>
        <button class="wl-remove-btn" data-action="${removeAction}" data-id="${item.id}">✕</button>
        ${thumbImg(item.id, item.name)}
      </div>
      <div class="search-tile-status">${statusPillHtml(item)}</div>
      <div class="search-tile-name">${item.name} ${storeBadge(item.activeInStore)}</div>
      ${priceRange}
      <div class="list-offer-row">
        <span class="list-offer-label">${offerLabel}</span>
        <div class="search-box">
          <div class="input-wrap">
            <img src="${chrome.runtime.getURL('icons/coin.png')}" class="input-icon" />
            <input type="text" class="list-offer-input" data-action="set-${listType}-offer" data-id="${item.id}" placeholder="e.g. 100000" value="${escapeHtml(item.offerPrice ?? "")}" />
          </div>
        </div>
      </div>
      <div class="bg-picker">
        <button class="bg-swatch-main" data-action="toggle-bg-picker" data-id="${item.id}" data-color="${bgColor}" title="Card background" style="background:${bgColor}"></button>
        <div class="bg-picker-menu bg-picker-menu--list hidden">${swatches}</div>
      </div>
    </div>`;
}

function buildListPriceSummary(list) {
  let totalMin = 0, totalMax = 0, itemsWithData = 0;
  for (const item of list) {
    const range = itemCoinRange(item.id);
    if (!range) continue;
    totalMin += range.min;
    totalMax += range.max;
    itemsWithData++;
  }
  if (!itemsWithData) return "";
  const rangeStr = totalMin === totalMax ? formatCoinsShort(totalMin) : `${formatCoinsShort(totalMin)} — ${formatCoinsShort(totalMax)}`;
  return `<div class="list-price-summary">${COIN_ICON} ${rangeStr}</div>`;
}

function searchResultCard(item) {
  const inBuy  = isInBuyList(item.id);
  const inSell = isInSellList(item.id);

  const entry = loadPriceHistory()[item.id];
  const pcCoins = (entry?.pricechecks ?? []).filter(p => p.currency === 1).map(p => p.price);
  const communityCoins = (entry?.supabasePrices ?? []).flatMap(p => [p.min, p.max]).filter(v => v > 0);
  const approvedLogCoins = (entry?.approvedLogPrices ?? []).filter(v => v > 0);
  const allCoins = [...pcCoins, ...communityCoins, ...approvedLogCoins];
  let priceRange = "";
  if (allCoins.length) {
    const lo = Math.min(...allCoins), hi = Math.max(...allCoins);
    priceRange = `<div class="search-tile-price">${COIN_ICON} ${lo === hi ? formatCoins(lo) : `${formatCoins(lo)} – ${formatCoins(hi)}`}</div>`;
  }

  const statusPill = item.activeInStore
    ? `<span class="status-pill in-store">In Store</span>`
    : `<span class="status-pill discontinued">Discontinued</span>`;

  return `
    <div class="search-tile-card" data-detail-id="${item.id}" style="cursor:pointer">
      <div class="search-tile">
        <button class="tile-pill tile-pill-sell ${inSell ? "added" : ""}" data-action="watch-sell" data-id="${item.id}" title="Sell">
          ${TAG_ICON}
          <span class="tile-pill-label">${inSell ? "Remove" : "Sell"}</span>
        </button>
        <button class="tile-pill tile-pill-buy ${inBuy ? "added" : ""}" data-action="watch-buy" data-id="${item.id}" title="Buy">
          ${CART_ICON}
          <span class="tile-pill-label">${inBuy ? "Remove" : "Buy"}</span>
        </button>
        ${thumbImg(item.id, item.name)}
      </div>
      <div class="search-tile-status">${statusPill}</div>
      <div class="search-tile-name">${item.name}</div>
      ${priceRange}
    </div>`;
}

function renderPagination(elIds, prevAction, nextAction, current, total, pageSize = PRICES_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const html = totalPages <= 1 ? "" : `
    <button class="page-btn" data-action="${prevAction}" ${current === 1 ? "disabled" : ""}>‹</button>
    <span class="page-info">Page ${current} of ${totalPages}</span>
    <button class="page-btn" data-action="${nextAction}" ${current === totalPages ? "disabled" : ""}>›</button>
  `;
  for (const elId of Array.isArray(elIds) ? elIds : [elIds]) {
    const el = document.getElementById(elId);
    if (el) el.innerHTML = html;
  }
}

// ── Buy/Sell card drag-to-reorder ────────────────────────────────
let dragState = null;

function dragCardListType(card) {
  const grid = card.closest("#buy-cards, #sell-cards");
  return grid ? (grid.id === "buy-cards" ? "buy" : "sell") : null;
}

function reorderList(listType, draggedId, targetId) {
  const list = listType === "buy" ? loadBuyList() : loadSellList();
  const fromIdx = list.findIndex(i => i.id === draggedId);
  const toIdx = list.findIndex(i => i.id === targetId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);
  if (listType === "buy") saveBuyList(list); else saveSellList(list);

  if (loadSortOption(listType) === "category") {
    saveSortOption(listType, "none");
    const radioBtn = document.querySelector(`input[name="${listType}-sort-option"][value="none"]`);
    if (radioBtn) radioBtn.checked = true;
  }
  renderAll();
}

document.addEventListener("dragstart", e => {
  const card = e.target.closest(".search-tile-card[draggable='true']");
  if (!card) return;
  if (e.target.closest("input, button, .bg-picker-menu")) { e.preventDefault(); return; }
  const listType = dragCardListType(card);
  if (!listType) return;
  dragState = { listType, id: Number(card.dataset.detailId) };
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", card.dataset.detailId);
});

// Hover-to-page-turn: dwell over the prev/next pagination button while
// dragging to auto-advance the page, so a card can be dropped on a page
// that isn't currently rendered.
const PAGE_TURN_DWELL_MS = 600;
let pageTurnTimer = null;
let pageTurnTarget = null;

function clearPageTurnTimer() {
  if (pageTurnTimer) clearTimeout(pageTurnTimer);
  pageTurnTimer = null;
  pageTurnTarget = null;
}

document.addEventListener("dragover", e => {
  if (!dragState) return;

  const pageBtn = e.target.closest(
    `.pagination button[data-action="${dragState.listType}-prev"], .pagination button[data-action="${dragState.listType}-next"]`
  );
  if (pageBtn) {
    e.preventDefault();
    if (pageBtn.disabled) { clearPageTurnTimer(); return; }
    if (pageTurnTarget === pageBtn) return;
    clearPageTurnTimer();
    pageTurnTarget = pageBtn;
    pageBtn.classList.add("drag-over");
    pageTurnTimer = setTimeout(() => {
      const direction = pageBtn.dataset.action.endsWith("-next") ? 1 : -1;
      if (dragState.listType === "buy") buyPage += direction; else sellPage += direction;
      renderAll();
      pageTurnTimer = null;
      pageTurnTarget = null;
    }, PAGE_TURN_DWELL_MS);
    return;
  }

  const card = e.target.closest(".search-tile-card[draggable='true']");
  if (!card || dragCardListType(card) !== dragState.listType) return;
  e.preventDefault();
  card.classList.add("drag-over");
});

document.addEventListener("dragleave", e => {
  const pageBtn = e.target.closest(".pagination button");
  if (pageBtn && pageBtn === pageTurnTarget) {
    pageBtn.classList.remove("drag-over");
    clearPageTurnTimer();
  }
  const card = e.target.closest(".search-tile-card[draggable='true']");
  if (card) card.classList.remove("drag-over");
});

document.addEventListener("drop", e => {
  document.querySelectorAll(".search-tile-card.drag-over").forEach(el => el.classList.remove("drag-over"));
  if (!dragState) return;
  const card = e.target.closest(".search-tile-card[draggable='true']");
  if (!card || dragCardListType(card) !== dragState.listType) return;
  e.preventDefault();
  const targetId = Number(card.dataset.detailId);
  if (targetId !== dragState.id) reorderList(dragState.listType, dragState.id, targetId);
});

document.addEventListener("dragend", () => {
  document.querySelectorAll(".search-tile-card.dragging").forEach(el => el.classList.remove("dragging"));
  document.querySelectorAll(".search-tile-card.drag-over, .pagination button.drag-over").forEach(el => el.classList.remove("drag-over"));
  clearPageTurnTimer();
  dragState = null;
});

// ── Paintboard / FB Post PNG export ─────────────────────────────
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Fetched (rather than hot-linked) so the drawn image is same-origin data:
// and doesn't taint the canvas on export.
async function fetchImageAsDataURL(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function loadItemImageDataUrl(id) {
  return (await fetchImageAsDataURL(itemImage(id))) ?? (await fetchImageAsDataURL(itemImageFallback(id)));
}

// Picks badge colors for one cell: buy vs sell, and — for themes that
// define an "OnWhite" variant — darker colors when that item's card
// background happens to be white.
function resolveBadgeColors(theme, listType, isWhiteBg) {
  const isSell = listType === "sell";
  if (isWhiteBg) {
    const bg = isSell ? theme.sellBadgeBgOnWhite : theme.badgeBgOnWhite;
    const text = isSell ? theme.sellBadgeTextOnWhite : theme.badgeTextOnWhite;
    if (bg && text) return { bg, text };
  }
  return {
    bg: isSell ? (theme.sellBadgeBg ?? theme.badgeBg) : theme.badgeBg,
    text: isSell ? (theme.sellBadgeText ?? theme.badgeText) : theme.badgeText,
  };
}

function boardCellHtml(item, imgDataUrl, listType, theme, showBadge) {
  // Empty slots still reserve the same .name/.price space as filled ones so
  // every .tile (flex: 1) in the grid comes out the same height.
  if (!item) return `<div class="cell"><div class="tile tile--empty"></div><div class="name"></div><div class="price"></div></div>`;
  const badgeLabel = listType === "sell" ? "Selling" : "Buying";
  const priceLabel = item.offerPrice ? escapeHtml(String(item.offerPrice)) : "";
  const bgColor = item.bgColor !== undefined ? item.bgColor : CARD_BG_DEFAULT;
  const { bg: badgeBg, text: badgeText } = resolveBadgeColors(theme, listType, bgColor === "#ffffff");
  const badgeHtml = showBadge ? `<div class="badge" style="background:${badgeBg};color:${badgeText}">${badgeLabel}</div>` : "";
  return `
    <div class="cell">
      <div class="tile" style="background:${bgColor}">
        ${badgeHtml}
        ${imgDataUrl ? `<img src="${imgDataUrl}" class="thumb" />` : ""}
      </div>
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="price">${priceLabel}</div>
    </div>`;
}

// Shared tile styling for the paintboard template. The tile itself (image +
// badge + name + price) is reused; only the surrounding page size/grid changes.
function tileStyleBlock(theme, { badgeSize, nameSize, priceSize, tilePad = 2, priceTop = 1, centerPrice = false }) {
  return `
      .cell { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .tile {
        position: relative;
        flex: 1;
        min-height: 0;
        margin-bottom: 12px; /* trims the image rectangle slightly */
        background: transparent;
        border: ${theme.tileBorderOn === false ? "none" : `1px solid ${theme.tileBorder}`};
        box-shadow: ${theme.tileGlow ?? "none"};
        border-radius: ${theme.tileRadius ?? 8}px;
        padding: ${tilePad}px;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .tile--empty {
        background: none;
        border-color: transparent;
        box-shadow: none;
      }
      .thumb { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; }
      .badge {
        position: absolute;
        top: 4px;
        left: 4px;
        font-size: ${badgeSize}px;
        font-weight: 700;
        line-height: 1.4;
        padding: 2px 6px;
        border-radius: 999px;
      }
      .name {
        font-size: ${nameSize}px;
        font-weight: 600;
        color: ${theme.nameColor};
        line-height: 1.25;
        height: ${nameSize * 1.25 * 2}px;
        margin-top: 3px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .price {
        font-size: ${priceSize}px;
        font-weight: 700;
        color: ${theme.priceColor};
        line-height: 1.2;
        height: ${priceSize * 1.2}px;
        margin-top: ${priceTop}px;
        text-align: ${centerPrice ? "center" : "left"};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
  `;
}

function groupItemsByCategory(items) {
  const groups = {};
  items.forEach(item => {
    const catName = item.category || "Uncategorized";
    if (!groups[catName]) {
      groups[catName] = [];
    }
    groups[catName].push(item);
  });
  return groups;
}

function buildBoardHtml(items, imgSrcs, listType) {
  const theme = getExportStyle();
  const font = loadExportFont();
  const { cols, rows, badgeSize, nameSize, priceSize, rowGap } = loadExportItemCount();
  const gridMax = cols * rows;
  const showBadge = loadExportShowBadge();
  const W = 390, H = 260;

  const cells = [];
  for (let idx = 0; idx < gridMax; idx++) {
    cells.push(boardCellHtml(items[idx] ?? null, imgSrcs[idx] ?? null, listType, theme, showBadge));
  }

  return `
    <div xmlns="http://www.w3.org/1999/xhtml" class="board">
      ${cells.join("")}
    </div>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .board {
        width: ${W}px;
        height: ${H}px;
        overflow: hidden;
        background: ${theme.pageBg};
        padding: 10px 18px;
        display: grid;
        grid-template-columns: repeat(${cols}, 1fr);
        grid-template-rows: repeat(${rows}, 1fr);
        column-gap: 8px;
        row-gap: ${rowGap}px;
        font-family: ${font.family};
      }
      ${tileStyleBlock(theme, { badgeSize, nameSize, priceSize, centerPrice: true })}
    </style>`;
}

function buildFacebookPreviewHtml(items, imgSrcs, listType) {
  const theme = getExportStyle();
  const font = loadExportFont();
  const layout = fbPostLayout(items.length);
  const gridMax = layout.cols * layout.rows;
  const showBadge = loadExportShowBadge();
  const title = getExportTitle(listType);

  const FB_POST_W = layout.width;
  const totalContentHeight = layout.rows * FB_POST_CELL_H + (layout.rows - 1) * layout.rowGap;
  const FB_POST_H = 80 + 28 + 44 + totalContentHeight + 40;

  const cells = [];
  for (let idx = 0; idx < gridMax; idx++) {
    cells.push(boardCellHtml(items[idx] ?? null, imgSrcs[idx] ?? null, listType, theme, showBadge));
  }

  const gridTemplateRows = `repeat(${layout.rows}, ${FB_POST_CELL_H}px)`;

  return `
    <div xmlns="http://www.w3.org/1999/xhtml" class="fb-post">
      <div class="fb-header">
        <span class="fb-title">${escapeHtml(title)}</span>
      </div>
      <div class="fb-content" style="display: grid; grid-template-columns: repeat(${layout.cols}, 1fr); column-gap: 8px; row-gap: ${layout.rowGap}px;">
        ${cells.join("")}
      </div>
    </div>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .fb-post {
        width: ${FB_POST_W}px;
        overflow: hidden;
        background: ${theme.pageBg};
        padding: 20px 16px;
      }
      .fb-header {
        text-align: center;
        margin-bottom: 12px;
      }
      .fb-title {
        font-size: 20px;
        font-weight: bold;
        color: ${theme.chipColor};
        font-family: ${font.family};
      }
      .fb-content {
        display: grid;
        grid-template-columns: repeat(${layout.cols}, 1fr);
        column-gap: 8px;
        row-gap: ${layout.rowGap}px;
      }
      ${tileStyleBlock(theme, { badgeSize: FB_POST_FONTS.badgeSize, nameSize: FB_POST_FONTS.nameSize, priceSize: FB_POST_FONTS.priceSize, tilePad: 12, priceTop: 8, centerPrice: true })}
    </style>`;
}

function buildFacebookHtml(items, imgSrcs, listType) {
  const theme = getExportStyle();
  const font = loadExportFont();
  const layout = fbPostLayout(items.length);
  const gridMax = layout.cols * layout.rows;
  const showBadge = loadExportShowBadge();
  const title = getExportTitle(listType);
  const showHeadings = loadFBCategoryHeadings();

  const FB_POST_W = layout.width;

  let totalContentHeight = 0;
  if (showHeadings) {
    const groups = groupItemsByCategory(items);
    const categories = Object.entries(groups);

    for (let i = 0; i < categories.length; i++) {
      const [, categoryItems] = categories[i];
      const itemsInCategory = categoryItems.slice(0, gridMax).length;
      const rowsNeeded = Math.ceil(itemsInCategory / layout.cols);

      totalContentHeight += 40;
      totalContentHeight += rowsNeeded * FB_POST_CELL_H;
      totalContentHeight += (rowsNeeded) * layout.rowGap;
      if (i < categories.length - 1) {
        totalContentHeight += layout.rowGap;
      }
    }
  } else {
    totalContentHeight = layout.rows * FB_POST_CELL_H + (layout.rows - 1) * layout.rowGap;
  }

  const FB_POST_H = 80 + 28 + 44 + totalContentHeight + 40;

  let cells = [];

  if (showHeadings) {
    const groups = groupItemsByCategory(items);
    let itemIdx = 0;

    for (const [categoryName, categoryItems] of Object.entries(groups)) {
      cells.push(`<div class="fb-category-heading" style="grid-column: 1 / -1; color: ${theme.chipColor}; font-weight: bold; text-align: left; padding: 8px 0; font-size: 18px;">${escapeHtml(categoryName)}</div>`);

      for (const item of categoryItems) {
        if (itemIdx < gridMax) {
          const imgSrc = imgSrcs[items.indexOf(item)] ?? null;
          cells.push(boardCellHtml(item, imgSrc, listType, theme, showBadge));
          itemIdx++;
        }
      }
    }

    while (itemIdx < gridMax) {
      cells.push(boardCellHtml(null, null, listType, theme, showBadge));
      itemIdx++;
    }
  } else {
    for (let idx = 0; idx < gridMax; idx++) {
      cells.push(boardCellHtml(items[idx] ?? null, imgSrcs[idx] ?? null, listType, theme, showBadge));
    }
  }

  let gridTemplateRows = "";
  if (showHeadings) {
    const groups = groupItemsByCategory(items);
    const itemHeightPx = FB_POST_CELL_H;
    const headingHeightPx = 40;
    let rowsDefinition = [];

    for (const [categoryName, categoryItems] of Object.entries(groups)) {
      rowsDefinition.push(`${headingHeightPx}px`);
      const itemsInCategory = categoryItems.slice(0, gridMax).length;
      const rowsNeeded = Math.ceil(itemsInCategory / layout.cols);
      for (let i = 0; i < rowsNeeded; i++) {
        rowsDefinition.push(`${itemHeightPx}px`);
      }
    }
    gridTemplateRows = rowsDefinition.join(" ");
  } else {
    gridTemplateRows = `repeat(${layout.rows}, ${FB_POST_CELL_H}px)`;
  }

  return `
    <div xmlns="http://www.w3.org/1999/xhtml" class="fb-board">
      <div class="fb-title-wrapper">
        <div class="fb-title">${escapeHtml(title)}</div>
      </div>
      <div class="fb-grid">${cells.join("")}</div>
    </div>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .fb-board {
        width: ${FB_POST_W}px;
        height: ${FB_POST_H}px;
        overflow: hidden;
        background: ${theme.pageBg};
        padding: 50px 44px 44px;
        display: flex;
        flex-direction: column;
        font-family: ${font.family};
      }
      .fb-title-wrapper {
        display: flex;
        justify-content: center;
        align-items: center;
        margin-bottom: 28px;
        flex-shrink: 0;
      }
      .fb-title {
        font-size: 40px;
        font-weight: 800;
        color: ${theme.nameColor};
        text-align: center;
        flex: 1;
      }
      .fb-grid {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(${layout.cols}, 1fr);
        grid-template-rows: ${gridTemplateRows};
        column-gap: ${FB_POST_COL_GAP}px;
        row-gap: ${layout.rowGap}px;
      }
      ${tileStyleBlock(theme, { badgeSize: FB_POST_FONTS.badgeSize, nameSize: FB_POST_FONTS.nameSize, priceSize: FB_POST_FONTS.priceSize, tilePad: 12, priceTop: 8, centerPrice: true })}
    </style>`;
}

// Renders the board as real HTML/CSS via an SVG <foreignObject>, then
// rasterizes that to a canvas so it can be exported as a PNG.
async function renderListExportCanvas(items, listType) {
  const { count: gridMax } = loadExportItemCount();
  const W = 390, H = 260, SCALE = 1;

  const slots = items.slice(0, gridMax);
  const images = await Promise.all(slots.map(i => i ? loadItemImageDataUrl(i.id) : null));
  const bodyHtml = buildBoardHtml(slots, images, listType);

  const theme = getExportStyle();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}"><foreignObject width="${W}" height="${H}">${bodyHtml}</foreignObject></svg>`;
  const svgImg = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = theme.swatch;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (svgImg) ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function exportListAsPNG(items, getFilename, btn, selection, listType) {
  if (!items.length) return;
  trackEvent("export_list_image", { list_type: listType, item_count: items.length });

  const gridMax = loadExportItemCount().count;
  const chunks = [];
  for (let i = 0; i < items.length; i += gridMax) {
    chunks.push(items.slice(i, i + gridMax));
  }

  const originalHTML = btn.innerHTML;
  btn.disabled = true;

  try {
    for (let i = 0; i < chunks.length; i++) {
      btn.textContent = chunks.length > 1 ? `Rendering ${i + 1}/${chunks.length}…` : "Rendering…";
      const canvas = await renderListExportCanvas(chunks[i], listType);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = getFilename(i + 1, chunks.length);
      a.click();
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = selection.size === 0;
  }
}

async function exportBuyListAsPNG() {
  const items = loadBuyList().filter(i => buyExportSelection.has(i.id));
  await exportListAsPNG(items, (n) => `Paintboard-Buy-${n}.png`, document.getElementById("export-buy-png-btn"), buyExportSelection, "buy");
}

async function exportSellListAsPNG() {
  const items = loadSellList().filter(i => sellExportSelection.has(i.id));
  await exportListAsPNG(items, (n) => `Paintboard-Sell-${n}.png`, document.getElementById("export-sell-png-btn"), sellExportSelection, "sell");
}

async function renderFacebookExportCanvas(items, listType) {
  const slots = items.slice(0, FB_POST_MAX_ITEMS);
  const layout = fbPostLayout(slots.length);
  const W = layout.width, H = fbPostHeight(layout.rows), SCALE = 1;

  const images = await Promise.all(slots.map(i => i ? loadItemImageDataUrl(i.id) : null));
  const bodyHtml = buildFacebookHtml(slots, images, listType);

  const theme = getExportStyle();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}"><foreignObject width="${W}" height="${H}">${bodyHtml}</foreignObject></svg>`;
  const svgImg = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = theme.swatch;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (svgImg) ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);

  // Watermark in the bottom-right corner of every exported post: logo icon, then the name
  const logoImg = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(LOGO_SVG));
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.font = "bold 17px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const wmText = "Yoworld Price Guide";
  const wmIcon = 22, wmGap = 6;
  const textW = ctx.measureText(wmText).width;
  const iconW = logoImg ? wmIcon + wmGap : 0;
  const wmX = (canvas.width - (iconW + textW)) / 2;
  const wmMid = canvas.height - 14 - wmIcon / 2;
  if (logoImg) ctx.drawImage(logoImg, wmX, wmMid - wmIcon / 2, wmIcon, wmIcon);
  ctx.fillStyle = "#6b7280";
  ctx.fillText(wmText, wmX + iconW, wmMid);
  ctx.restore();
  return canvas;
}

async function exportListAsFacebookPNG(items, getFilename, btn, selection, listType) {
  if (!items.length) return;
  trackEvent("export_facebook_image", { list_type: listType, item_count: items.length });

  const chunks = [];
  for (let i = 0; i < items.length; i += FB_POST_MAX_ITEMS) {
    chunks.push(items.slice(i, i + FB_POST_MAX_ITEMS));
  }

  const originalHTML = btn.innerHTML;
  btn.disabled = true;

  try {
    for (let i = 0; i < chunks.length; i++) {
      btn.textContent = chunks.length > 1 ? `Rendering ${i + 1}/${chunks.length}…` : "Rendering…";
      const canvas = await renderFacebookExportCanvas(chunks[i], listType);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = getFilename(i + 1, chunks.length);
      a.click();
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = selection.size === 0;
  }
}

async function exportBuyListAsFacebook() {
  const items = loadBuyList().filter(i => buyExportSelection.has(i.id));
  await exportListAsFacebookPNG(items, (n) => `FB-Buy-${n}.png`, document.getElementById("export-buy-png-btn"), buyExportSelection, "buy");
}

async function exportSellListAsFacebook() {
  const items = loadSellList().filter(i => sellExportSelection.has(i.id));
  await exportListAsFacebookPNG(items, (n) => `FB-Sell-${n}.png`, document.getElementById("export-sell-png-btn"), sellExportSelection, "sell");
}

// ── Paintboard UI sync ──────────────────────────────────────────
function renderExportControls(listType, filtered) {
  const sel = exportSelectionFor(listType);
  const exportBtn = document.getElementById(`export-${listType}-png-btn`);
  const exportStatus = document.getElementById(`export-${listType}-status`);
  const selectAllCheckbox = document.getElementById(`select-all-${listType}-checkbox`);
  if (exportBtn) exportBtn.disabled = sel.size === 0;
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = filtered.length > 0 && filtered.every(i => sel.has(i.id));
  }
  if (exportStatus) {
    if (sel.size) {
      const perPage = paintboardMode[listType] === "facebook" ? FB_POST_MAX_ITEMS : loadExportItemCount().count;
      const pngCount = Math.ceil(sel.size / perPage);
      exportStatus.textContent = `${sel.size} selected · exports as ${pngCount} PNG${pngCount > 1 ? "s" : ""}`;
    } else {
      exportStatus.textContent = "Select items to export";
    }
  }
}

// Live mini-preview of the export board, using the exact same buildBoardHtml()
// as the real export — so themes/fonts/badge-visibility/per-item swatch
// colors all show up here exactly as they will in the downloaded PNG.
async function renderExportPreview(listType) {
  const frame = document.getElementById(`export-preview-${listType}`);
  const wrap = frame ? frame.closest(".export-preview-wrap") : null;
  const emptyEl = document.getElementById(`export-preview-empty-${listType}`);
  const moreEl = document.getElementById(`export-preview-more-${listType}`);
  if (!frame) return;

  const sel = exportSelectionFor(listType);
  const list = listType === "buy" ? loadBuyList() : loadSellList();
  const selected = list.filter(i => sel.has(i.id));

  if (!selected.length) {
    frame.style.visibility = "hidden";
    if (emptyEl) emptyEl.hidden = false;
    if (moreEl) moreEl.hidden = true;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  frame.style.visibility = "visible";

  const isFacebook = paintboardMode[listType] === "facebook";
  const gridMax = isFacebook ? FB_POST_MAX_ITEMS : loadExportItemCount().count;
  const slots = selected.slice(0, gridMax);
  const fbLayout = isFacebook ? fbPostLayout(slots.length) : null;
  const W = isFacebook ? fbLayout.width : 390;
  const H = isFacebook ? fbPostHeight(fbLayout.rows) : 260;
  const images = await Promise.all(slots.map(i => i ? loadItemImageDataUrl(i.id) : null));
  const bodyHtml = isFacebook ? buildFacebookPreviewHtml(slots, images, listType) : buildBoardHtml(slots, images, listType);
  frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0">${bodyHtml}</body></html>`;

  const previewW = 234;
  const scale = previewW / W;
  if (wrap) { wrap.style.width = `${previewW}px`; wrap.style.height = `${Math.round(H * scale)}px`; }
  frame.style.width = `${W}px`;
  frame.style.height = `${H}px`;
  frame.style.transform = `scale(${scale})`;

  const extraBoards = Math.ceil(selected.length / gridMax) - 1;
  if (moreEl) {
    moreEl.hidden = extraBoards <= 0;
    moreEl.textContent = extraBoards > 0 ? `+${extraBoards} more board${extraBoards > 1 ? "s" : ""}` : "";
  }
}

// Theme/font/item-count are shared, global export settings — but the
// picker controls are duplicated on both the Buy and Sell tabs, so keep
// both copies of the UI in sync with whichever one was last changed.
function syncSwatchPicker(listType, idPrefix, title, options, current, action, dataKey, tintButton = true, customKind = null) {
  const btn = document.getElementById(`${idPrefix}-btn-${listType}`);
  if (btn && tintButton) btn.style.background = current.swatch;
  const menu = document.getElementById(`${idPrefix}-menu-${listType}`);
  if (menu) {
    const allOptions = customKind
      ? [...options, { key: "custom", label: "Custom", swatch: loadCustomHex(customKind) }]
      : options;
    // The custom colour picker goes at the top so it's visible without scrolling the list
    menu.innerHTML = `
      <div class="bg-picker-menu-title">${title}</div>
      ${customKind ? customColourHtml(customKind, current.key === "custom") : ""}
      ${allOptions.map(o => `
        <button class="bg-swatch-option ${current.key === o.key ? "active" : ""}" data-action="${action}" data-${dataKey}="${o.key}">
          <span class="bg-swatch-dot" style="background:${o.swatch}"></span>
          <span class="bg-swatch-label">${o.label}</span>
        </button>
      `).join("")}
    `;
  }
}

function customColourHtml(kind, isActive = false) {
  const hex = loadCustomHex(kind);
  return `
    <div class="custom-colour ${isActive ? "active" : ""}">
      <div class="custom-colour-title">Custom colour</div>
      <div class="custom-colour-row">
        <input type="color" class="custom-colour-picker" data-action="set-custom-colour" data-kind="${kind}" value="${hex}">
        <input type="text" class="custom-colour-hex" maxlength="7" data-action="set-custom-hex" data-kind="${kind}" placeholder="#RRGGBB" value="${hex}">
      </div>
    </div>`;
}

// The Paintboard button opens and closes the sidebar, keeping the chosen format
function togglePaintboardMode(listType) {
  paintboardMode[listType] = paintboardMode[listType] ? null : paintboardFormat[listType];
  renderAll();
}

// Collapsed panel: icons for each editing tool. Clicking one opens the panel.
function buildPaintboardRail(listType) {
  const bar = document.getElementById(`paintboard-bar-${listType}`);
  if (!bar || bar.querySelector(".paintboard-rail-tools")) return;
  const rail = document.createElement("div");
  rail.className = "paintboard-rail-tools";
  bar.querySelectorAll(".bg-picker > button").forEach(btn => {
    const tool = document.createElement("button");
    tool.className = "paintboard-rail-tool";
    tool.dataset.action = `toggle-paintboard-${listType}`;
    tool.title = btn.title;
    tool.innerHTML = btn.innerHTML;
    rail.appendChild(tool);
  });
  bar.querySelector(".paintboard-expand-btn").after(rail);
}

function closePaintboardMode(listType) {
  paintboardMode[listType] = null;
  renderAll();
}

function syncPaintboardMode(listType) {
  const mode = paintboardMode[listType];
  const active = mode !== null;
  const panel = document.getElementById(`paintboard-preview-panel-${listType}`);
  const bar = document.getElementById(`paintboard-bar-${listType}`);
  const tab = document.getElementById(`tab-${listType}`);
  const exportLabel = document.getElementById(`export-${listType}-label`);
  if (panel) panel.classList.toggle("hidden", !active);
  if (bar) bar.classList.toggle("collapsed", !active);
  // FB posts set their own item count, so the per-board count doesn't apply
  const countPicker = document.getElementById(`export-count-picker-${listType}`);
  if (countPicker) countPicker.classList.toggle("hidden", mode === "facebook");
  // The title only appears on FB posts, so it is hidden for the Paintboard
  const titleField = document.getElementById(`export-title-input-${listType}`)?.closest(".export-title-field");
  if (titleField) titleField.classList.toggle("hidden", mode !== "facebook");
  const formatRadio = document.querySelector(`input[name="export-format-${listType}"][value="${mode}"]`);
  if (formatRadio) formatRadio.checked = true;
  if (tab) tab.classList.toggle("paintboard-active", active);
  const generateBtn = document.getElementById(`generate-paintboards-${listType}`);
  if (generateBtn) generateBtn.classList.toggle("hidden", active);
  if (exportLabel) exportLabel.textContent = "Export";
}

// Each editing tool is a labelled row showing its current value
function updateToolRows(listType) {
  // Colour rows show the current colour as a circle at the start
  const rows = [
    ["bulk-card-bg-btn", "Card backgrounds", "", null],
    ["export-background-btn", "Background", loadExportBackground().label, loadExportBackground().swatch],
    ["export-badge-color-btn", "Text colour", loadExportBadgeColor().label, loadExportBadgeColor().swatch],
    ["export-effect-btn", "Glow", loadExportCardEffect().label, loadExportCardEffect().swatch],
    ["export-border-btn", "Border", loadExportBorder().label, null],
    ["export-font-btn", "Font", loadExportFont().label, null],
    ["export-count-btn", "Items per board", String(loadExportItemCount().count), null],
    ["export-settings-btn", "Options", "", null],
  ];
  for (const [id, label, value, swatch] of rows) {
    const btn = document.getElementById(`${id}-${listType}`);
    if (!btn) continue;
    btn.classList.add("tool-row-btn");
    const dot = swatch
      ? `<span class="bg-swatch-dot" data-color="${swatch}" ${swatch === "transparent" ? "" : `style="background:${swatch}"`}></span>`
      : "";
    btn.innerHTML = `${dot}<span class="tool-row-label">${label}</span>${value ? `<span class="tool-row-value">${escapeHtml(value)}</span>` : ""}<span class="tool-row-chevron">›</span>`;
  }
}

function syncExportPickers(listType) {
  syncSwatchPicker(listType, "export-background", "Background", EXPORT_BACKGROUNDS, loadExportBackground(), "set-export-background", "background", false, "background");
  syncSwatchPicker(listType, "export-badge-color", "Badge Colour", EXPORT_BADGE_COLORS, loadExportBadgeColor(), "set-export-badge-color", "badgecolor", false, "badgecolor");
  syncSwatchPicker(listType, "export-effect", "Glow", EXPORT_CARD_EFFECTS, loadExportCardEffect(), "set-export-effect", "effect", false, "effect");

  const exportBorder = loadExportBorder();
  const borderMenu = document.getElementById(`export-border-menu-${listType}`);
  if (borderMenu) {
    borderMenu.innerHTML = `
      <div class="bg-picker-menu-title">Border</div>
      ${EXPORT_BORDER_OPTIONS.map(o => `
        <button class="bg-swatch-option ${exportBorder.key === o.key ? "active" : ""}" data-action="set-export-border" data-border="${o.key}">
          <span class="bg-swatch-dot" style="background:var(--surface);border-radius:${o.hasBorder ? o.radius + 4 : 4}px;${o.hasBorder ? "" : "border:none;"}"></span>
          <span class="bg-swatch-label">${o.label}</span>
        </button>
      `).join("")}
    `;
  }

  const exportFont = loadExportFont();
  const fontMenu = document.getElementById(`export-font-menu-${listType}`);
  if (fontMenu) {
    fontMenu.innerHTML = EXPORT_FONTS.map(f => `
      <button class="font-option ${exportFont.key === f.key ? "active" : ""}" data-action="set-export-font" data-font="${f.key}" style="font-family:${f.family}">${f.label}</button>
    `).join("");
  }

  const exportCount = loadExportItemCount();
  const countBtn = document.getElementById(`export-count-btn-${listType}`);
  const countMenu = document.getElementById(`export-count-menu-${listType}`);
  if (countMenu) {
    countMenu.innerHTML = EXPORT_COUNT_OPTIONS.map(o => `
      <button class="font-option ${exportCount.count === o.count ? "active" : ""}" data-action="set-export-count" data-count="${o.count}">${o.count} items</button>
    `).join("");
  }

  const titleInput = document.getElementById(`export-title-input-${listType}`);
  if (titleInput && document.activeElement !== titleInput) titleInput.value = getExportTitle(listType);

  const showBadgeCheckbox = document.getElementById(`export-show-badge-${listType}`);
  if (showBadgeCheckbox) showBadgeCheckbox.checked = loadExportShowBadge();

  const bulkCardBgMenu = document.getElementById(`bulk-card-bg-menu-${listType}`);
  if (bulkCardBgMenu) {
    bulkCardBgMenu.innerHTML = `
      <div class="bg-picker-menu-title">Card Backgrounds</div>
      ${CARD_BG_OPTIONS.map(o => `
        <button class="bg-swatch-option" data-action="bulk-set-${listType}-card-bg" data-color="${o.value}">
          <span class="bg-swatch-dot" data-color="${o.value}" style="background:${o.value}"></span>
          <span class="bg-swatch-label">${o.label}</span>
        </button>
      `).join("")}
    `;
  }

  updateToolRows(listType);
}

// ── Render ─────────────────────────────────────────────────────
function renderAll() {
  const buyList  = loadBuyList();
  const sellList = loadSellList();

  document.getElementById("buy-count").textContent = buyList.length;
  document.getElementById("header-buy-count").textContent = buyList.length;
  document.getElementById("header-buy-count").classList.toggle("hidden", buyList.length === 0);
  document.getElementById("buy-price-summary").innerHTML = buildListPriceSummary(buyList);

  selectNewExportItems("buy", buyList);
  pruneExportSelection("buy", buyList);
  renderExportControls("buy", getFilteredList("buy"));
  syncExportPickers("buy");
  renderExportPreview("buy");
  syncPaintboardMode("buy");

  const filteredBuy = getFilteredList("buy");
  if (!filteredBuy.length) {
    document.getElementById("buy-cards").innerHTML = `<div class="empty">${hasActiveFilter("buy") ? "No items match your filters." : "No items in your buy list. Search for items to add them."}</div>`;
    renderPagination(["buy-pagination-top", "buy-pagination"], "buy-prev", "buy-next", 1, 0);
  } else {
    const buyPageSize = listPageSize("buy");
    const totalBuyPages = Math.max(1, Math.ceil(filteredBuy.length / buyPageSize));
    if (buyPage > totalBuyPages) buyPage = totalBuyPages;
    const buyStart = (buyPage - 1) * buyPageSize;
    document.getElementById("buy-cards").innerHTML = filteredBuy.slice(buyStart, buyStart + buyPageSize).map(item => listGridCard(item, "buy")).join("");
    renderPagination(["buy-pagination-top", "buy-pagination"], "buy-prev", "buy-next", buyPage, filteredBuy.length, buyPageSize);
  }

  document.getElementById("sell-count").textContent = sellList.length;
  document.getElementById("header-sell-count").textContent = sellList.length;
  document.getElementById("header-sell-count").classList.toggle("hidden", sellList.length === 0);
  document.getElementById("sell-price-summary").innerHTML = buildListPriceSummary(sellList);

  selectNewExportItems("sell", sellList);
  pruneExportSelection("sell", sellList);
  renderExportControls("sell", getFilteredList("sell"));
  syncExportPickers("sell");
  renderExportPreview("sell");
  syncPaintboardMode("sell");

  const filteredSell = getFilteredList("sell");
  if (!filteredSell.length) {
    document.getElementById("sell-cards").innerHTML = `<div class="empty">${hasActiveFilter("sell") ? "No items match your filters." : "No items in your sell list. Search for items to add them."}</div>`;
    renderPagination(["sell-pagination-top", "sell-pagination"], "sell-prev", "sell-next", 1, 0);
  } else {
    const sellPageSize = listPageSize("sell");
    const totalSellPages = Math.max(1, Math.ceil(filteredSell.length / sellPageSize));
    if (sellPage > totalSellPages) sellPage = totalSellPages;
    const sellStart = (sellPage - 1) * sellPageSize;
    document.getElementById("sell-cards").innerHTML = filteredSell.slice(sellStart, sellStart + sellPageSize).map(item => listGridCard(item, "sell")).join("");
    renderPagination(["sell-pagination-top", "sell-pagination"], "sell-prev", "sell-next", sellPage, filteredSell.length, sellPageSize);
  }

  // Re-render search results to update watch button states
  const resultsEl = document.getElementById("search-results");
  if (resultsEl && Object.keys(searchResultsMap).length) {
    renderSearchCards(resultsEl, Object.values(searchResultsMap));
  }

}

// Updates the search grid in place: only cards whose markup changed are replaced,
// so clicking Buy/Sell doesn't rebuild the whole list and make it jump.
function renderSearchCards(resultsEl, items) {
  const html = items.map(searchResultCard);
  const cards = [...resultsEl.children];
  const sameShape = cards.length === items.length && cards.every(el => el.classList.contains("search-tile-card"));
  if (!sameShape) {
    resultsEl.innerHTML = html.join("");
    [...resultsEl.children].forEach((el, i) => { el._renderedHtml = html[i]; });
    return;
  }
  cards.forEach((el, i) => {
    if (el._renderedHtml === html[i]) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = html[i].trim();
    const card = tpl.content.firstElementChild;
    card._renderedHtml = html[i];
    el.replaceWith(card);
  });
}

// ── Search ─────────────────────────────────────────────────────
let currentQuery = "";
let currentPage = 1;
let totalPages = 1;

const CATEGORY_ID_MAP = {
  "Hair":        1003,
  "Eyes":        1001,
  "Face & Skin": 1000,  // Skin sub-category (closest match)
  "Dresses":     104,
  "Tops":        101,   // Shirts; does not include Jackets (2024) or Swimwear (2020)
  "Bottoms":     100,   // Pants; does not include Shorts (102) or Skirts (103)
  "Costumes":    2025,
  "Footwear":    105,
  "Bags":        2045,  // Handhelds (closest match)
  "Hats":        2028,
  "Accessories": 2,     // parent category
  "Furniture":   5,     // parent category
  "Pets":        2040,
  "Food":        6,     // parent category
  "Mouth":       1002,
};

let searchTotalItems = 0;
let searchStatusFilter = "all"; // "all" | "instore" | "discontinued"
const SEARCH_PAGE_SIZE = 40;

// Searches the Supabase prices table by item name.
// Each word must appear somewhere in the name, in any order (so "latte hair" matches "Hair Latte").
async function fetchSearchPage(query, page) {
  const words = query
    .replace(/[*%_\\]/g, "") // keep wildcard characters out of the user's text
    .split(/\s+/)
    .filter(Boolean);
  const params = new URLSearchParams({
    select: "item_id,item_name",
    // item_id breaks ties between items with the same name, so pages don't overlap
    order: "item_name.asc,item_id.asc",
    limit: String(SEARCH_PAGE_SIZE),
    offset: String((page - 1) * SEARCH_PAGE_SIZE),
  });
  // Repeated item_name params are ANDed by PostgREST, so every word has to match
  for (const word of words) params.append("item_name", `ilike.*${word}*`);
  // Discontinued means not active in store, which includes rows with no status yet
  if (searchStatusFilter === "instore") params.append("active_in_store", "eq.true");
  if (searchStatusFilter === "discontinued") params.append("or", "(active_in_store.eq.false,active_in_store.is.null)");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/prices?${params}`, {
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Prefer": "count=exact",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  // Content-Range looks like "0-39/1292"; the part after the slash is the total match count
  const total = Number(res.headers.get("content-range")?.split("/")[1]);
  const seen = new Set();
  const items = rows
    .filter(row => (seen.has(row.item_id) ? false : seen.add(row.item_id)))
    .map(row => ({
      id: Number(row.item_id),
      name: row.item_name ?? "",
      activeInStore: false,
    }));
  return { items, total: Number.isFinite(total) ? total : null };
}

async function doSearch(query, page = 1) {
  const resultsEl = document.getElementById("search-results");
  searchResultsMap = {};

  if (!query.trim()) {
    resultsEl.innerHTML = "";
    document.getElementById("pagination-top").innerHTML = "";
    document.getElementById("pagination").innerHTML = "";
    currentQuery = "";
    return;
  }

  currentQuery = query;
  currentPage = page;
  resultsEl.innerHTML = `<div class="empty">Searching…</div>`;

  try {
    const { items, total } = await fetchSearchPage(query, page);
    if (total !== null) searchTotalItems = total;
    totalPages = Math.max(1, Math.ceil(searchTotalItems / SEARCH_PAGE_SIZE));
    if (page === 1) trackEvent("search", { search_term: query, result_count: items.length });

    if (!items.length) {
      resultsEl.innerHTML = `<div class="empty">No items found for "${query}".</div>`;
      document.getElementById("pagination-top").innerHTML = "";
      document.getElementById("pagination").innerHTML = "";
      return;
    }

    items.forEach(item => { searchResultsMap[item.id] = item; });
    renderSearchCards(resultsEl, items);
    renderSearchPagination();

    // Refresh prices for visible items from Supabase in the background
    const pageIds = items.map(i => String(i.id));
    fetchSupabasePrices(pageIds).then(prices => {
      if (!Object.keys(prices).length) return;
      const history = loadPriceHistory();
      const today = new Date().toISOString().split("T")[0];
      let changed = false;
      for (const [idStr, p] of Object.entries(prices)) {
        if (!history[idStr]) {
          const item = searchResultsMap[Number(idStr)];
          if (!item) continue;
          history[idStr] = { id: Number(idStr), name: item.name, pricechecks: [], supabasePrices: [] };
          changed = true;
        }
        const prev = (history[idStr].supabasePrices ?? []).at(-1);
        if (prev?.min === p.min && prev?.max === p.max) continue;
        history[idStr].supabasePrices = [...(history[idStr].supabasePrices ?? []), { min: p.min, max: p.max, date: today }];
        changed = true;
      }
      if (changed) {
        savePriceHistory(history);
        renderSearchCards(resultsEl, items);
      }
    });
  } catch (e) {
    console.error("[Search] error:", e);
    resultsEl.innerHTML = `<div class="empty">Search failed. Check your connection.</div>`;
  }
}

function renderSearchPagination() {
  const html = totalPages <= 1 ? "" : `
    <button class="page-btn" data-action="prev" ${currentPage === 1 ? "disabled" : ""}>‹</button>
    <span class="page-info">Page ${currentPage} of ${totalPages}</span>
    <button class="page-btn" data-action="next" ${currentPage === totalPages ? "disabled" : ""}>›</button>
  `;
  document.getElementById("pagination-top").innerHTML = html;
  document.getElementById("pagination").innerHTML = html;
}

// Hide broken item images
document.addEventListener("error", (e) => {
  if (e.target.classList.contains("item-thumb")) e.target.style.display = "none";
}, true);

// ── Event delegation (no inline handlers) ─────────────────────
document.addEventListener("click", (e) => {
  if (!e.target.closest(".bg-picker")) {
    document.querySelectorAll(".bg-picker-menu:not(.hidden)").forEach(m => m.classList.add("hidden"));
  }

  // Open detail page when clicking a card (not a button inside it)
  if (!e.target.closest("[data-action]") && !e.target.closest("button")) {
    const card = e.target.closest("[data-detail-id]");
    if (card) {
      const cardId = card.dataset.detailId;
      requestPriceIfMissing(cardId, searchResultsMap[cardId]?.name ?? loadPriceHistory()[cardId]?.name ?? null);
      openDetail(cardId);
      return;
    }
  }

  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  if (btn.dataset.action === "toggle-bg-picker") {
    const menu = btn.nextElementSibling;
    const wasOpen = menu && !menu.classList.contains("hidden");
    document.querySelectorAll(".bg-picker-menu").forEach(m => m.classList.add("hidden"));
    if (menu && !wasOpen) menu.classList.remove("hidden");
    return;
  }

  if (btn.dataset.action === "toggle-export-buy") { toggleExportSelection("buy", Number(btn.dataset.id)); return; }
  if (btn.dataset.action === "toggle-export-sell") { toggleExportSelection("sell", Number(btn.dataset.id)); return; }
  if (btn.dataset.action === "set-buy-bg")  setItemBg("buy", Number(btn.dataset.id), btn.dataset.color);
  if (btn.dataset.action === "set-sell-bg") setItemBg("sell", Number(btn.dataset.id), btn.dataset.color);
  if (btn.dataset.action === "bulk-set-buy-card-bg")  bulkSetCardBg("buy", btn.dataset.color);
  if (btn.dataset.action === "bulk-set-sell-card-bg")  bulkSetCardBg("sell", btn.dataset.color);
  if (btn.dataset.action === "export-buy-png")  { if (paintboardMode.buy === "facebook") exportBuyListAsFacebook(); else exportBuyListAsPNG(); }
  if (btn.dataset.action === "export-sell-png") { if (paintboardMode.sell === "facebook") exportSellListAsFacebook(); else exportSellListAsPNG(); }
  if (btn.dataset.action === "toggle-paintboard-buy")  togglePaintboardMode("buy");
  if (btn.dataset.action === "toggle-paintboard-sell") togglePaintboardMode("sell");
  if (btn.dataset.action === "close-paintboard-buy")  closePaintboardMode("buy");
  if (btn.dataset.action === "close-paintboard-sell") closePaintboardMode("sell");
  if (btn.dataset.action === "select-all-buy") { toggleSelectAll("buy"); return; }
  if (btn.dataset.action === "select-all-sell") { toggleSelectAll("sell"); return; }
  if (btn.dataset.action === "set-export-background") setExportBackground(btn.dataset.background);
  if (btn.dataset.action === "set-export-badge-color") setExportBadgeColor(btn.dataset.badgecolor);
  if (btn.dataset.action === "set-export-effect") setExportCardEffect(btn.dataset.effect);
  if (btn.dataset.action === "set-export-border") setExportBorder(btn.dataset.border);
  if (btn.dataset.action === "set-export-font") setExportFont(btn.dataset.font);
  if (btn.dataset.action === "set-export-count") setExportItemCount(Number(btn.dataset.count));
  if (btn.dataset.action === "set-export-show-badge") setExportShowBadge(btn.checked);

  if (btn.dataset.action === "dismiss-submit-reminder") {
    localStorage.setItem("submitReminderDismissedDate", new Date().toISOString().split("T")[0]);
    renderSubmitReminderBanner();
    return;
  }

  if (btn.dataset.action === "submit-all-pending") {
    btn.disabled = true;
    btn.textContent = "Submitting…";
    (async () => {
      const pending = getUnsubmittedPriceLogs();
      const history = loadPriceHistory();
      for (const { itemId, index, price, date } of pending) {
        const result = await submitPriceLog(itemId, price, date);
        if (result.ok) {
          if (history[itemId]?.pricechecks?.[index]) {
            history[itemId].pricechecks[index].communityStatus = "submitted";
          }
        } else if (result.alreadySubmitted) {
          submitBlockedToday.set(`pc_${itemId}_${index}`, true);
        }
      }
      savePriceHistory(history);
      renderSubmitReminderBanner();
      renderDetailLog();
      renderAll();
    })();
    return;
  }

  if (btn.dataset.action === "info-accordion") {
    const body = btn.nextElementSibling;
    const chevron = btn.querySelector(".acc-chevron");
    const isOpen = body.classList.contains("open");
    body.classList.toggle("open", !isOpen);
    chevron.classList.toggle("open", !isOpen);
    btn.setAttribute("aria-expanded", String(!isOpen));
    return;
  }

  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "remove-buy") {
    removeFromBuyList(id);
    (async () => {
      await setItemState(id, "none");
      const uid = await getOrCreateUserId();
      await callToggleItemState(uid, id, "none");
      await updateCountsCacheOnToggle(id, "buy", "none");
    })();
  }
  if (btn.dataset.action === "remove-sell") {
    removeFromSellList(id);
    (async () => {
      await setItemState(id, "none");
      const uid = await getOrCreateUserId();
      await callToggleItemState(uid, id, "none");
      await updateCountsCacheOnToggle(id, "sell", "none");
    })();
  }
  if (btn.dataset.action === "watch-buy") {
    requestPriceIfMissing(id, searchResultsMap[id]?.name ?? null);
    if (searchResultsMap[id]) (async () => {
      btn.disabled = true;
      try {
        const prevState = await getItemState(id);
        const ns = await handleItemToggle(id, true);
        const uid = await getOrCreateUserId();
        await callToggleItemState(uid, id, ns);
        if (currentDetailId === String(id)) {
          const counts = await updateCountsCacheOnToggle(id, prevState, ns);
          if (counts) {
            updateDetailCounters(counts.buyCount, counts.sellCount);
          } else {
            const { buyCount, sellCount } = await fetchItemCounts(id);
            updateDetailCounters(buyCount, sellCount);
          }
        }
      } finally {
        btn.disabled = false;
      }
    })();
  }
  if (btn.dataset.action === "watch-sell") {
    requestPriceIfMissing(id, searchResultsMap[id]?.name ?? null);
    if (searchResultsMap[id]) (async () => {
      btn.disabled = true;
      try {
        const prevState = await getItemState(id);
        const ns = await handleItemToggle(id, false);
        const uid = await getOrCreateUserId();
        await callToggleItemState(uid, id, ns);
        if (currentDetailId === String(id)) {
          const counts = await updateCountsCacheOnToggle(id, prevState, ns);
          if (counts) {
            updateDetailCounters(counts.buyCount, counts.sellCount);
          } else {
            const { buyCount, sellCount } = await fetchItemCounts(id);
            updateDetailCounters(buyCount, sellCount);
          }
        }
      } finally {
        btn.disabled = false;
      }
    })();
  }
  if (btn.dataset.action === "detail-watch-buy" || btn.dataset.action === "detail-watch-sell") {
    const numId = Number(id);
    const isBuy = btn.dataset.action === "detail-watch-buy";
    requestPriceIfMissing(numId, currentDetailName);
    btn.disabled = true;
    (async () => {
      try {
        const prevState = await getItemState(numId);
        const newState = await handleItemToggle(numId, isBuy);
        const userId = await getOrCreateUserId();
        await callToggleItemState(userId, numId, newState);
        if (currentDetailId === String(numId)) {
          updateDetailButtons(numId, newState);
          const counts = await updateCountsCacheOnToggle(numId, prevState, newState);
          if (counts) {
            updateDetailCounters(counts.buyCount, counts.sellCount);
          } else {
            const { buyCount, sellCount } = await fetchItemCounts(numId);
            updateDetailCounters(buyCount, sellCount);
          }
        }
      } finally {
        btn.disabled = false;
      }
    })();
    return;
  }
  if (btn.dataset.action === "search-status") {
    searchStatusFilter = btn.dataset.status;
    document.querySelectorAll(".segmented-opt").forEach(b => b.classList.toggle("active", b === btn));
    if (currentQuery) doSearch(currentQuery, 1);
    return;
  }
  if (btn.dataset.action === "prev") doSearch(currentQuery, currentPage - 1);
  if (btn.dataset.action === "next") doSearch(currentQuery, currentPage + 1);
  if (btn.dataset.action === "buy-prev")  { buyPage--;  renderAll(); }
  if (btn.dataset.action === "buy-next")  { buyPage++;  renderAll(); }
  if (btn.dataset.action === "sell-prev") { sellPage--; renderAll(); }
  if (btn.dataset.action === "sell-next") { sellPage++; renderAll(); }

  if (btn.dataset.action === "open-detail-log") {
    const form = document.getElementById("detail-log-form");
    if (form) form.style.display = form.style.display === "none" ? "block" : "none";
  }

  if (btn.dataset.action === "request-price") {
    const itemId = btn.dataset.id;
    btn.disabled = true;
    btn.textContent = "…";
    (async () => {
      const ok = await requestPriceCheck(itemId, currentDetailName);
      if (ok) {
        await setRequestedFlag(itemId, currentDetailName);
        btn.textContent = "Requested ✓";
      } else {
        btn.textContent = "Request failed";
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = "Request price";
        }, 1500);
      }
    })();
  }

  if (btn.dataset.action === "save-detail-pc") {
    const price    = document.getElementById("detail-pc-price")?.value;
    const note     = document.getElementById("detail-pc-note")?.value.trim() ?? "";
    const date     = document.getElementById("detail-pc-date")?.value;
    const currency = 1;
    if (price && date && currentDetailId) {
      const itemId = currentDetailId;
      const history = loadPriceHistory();
      if (!history[itemId]) {
        const watchItem = [...loadBuyList(), ...loadSellList()].find(i => String(i.id) === String(itemId));
        const searchItem = searchResultsMap[itemId];
        const name = (watchItem?.name ?? searchItem?.name ?? currentDetailName) || "Item";
        history[itemId] = { id: Number(itemId), name, pricechecks: [] };
      }
      const index = history[itemId].pricechecks.push({ price: Number(price), currency, date, note }) - 1;
      savePriceHistory(history);
      document.getElementById("detail-log-form").style.display = "none";
      renderDetailLog();
      refreshDetailStats();
      renderAll();

      // Auto-submit the newly logged price to the community, if enabled
      if (isAutoSubmitEnabled()) {
        (async () => {
          const result = await submitPriceLog(itemId, Number(price), date);
          const h = loadPriceHistory();
          if (h[itemId]?.pricechecks?.[index]) {
            if (result.ok) {
              h[itemId].pricechecks[index].communityStatus = "submitted";
              savePriceHistory(h);
            } else if (result.alreadySubmitted) {
              submitBlockedToday.set(`pc_${itemId}_${index}`, true);
            }
          }
          renderDetailLog();
          renderSubmitReminderBanner();
          renderAll();
        })();
      }
    }
  }

  if (btn.dataset.action === "detail-del-ask") {
    const row = Number(btn.dataset.row);
    document.querySelectorAll(".log-confirm").forEach(c => c.style.display = "none");
    document.querySelectorAll(".log-edit-form").forEach(f => f.style.display = "none");
    const confirm = document.getElementById(`detail-log-confirm-${row}`);
    if (confirm) confirm.style.display = "flex";
  }

  if (btn.dataset.action === "detail-del-cancel") {
    const confirm = document.getElementById(`detail-log-confirm-${btn.dataset.row}`);
    if (confirm) confirm.style.display = "none";
  }

  if (btn.dataset.action === "detail-edit-open") {
    const row = Number(btn.dataset.row);
    document.querySelectorAll(".log-confirm").forEach(c => c.style.display = "none");
    document.querySelectorAll(".log-edit-form").forEach(f => f.style.display = "none");
    const form = document.getElementById(`detail-log-edit-${row}`);
    if (form) form.style.display = "flex";
  }

  if (btn.dataset.action === "detail-edit-cancel") {
    const form = document.getElementById(`detail-log-edit-${btn.dataset.row}`);
    if (form) form.style.display = "none";
  }

  if (btn.dataset.action === "detail-edit-save") {
    const itemId = btn.dataset.id;
    const index = Number(btn.dataset.index);
    const row = Number(btn.dataset.row);
    const newPrice = Number(document.getElementById(`detail-edit-price-${row}`)?.value);
    const newNote = document.getElementById(`detail-edit-note-${row}`)?.value.trim() ?? "";
    if (!newPrice) return;
    const h = loadPriceHistory();
    if (h[itemId]?.pricechecks?.[index]) {
      h[itemId].pricechecks[index].price = newPrice;
      h[itemId].pricechecks[index].note = newNote;
      savePriceHistory(h);
    }
    renderDetailLog();
    refreshDetailStats();
    renderAll();
  }

  if (btn.dataset.action === "detail-del-confirm") {
    removePricecheck(btn.dataset.id, Number(btn.dataset.index));
    renderDetailLog();
    refreshDetailStats();
    renderAll();
  }

  if (btn.dataset.action === "submit-pricecheck") {
    const itemId = btn.dataset.id;
    const index = Number(btn.dataset.index);
    btn.disabled = true;
    btn.textContent = "…";
    (async () => {
      const h = loadPriceHistory();
      const pc = h[itemId]?.pricechecks?.[index];
      if (!pc) { renderDetailLog(); return; }
      const result = await submitPriceLog(itemId, pc.price, pc.date);
      if (result.ok) {
        h[itemId].pricechecks[index].communityStatus = "submitted";
        savePriceHistory(h);
        submitBlockedToday.delete(`pc_${itemId}_${index}`);
      } else if (result.alreadySubmitted) {
        submitBlockedToday.set(`pc_${itemId}_${index}`, true);
      }
      renderDetailLog();
      renderSubmitReminderBanner();
      renderAll();
    })();
  }

  if (btn.dataset.action === "detail-log-prev") { detailLogPage--; renderDetailLog(); }
  if (btn.dataset.action === "detail-log-next") { detailLogPage++; renderDetailLog(); }

});

// ── Tab switching ──────────────────────────────────────────────
// Each tab is its own page; the page's <body data-page> says which tab it shows
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("active");
  document.getElementById(`tab-${tabName}`)?.classList.add("active");
}

switchTab(document.body.dataset.page || "search");

// ── Search input wiring ────────────────────────────────────────

document.getElementById("search-btn").addEventListener("click", () => {
  doSearch(document.getElementById("search-input").value);
});

document.getElementById("search-input").addEventListener("keydown", e => {
  if (e.key === "Enter") doSearch(e.target.value);
});

document.getElementById("buy-search").addEventListener("input", () => { buyPage = 1; renderAll(); });
document.getElementById("buy-category").addEventListener("change", () => { buyPage = 1; renderAll(); });
document.getElementById("sell-search").addEventListener("input", () => { sellPage = 1; renderAll(); });
document.getElementById("sell-category").addEventListener("change", () => { sellPage = 1; renderAll(); });
document.getElementById("buy-category").innerHTML = buildListCategoryOptions();
document.getElementById("sell-category").innerHTML = buildListCategoryOptions();

// ── Detail page navigation ─────────────────────────────────────
function getSparklineEntries(entry, currency) {
  const manualEntries = (entry?.pricechecks ?? [])
    .filter(p => p.currency === currency)
    .map(p => ({ price: p.price, date: p.date, type: "manual" }));
  const communityEntries = currency === 1
    ? detailApprovedLogs
        .map(log => ({ price: log.price, date: log.price_date ?? log.submitted_at.split("T")[0], type: "community" }))
        .filter(e => e.price > 0)
    : [];
  return [...manualEntries, ...communityEntries].sort((a, b) => new Date(a.date) - new Date(b.date));
}

function buildSparkline(entries) {
  const W = 300, H = 72, PAD = 8;

  const legend = `
    <div style="display:flex;gap:16px;margin-top:8px">
      <div style="display:flex;align-items:center;gap:5px">
        <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.5" fill="white" stroke="#1D9E75" stroke-width="2"/></svg>
        <span style="font-size:11px;color:var(--muted)">Manual</span>
      </div>
      <div style="display:flex;align-items:center;gap:5px">
        <svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.5" fill="white" stroke="var(--purple)" stroke-width="2"/></svg>
        <span style="font-size:11px;color:var(--muted)">Community</span>
      </div>
    </div>`;

  if (entries.length === 0) {
    return `
      <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        <line x1="${PAD}" y1="${H / 2}" x2="${W - PAD}" y2="${H / 2}" stroke="var(--border)" stroke-width="1.5" stroke-dasharray="4 4"/>
      </svg>
      <div style="display:flex;justify-content:center;margin-top:4px">
        <span style="font-size:10px;color:var(--muted)">No data yet</span>
      </div>
      ${legend}`;
  }

  const points = [...entries].sort((a, b) => new Date(a.date) - new Date(b.date));

  const formatLabel = dateStr => new Date(dateStr).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  // Index-based x so same-day entries each get their own position
  const x = i => points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - PAD * 2);

  const prices = points.map(p => p.price);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const priceRange = maxP - minP || 1;
  const y = p => H - PAD - ((p - minP) / priceRange) * (H - PAD * 2);

  if (points.length === 1) {
    const cx = W / 2, cy = H / 2;
    const dot = points[0].type === "community"
      ? `<circle cx="${cx}" cy="${cy}" r="4" fill="white" stroke="var(--purple)" stroke-width="2"/>`
      : `<circle cx="${cx}" cy="${cy}" r="4" fill="white" stroke="#1D9E75" stroke-width="2"/>`;
    return `
      <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        <line x1="${PAD}" y1="${cy}" x2="${W - PAD}" y2="${cy}" stroke="#7F77DD" stroke-width="2" opacity="0.2"/>
        ${dot}
      </svg>
      <div style="display:flex;justify-content:center;margin-top:4px">
        <span style="font-size:10px;color:var(--muted)">${formatLabel(points[0].date)}</span>
      </div>
      ${legend}`;
  }

  const pts  = points.map((p, i) => `${x(i)},${y(p.price)}`).join(" ");
  const area = `${x(0)},${H} ${pts} ${x(points.length - 1)},${H}`;

  const dots = points.map((p, i) => p.type === "community"
    ? `<circle cx="${x(i)}" cy="${y(p.price)}" r="4" fill="white" stroke="var(--purple)" stroke-width="2"/>`
    : `<circle cx="${x(i)}" cy="${y(p.price)}" r="4" fill="white" stroke="#1D9E75" stroke-width="2"/>`
  ).join("");

  return `
    <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
      <polyline points="${area}" fill="#7F77DD" fill-opacity="0.07" stroke="none"/>
      <polyline points="${pts}" fill="none" stroke="#7F77DD" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>
    <div style="display:flex;justify-content:space-between;margin-top:4px">
      <span style="font-size:10px;color:var(--muted)">${formatLabel(points[0].date)}</span>
      <span style="font-size:10px;color:var(--muted)">${formatLabel(points.at(-1).date)}</span>
    </div>
    ${legend}`;
}

function renderSparkline() {
  const container = document.getElementById("sparkline-container");
  if (!container || !currentDetailId) return;
  const history = loadPriceHistory();
  const entry = history[currentDetailId];
  const entries = getSparklineEntries(entry, sparklineCurrency);
  container.innerHTML = buildSparkline(entries);
}

function buildUnifiedLog(entry) {
  const manualEntries = (entry?.pricechecks ?? []).map((p, i) => ({
    type: "manual",
    price: p.price,
    currency: p.currency,
    note: p.note ?? "",
    date: p.date,
    index: i,
    communityStatus: p.communityStatus,
  }));
  const communityEntries = detailApprovedLogs.map(log => ({
    type: "community",
    price: log.price,
    date: log.price_date ?? log.submitted_at.split("T")[0],
  }));
  return [...manualEntries, ...communityEntries].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function formatLogDate(dateStr) {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function renderLogEntries(entries, itemId) {
  if (!entries.length) return `<div class="empty" style="padding:16px 0">No price history yet.</div>`;

  const ICON_PERSON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const ICON_PEOPLE  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const ICON_NOTE    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  const ICON_PENCIL  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const ICON_TRASH   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

  return entries.map((e, i) => {
    if (e.type === "community") {
      return `
        <div class="log-row">
          <div class="log-main">
            <div class="log-price">${COIN_ICON} ${formatCoins(e.price)}</div>
            <span class="log-date">${formatLogDate(e.date)}</span>
            <span class="log-pill log-pill-community">${ICON_PEOPLE} Community</span>
          </div>
        </div>`;
    } else {
      const pending = !!e.communityStatus;
      return `
        <div class="log-row" id="detail-log-row-${i}">
          <div class="log-main">
            <div class="log-price">${COIN_ICON} ${formatCoins(e.price)}</div>
            <span class="log-date">${formatLogDate(e.date)}</span>
            <span class="log-pill log-pill-you">${ICON_PERSON} You</span>
            ${pending ? `<span class="log-pill log-pill-submitted">Submitted</span>` : ""}
          </div>
          ${e.note ? `<div class="log-note">${ICON_NOTE} ${e.note}</div>` : ""}
          ${pending ? "" : `
          <div class="log-actions">
            ${(!isAutoSubmitEnabled() || submitBlockedToday.has(`pc_${itemId}_${e.index}`))
              ? `<button class="log-submit-btn" data-action="submit-pricecheck" data-id="${itemId}" data-index="${e.index}">Submit to community</button>`
              : ""}
            <div class="log-action-btns">
              <button class="log-icon-btn" data-action="detail-edit-open" data-id="${itemId}" data-index="${e.index}" data-row="${i}" title="Edit">${ICON_PENCIL}</button>
              <button class="log-icon-btn log-icon-btn--delete" data-action="detail-del-ask" data-id="${itemId}" data-index="${e.index}" data-row="${i}" title="Delete">${ICON_TRASH}</button>
            </div>
            ${submitBlockedToday.has(`pc_${itemId}_${e.index}`) ? `<span class="log-submit-error">You've already submitted a price for this item today.</span>` : ""}
          </div>
          <div class="log-confirm" id="detail-log-confirm-${i}">
            <span>Delete this entry?</span>
            <button data-action="detail-del-confirm" data-id="${itemId}" data-index="${e.index}" data-row="${i}">Delete</button>
            <button data-action="detail-del-cancel" data-row="${i}">Cancel</button>
          </div>
          <div class="log-edit-form" id="detail-log-edit-${i}" style="display:none">
            <input type="number" id="detail-edit-price-${i}" value="${e.price}" placeholder="Price"/>
            <input type="text" id="detail-edit-note-${i}" value="${e.note}" placeholder="Note (optional)…"/>
            <div class="log-edit-actions">
              <button class="pc-save-btn" data-action="detail-edit-save" data-id="${itemId}" data-index="${e.index}" data-row="${i}">Save</button>
              <button class="log-edit-cancel-btn" data-action="detail-edit-cancel" data-row="${i}">Cancel</button>
            </div>
          </div>`}
        </div>`;
    }
  }).join("");
}

function renderDetailLog() {
  if (!currentDetailId) return;
  const entry = loadPriceHistory()[currentDetailId];
  const allEntries = buildUnifiedLog(entry);
  const total = allEntries.length;
  const totalPages = Math.max(1, Math.ceil(total / DETAIL_LOG_PAGE_SIZE));
  if (detailLogPage > totalPages) detailLogPage = totalPages;
  const start = (detailLogPage - 1) * DETAIL_LOG_PAGE_SIZE;

  const listEl = document.getElementById("detail-log-list");
  const pagEl  = document.getElementById("detail-log-pagination");
  if (listEl) listEl.innerHTML = renderLogEntries(allEntries.slice(start, start + DETAIL_LOG_PAGE_SIZE), currentDetailId);
  if (pagEl) {
    if (totalPages <= 1) { pagEl.innerHTML = ""; return; }
    pagEl.innerHTML = `
      <button class="page-btn" data-action="detail-log-prev" ${detailLogPage === 1 ? "disabled" : ""}>‹</button>
      <span class="page-info">${detailLogPage} / ${totalPages}</span>
      <button class="page-btn" data-action="detail-log-next" ${detailLogPage === totalPages ? "disabled" : ""}>›</button>
    `;
  }
}

async function openDetail(itemId, skipRefresh = false, forceRefresh = false) {
  if (forceRefresh) {
    await chrome.storage.local.remove([`approved_logs_${itemId}`, `prices_${itemId}`]);
  }
  currentDetailId = String(itemId);
  detailLogPage = 1;
  if (!skipRefresh) trackEvent("view_item_detail", { item_id: String(itemId) });
  if (!skipRefresh) detailApprovedLogs = [];
  const history  = loadPriceHistory();
  const watchlist = loadWatchlist();
  const entry    = history[itemId];
  const item     = watchlist.find(i => String(i.id) === String(itemId));
  const searchItem = searchResultsMap[itemId];
  const name     = item?.name ?? searchItem?.name ?? entry?.name ?? "Item";
  currentDetailName = name;
  const initialCat = entry?.subCategory ?? item?.subCategory ?? "Loading…";

  // Heal stale "Unknown Item" / "Item" name saved in history
  if (entry && (entry.name === "Unknown Item" || entry.name === "Item") && name !== "Item") {
    history[itemId].name = name;
    savePriceHistory(history);
  }
  const hasApiCategory = !!(entry?.subCategory ?? item?.subCategory);
  const hasStoreStatus = "activeInStore" in (entry ?? {}) || "activeInStore" in (item ?? {});
  const initialInStore = entry?.activeInStore ?? item?.activeInStore ?? searchItem?.activeInStore ?? false;

  const detailPage = document.getElementById("detail-page");

  // Coin range — manual logs + community prices
  const coinRange = computeDetailCoinRange(entry);


  const noData = `<div style="font-size:14px;font-weight:500;color:var(--muted);margin-top:4px">No data</div>`;

  const statTile = (label, icon, value) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${label}</div>
      ${value !== null
        ? `<div style="font-size:15px;font-weight:600;margin:4px 0;display:flex;align-items:center;gap:4px">${icon} ${formatCoins(value)}</div>`
        : noData}
    </div>`;

  const communityState = await getItemState(itemId);
  const communityBuy  = communityState === "buy";
  const communitySell = communityState === "sell";
  const alreadyRequested = await getRequestedFlag(itemId);

  document.getElementById("detail-header-actions").innerHTML = `
    <button class="watch-btn ${communityBuy  ? "watched" : ""}" data-action="detail-watch-buy"  data-id="${itemId}">${communityBuy  ? "✓" : "+"} Buy</button>
    <button class="watch-btn ${communitySell ? "watched" : ""}" data-action="detail-watch-sell" data-id="${itemId}">${communitySell ? "✓" : "+"} Sell</button>
  `;

  document.getElementById("detail-body").innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <div style="width:48px;height:48px;background:var(--surface);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid var(--border)">
        ${thumbImg(itemId, name)}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:15px;line-height:1.3;display:flex;align-items:center;gap:6px" id="detail-item-name">${name} ${storeBadge(initialInStore)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px" id="detail-item-category">Category: ${initialCat}</div>
      </div>
    </div>

    <div id="detail-stats-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
      ${statTile("Coin min", COIN_ICON, coinRange?.min ?? null)}
      ${statTile("Coin max", COIN_ICON, coinRange?.max ?? null)}
    </div>

    <div class="community-counts" id="detail-community-counts">
      <span>Users Buying: <strong>—</strong></span>
      <span>Users Selling: <strong>—</strong></span>
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted)">Price History</span>
      </div>
      <div id="sparkline-container"></div>
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted)">Price Log<span data-tooltip="Track prices of items and optionally submit to community" style="display:flex;align-items:center;cursor:default"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span></span>
        <div style="display:flex;gap:6px" id="detail-request-price-wrap">
          ${renderPriceLogActionButtons(itemId, !!coinRange, alreadyRequested)}
        </div>
      </div>

      <div id="detail-log-form" style="display:none;margin-bottom:12px">
        <div class="search-box" style="margin-bottom:8px">
          <input type="number" id="detail-pc-price" placeholder="Price" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;outline:none;background:var(--surface)"/>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input type="text" id="detail-pc-note" placeholder="Note (optional)…" style="flex:1;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;outline:none;background:var(--surface)"/>
        </div>
        <div style="display:flex;gap:8px">
          <input type="date" id="detail-pc-date" value="${new Date().toISOString().split('T')[0]}" style="flex:1;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;outline:none;background:var(--surface)"/>
          <button class="pc-save-btn" data-action="save-detail-pc">Save</button>
        </div>
      </div>

      <div id="detail-log-list"></div>
      <div id="detail-log-pagination"></div>
    </div>

  `;

  detailPage.classList.remove("hidden");
  requestAnimationFrame(() => {
    detailPage.classList.add("open");
    renderSparkline();
    renderDetailLog();
  });

  // The category always comes from the item's prices row in Supabase. Saved copies
  // are overwritten (or cleared) to match, so an old value never sticks around.
  fetchSupabaseItemCategory(itemId).then(category => {
    if (currentDetailId === String(itemId)) {
      const catEl = document.getElementById("detail-item-category");
      if (catEl) catEl.textContent = `Category: ${category ?? "Uncategorized"}`;
    }
    const applyCategory = entry => {
      if (category) entry.subCategory = category;
      else delete entry.subCategory;
    };
    const h = loadPriceHistory();
    if (h[itemId]) {
      applyCategory(h[itemId]);
      savePriceHistory(h);
    }
    for (const [load, save] of [[loadBuyList, saveBuyList], [loadSellList, saveSellList]]) {
      const list = load();
      const match = list.find(i => String(i.id) === String(itemId));
      if (match) {
        applyCategory(match);
        save(list);
      }
    }
  });

  if (!hasApiCategory || !hasStoreStatus) {
    fetchItemInfo(itemId).then(info => {
      if (!info) return;
      if (info.category) {
        const catEl = document.getElementById("detail-item-category");
        if (catEl) catEl.textContent = `Category: ${info.category}`;
      }
      const nameEl = document.getElementById("detail-item-name");
      if (nameEl) nameEl.innerHTML = `${name} ${storeBadge(info.activeInStore)}`;

      const h = loadPriceHistory();
      if (h[itemId]) {
        if (info.category) h[itemId].subCategory = info.category;
        if (info.parentCategory) h[itemId].parentCategory = info.parentCategory;
        h[itemId].activeInStore = info.activeInStore;
        savePriceHistory(h);
      }
      const bl = loadBuyList();
      const bi = bl.findIndex(i => String(i.id) === String(itemId));
      if (bi !== -1) {
        if (info.category && !bl[bi].subCategory) bl[bi].subCategory = info.category;
        if (info.parentCategory && !bl[bi].parentCategory) bl[bi].parentCategory = info.parentCategory;
        bl[bi].activeInStore = info.activeInStore;
        saveBuyList(bl);
      }
      const sl = loadSellList();
      const si = sl.findIndex(i => String(i.id) === String(itemId));
      if (si !== -1) {
        if (info.category && !sl[si].subCategory) sl[si].subCategory = info.category;
        if (info.parentCategory && !sl[si].parentCategory) sl[si].parentCategory = info.parentCategory;
        sl[si].activeInStore = info.activeInStore;
        saveSellList(sl);
      }
    });
  }

  if (!skipRefresh) {
    fetchApprovedPriceLogs(itemId).then(logs => {
      if (currentDetailId !== String(itemId)) return;
      detailApprovedLogs = logs;
      renderDetailLog();
      renderSparkline();
      refreshDetailStats();
    });

    fetchSupabasePrices([String(itemId)]).then(prices => {
      const p = prices[String(itemId)];
      if (!p) return;
      const history = loadPriceHistory();
      const today = new Date().toISOString().split("T")[0];
      if (!history[itemId]) {
        history[itemId] = { id: Number(itemId), name, pricechecks: [], supabasePrices: [] };
      }
      const prev = (history[itemId].supabasePrices ?? []).at(-1);
      if (prev?.date === today && prev?.min === p.min && prev?.max === p.max) return;
      history[itemId].supabasePrices = [...(history[itemId].supabasePrices ?? []), { min: p.min, max: p.max, date: today }];
      savePriceHistory(history);
      if (currentDetailId === String(itemId)) openDetail(itemId, true);
    });
  }

  fetchItemCounts(itemId).then(({ buyCount, sellCount }) => {
    if (currentDetailId !== String(itemId)) return;
    updateDetailButtons(itemId, communityState);
    updateDetailCounters(buyCount, sellCount);
  });
}

function closeDetail() {
  detailApprovedLogs = [];
  const detailPage = document.getElementById("detail-page");
  detailPage.classList.remove("open");
  setTimeout(() => {
    detailPage.classList.add("hidden");
    document.getElementById("detail-header-actions").innerHTML = "";
  }, 250);
}

// Website: there is no sidebar to close, so the ✕ on the detail page closes the detail view
document.getElementById("detail-close-btn").addEventListener("click", closeDetail);

// ── Detail stats refresh ───────────────────────────────────────
async function refreshDetailStats() {
  const grid = document.getElementById("detail-stats-grid");
  if (!grid || !currentDetailId) return;
  const entry = loadPriceHistory()[currentDetailId];
  const coinRange = computeDetailCoinRange(entry);
  const noData = `<div style="font-size:14px;font-weight:500;color:var(--muted);margin-top:4px">No data</div>`;
  const tile = (label, value) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:2px">${label}</div>
      ${value !== null ? `<div style="font-size:15px;font-weight:600;margin:4px 0;display:flex;align-items:center;gap:4px">${COIN_ICON} ${formatCoins(value)}</div>` : noData}
    </div>`;
  grid.innerHTML = tile("Coin min", coinRange?.min ?? null) + tile("Coin max", coinRange?.max ?? null);

  const requestWrap = document.getElementById("detail-request-price-wrap");
  if (requestWrap) {
    const alreadyRequested = await getRequestedFlag(currentDetailId);
    requestWrap.innerHTML = renderPriceLogActionButtons(currentDetailId, !!coinRange, alreadyRequested);
  }
}

// ── Settings ───────────────────────────────────────────────────
// Website: these are the content widths in px (the extension used sidebar widths)
const SIZE_WIDTHS = { small: 720, medium: 960, large: 1200 };

function loadSettings() {
  return JSON.parse(localStorage.getItem("yoworld_settings") || '{"theme":"light","size":"medium"}');
}

function saveSettings(s) {
  localStorage.setItem("yoworld_settings", JSON.stringify(s));
}

function isAutoSubmitEnabled() {
  return loadSettings().autoSubmit !== false; // on by default
}

function applySettings(s) {
  document.body.classList.toggle("dark", s.theme === "dark");
  document.documentElement.style.setProperty("--content-width", `${SIZE_WIDTHS[s.size] ?? 960}px`);
}

// Title updates the preview as you type, not only when the box loses focus
document.addEventListener("input", e => {
  if (e.target.dataset.action === "set-export-title") {
    setExportTitle(e.target.dataset.list, e.target.value);
    renderExportPreview(e.target.dataset.list);
  }
});

document.addEventListener("change", e => {
  if (e.target.dataset.action === "set-export-format") {
    paintboardFormat[e.target.dataset.list] = e.target.value;
    paintboardMode[e.target.dataset.list] = e.target.value;
    renderAll();
  }
  if (e.target.dataset.action === "set-sort-option") {
    const listType = e.target.name.replace("-sort-option", "");
    saveSortOption(listType, e.target.value);
    renderAll();
  }
  if (e.target.dataset.action === "set-export-title") {
    setExportTitle(e.target.dataset.list, e.target.value);
    renderExportPreview(e.target.dataset.list);
  }
  if (e.target.dataset.action === "set-custom-colour") {
    applyCustomHex(e.target.dataset.kind, e.target.value);
  }
  if (e.target.dataset.action === "set-custom-hex") {
    let hex = e.target.value.trim();
    if (/^[0-9a-f]{6}$/i.test(hex)) hex = "#" + hex;
    if (HEX_RE.test(hex)) applyCustomHex(e.target.dataset.kind, hex);
    else e.target.classList.add("invalid");
  }
  if (e.target.dataset.action === "set-buy-offer") {
    setOfferPrice("buy", Number(e.target.dataset.id), e.target.value);
  }
  if (e.target.dataset.action === "set-sell-offer") {
    setOfferPrice("sell", Number(e.target.dataset.id), e.target.value);
  }
});

// ── Init ───────────────────────────────────────────────────────
applySettings(loadSettings());
// Sidebars and the page body are offset by the header's height, so measure it
const headerEl = document.querySelector("header");
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--header-h", `${headerEl.offsetHeight}px`);
}).observe(headerEl);
resolveCategories();
syncSupabasePrices();
syncApprovedPriceLogs();
renderSubmitReminderBanner();
buildPaintboardRail("buy");
buildPaintboardRail("sell");
renderAll();

// Column count changes with the window width, so recalculate the page size
let listResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(listResizeTimer);
  listResizeTimer = setTimeout(renderAll, 150);
});

// ── FILTER STORAGE FUNCTIONS ──────────────────────────────────────
function loadCategorySelection(listType) {
  const stored = localStorage.getItem(`${listType}CatSel`);
  return stored ? new Set(JSON.parse(stored).map(String)) : new Set();
}

function saveCategorySelection(listType, selection) {
  localStorage.setItem(`${listType}CatSel`, JSON.stringify(Array.from(selection)));
}

function loadInstoreSelection(listType) {
  const stored = localStorage.getItem(`${listType}InStoreSel`);
  return stored || "";
}

function loadCategoryCollapsedState(listType) {
  const stored = localStorage.getItem(`${listType}CatCollapsed`);
  return stored ? new Set(JSON.parse(stored)) : new Set(["Appearance", "Body", "Furniture", "Pets", "Food"]);
}

function saveCategoryCollapsedState(listType, collapsed) {
  localStorage.setItem(`${listType}CatCollapsed`, JSON.stringify(Array.from(collapsed)));
}

function saveInstoreSelection(listType, value) {
  localStorage.setItem(`${listType}InStoreSel`, value);
}

function updateFilterCount(listType) {
  const countEl = document.getElementById(`${listType}-filter-count`);
  const selectedCats = loadCategorySelection(listType);
  const instore = loadInstoreSelection(listType);
  const count = (selectedCats.size > 0 ? 1 : 0) + (instore ? 1 : 0);
  if (count > 0) {
    countEl.textContent = count;
    countEl.classList.remove("hidden");
  } else {
    countEl.classList.add("hidden");
  }
}

function loadSortOption(listType) {
  const stored = localStorage.getItem(`${listType}SortOption`);
  return stored || "none";
}

function saveSortOption(listType, option) {
  localStorage.setItem(`${listType}SortOption`, option);
}

function buildSimpleFilterMenu(listType) {
  const selection = loadCategorySelection(listType);
  const collapsedState = loadCategoryCollapsedState(listType);
  let html = `
    <label class="category-filter-option">
      <input type="checkbox" id="${listType}-category-opt-all" class="category-filter-all" data-list-type="${listType}" ${selection.size === 0 ? "checked" : ""} />
      <span>All Categories</span>
    </label>
    <div class="category-filter-divider"></div>
  `;

  const categoryHierarchy = {
    "Appearance": ["Hair", "Face & Skin", "Eyes", "Mouth"],
    "Clothing": ["Tops", "Bottoms", "Dresses", "Hats", "Footwear"],
    "Accessories": ["Accessories", "Bags"],
    "Costumes": ["Costumes"],
    "Furniture": ["Furniture"],
    "Pets": ["Pets"],
    "Food": ["Food"],
    "Other": ["Other"]
  };

  const sortedParents = Object.keys(categoryHierarchy).sort();

  for (const parent of sortedParents) {
    const categories = categoryHierarchy[parent];
    const isCollapsed = collapsedState.has(parent);
    const parentId = parent.replace(/[^a-z0-9]/gi, '-').toLowerCase();

    if (categories.length > 1) {
      const chevron = isCollapsed ? "›" : "∨";
      const allChecked = categories.every(cat => selection.has(cat));
      html += `
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;margin-bottom:4px">
          <input type="checkbox" class="category-parent-opt" value="${parent}" data-list-type="${listType}" data-parent="${parent}" ${allChecked ? "checked" : ""} />
          <button class="category-parent-toggle" data-parent="${parent}" data-list-type="${listType}" style="color:var(--text);background:none;border:none;cursor:pointer;padding:0;font-size:inherit;display:flex;align-items:center;justify-content:space-between;gap:8px;flex:1">
            <span>${parent}</span>
            <span class="category-chevron" style="font-size:14px;display:flex;align-items:center;justify-content:center;width:16px">${chevron}</span>
          </button>
        </div>
      `;
    }

    for (const cat of categories) {
      const isSelected = selection.has(cat);
      const indent = categories.length > 1 ? `style="margin-left:32px` : `style="`;
      const display = categories.length > 1 && isCollapsed ? `${indent};display:none"` : `${indent}"`;
      html += `
        <label class="category-filter-option category-item-${parentId}" ${display}>
          <input type="checkbox" class="category-opt" value="${cat}" data-list-type="${listType}" ${isSelected ? "checked" : ""} />
          <span>${cat}</span>
        </label>
      `;
    }
  }

  return html;
}

function setupCategoryFilterListeners(listType) {
  const filterBtn = document.getElementById(`${listType}-filter-btn`);
  const filterPanel = document.getElementById(`${listType}-filter-panel`);
  const closeBtn = document.getElementById(`${listType}-filter-close`);
  const filterMenu = document.getElementById(`${listType}-category-filter-menu`);
  const instoreRadios = document.querySelectorAll(`input[name="${listType}-instore"]`);

  if (!filterBtn || !filterPanel) return;

  filterBtn.addEventListener("click", () => {
    filterPanel.classList.remove("hidden");
  });

  closeBtn.addEventListener("click", () => {
    filterPanel.classList.add("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!filterPanel.contains(e.target) && e.target !== filterBtn && !filterBtn.contains(e.target)) {
      filterPanel.classList.add("hidden");
    }
  });

  const handleFilterChange = () => {
    updateFilterCount(listType);
    if (listType === "search") {
      if (currentQuery) doSearch(currentQuery, 1);
    } else {
      buyPage = 1;
      sellPage = 1;
      renderAll();
    }
  };

  instoreRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      saveInstoreSelection(listType, radio.value);
      handleFilterChange();
    });
  });

  if (filterMenu) {
    filterMenu.addEventListener("change", (e) => {
      if (e.target.classList.contains("category-filter-all")) {
        const isChecked = e.target.checked;
        const allCheckboxes = filterMenu.querySelectorAll(".category-opt");
        const allParents = filterMenu.querySelectorAll(".category-parent-opt");

        allCheckboxes.forEach(cb => cb.checked = isChecked);
        allParents.forEach(parent => {
          parent.checked = isChecked;
          parent.indeterminate = false;
        });

        if (isChecked) saveCategorySelection(listType, new Set());
        else {
          const selected = new Set();
          allCheckboxes.forEach(cb => { if (cb.checked) selected.add(cb.value); });
          saveCategorySelection(listType, selected);
        }
      } else if (e.target.classList.contains("category-parent-opt")) {
        const parent = e.target.dataset.parent;
        const isChecked = e.target.checked;
        e.target.indeterminate = false;
        const categoryHierarchy = {
          "Appearance": ["Hair", "Face & Skin", "Eyes", "Mouth"],
          "Clothing": ["Tops", "Bottoms", "Dresses", "Hats", "Footwear"],
          "Accessories": ["Accessories", "Bags"],
          "Costumes": ["Costumes"],
          "Furniture": ["Furniture"],
          "Pets": ["Pets"],
          "Food": ["Food"],
          "Other": ["Other"]
        };
        const categories = categoryHierarchy[parent] || [];
        const selected = new Set();
        filterMenu.querySelectorAll(".category-opt:checked").forEach(cb => selected.add(cb.value));

        categories.forEach(cat => {
          if (isChecked) {
            selected.add(cat);
          } else {
            selected.delete(cat);
          }
        });

        filterMenu.querySelectorAll(".category-opt").forEach(cb => {
          cb.checked = selected.has(cb.value);
        });

        // Update other parent checkboxes based on their sub-item states
        filterMenu.querySelectorAll(".category-parent-opt").forEach(parentCheckbox => {
          const parentName = parentCheckbox.dataset.parent;
          const parentCats = categoryHierarchy[parentName] || [];
          const checkedCount = parentCats.filter(cat => selected.has(cat)).length;
          parentCheckbox.checked = checkedCount === parentCats.length && parentCats.length > 0;
          parentCheckbox.indeterminate = checkedCount > 0 && checkedCount < parentCats.length;
        });

        const allOpts = filterMenu.querySelectorAll(".category-opt");
        if (selected.size === allOpts.length) {
          document.getElementById(`${listType}-category-opt-all`).checked = true;
          saveCategorySelection(listType, new Set());
        } else {
          document.getElementById(`${listType}-category-opt-all`).checked = false;
          saveCategorySelection(listType, selected);
        }
      } else if (e.target.classList.contains("category-opt")) {
        const selected = new Set();
        const allOpts = filterMenu.querySelectorAll(".category-opt");
        allOpts.forEach(cb => { if (cb.checked) selected.add(cb.value); });

        // Update parent checkbox states based on their sub-item states
        const categoryHierarchy = {
          "Appearance": ["Hair", "Face & Skin", "Eyes", "Mouth"],
          "Clothing": ["Tops", "Bottoms", "Dresses", "Hats", "Footwear"],
          "Accessories": ["Accessories", "Bags"],
          "Costumes": ["Costumes"],
          "Furniture": ["Furniture"],
          "Pets": ["Pets"],
          "Food": ["Food"],
          "Other": ["Other"]
        };

        filterMenu.querySelectorAll(".category-parent-opt").forEach(parentCheckbox => {
          const parentName = parentCheckbox.dataset.parent;
          const parentCats = categoryHierarchy[parentName] || [];
          const checkedCount = parentCats.filter(cat => selected.has(cat)).length;
          parentCheckbox.checked = checkedCount === parentCats.length && parentCats.length > 0;
          parentCheckbox.indeterminate = checkedCount > 0 && checkedCount < parentCats.length;
        });

        if (selected.size === allOpts.length) {
          document.getElementById(`${listType}-category-opt-all`).checked = true;
          saveCategorySelection(listType, new Set());
        } else {
          document.getElementById(`${listType}-category-opt-all`).checked = false;
          saveCategorySelection(listType, selected);
        }
      }
      handleFilterChange();
    });

    filterMenu.addEventListener("click", (e) => {
      if (e.target.classList.contains("category-parent-toggle") || e.target.closest(".category-parent-toggle")) {
        const btn = e.target.classList.contains("category-parent-toggle") ? e.target : e.target.closest(".category-parent-toggle");
        const parent = btn.dataset.parent;
        const collapsed = loadCategoryCollapsedState(listType);

        if (collapsed.has(parent)) {
          collapsed.delete(parent);
        } else {
          collapsed.add(parent);
        }
        saveCategoryCollapsedState(listType, collapsed);

        const parentId = parent.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const items = filterMenu.querySelectorAll(`.category-item-${parentId}`);
        const chevron = btn.querySelector(".category-chevron");
        const isNowCollapsed = collapsed.has(parent);

        items.forEach(item => {
          item.style.display = isNowCollapsed ? "none" : "";
        });
        chevron.textContent = isNowCollapsed ? "›" : "∨";
      }
    });
  }

  updateFilterCount(listType);
}

function getFilteredSearchResults(query, words) {
  const items = window.currentSearchItems || [];
  const selectedCats = loadCategorySelection("search");
  const instore = loadInstoreSelection("search");

  return items.filter(i => {
    const nameOk = !words.length || (() => { const n = i.item_name.toLowerCase(); return words.every(w => n.includes(w)); })();
    const catOk = selectedCats.size === 0 || selectedCats.has(String(i.item_category_id || i.category));
    const instoreOk = !instore || (String(i.activeInStore) === instore);
    return nameOk && catOk && instoreOk;
  });
}

// Initialize filters
setupCategoryFilterListeners("buy");
setupCategoryFilterListeners("sell");

document.getElementById("buy-category-filter-menu").innerHTML = buildSimpleFilterMenu("buy");
document.getElementById("sell-category-filter-menu").innerHTML = buildSimpleFilterMenu("sell");

// Sync category checkboxes on initialization
["search", "buy", "sell"].forEach(listType => {
  const filterMenu = document.getElementById(`${listType}-category-filter-menu`);
  if (!filterMenu) return;

  const allCategoriesCheckbox = document.getElementById(`${listType}-category-opt-all`);
  if (allCategoriesCheckbox && allCategoriesCheckbox.checked) {
    const allOpts = filterMenu.querySelectorAll(".category-opt");
    const allParents = filterMenu.querySelectorAll(".category-parent-opt");
    allOpts.forEach(opt => opt.checked = true);
    allParents.forEach(parent => {
      parent.checked = true;
      parent.indeterminate = false;
    });
  }
});

const buyInstoreEl = document.querySelector(`input[name="buy-instore"][value="${loadInstoreSelection("buy")}"]`);
if (buyInstoreEl) buyInstoreEl.checked = true;

const sellInstoreEl = document.querySelector(`input[name="sell-instore"][value="${loadInstoreSelection("sell")}"]`);
if (sellInstoreEl) sellInstoreEl.checked = true;

