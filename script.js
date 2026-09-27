"use strict";

// Escape from Tarkov Wiki(英語版)の MediaWiki API を直接叩く。
// api.php は origin=* を付けることで CORS 許可ヘッダーを返してくれるため、
// バックエンドを用意しなくてもブラウザから直接データ取得できる。
const WIKI_ORIGIN = "https://escapefromtarkov.fandom.com";
const API_ENDPOINT = `${WIKI_ORIGIN}/api.php`;
const QUEST_CATEGORY = "Category:Quests";
const QUEST_LIST_CACHE_KEY = "tarkov_quest_list_v1";
const QUEST_LIST_CACHE_HOURS = 24;

// 翻訳には Google 翻訳の非公式エンドポイントを使用している(無料・APIキー不要だが
// 正式な公開APIではないため、将来ブロックされたり仕様が変わる可能性がある)。
// 失敗した場合は原文(英語)をそのまま表示するフェイルセーフにしてある。
const TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
// 1文ずつ送ると項目の多いクエスト(Collector など)で数百回の通信になり制限にかかるため、
// 改行でまとめて送る。行数が合わなかった場合だけ1文ずつ送り直す。
const TRANSLATE_BATCH_MAX_LINES = 40;
const TRANSLATE_BATCH_MAX_CHARS = 4000;
const TRANSLATE_CONCURRENCY = 2;
const TRANSLATE_RETRY_DELAYS_MS = [1000, 3000];

// 短い略語は文脈がないと機械翻訳が誤訳しやすい(例: "Rep" が「代表者」と誤訳される)。
// 翻訳に送る前に曖昧さのない語へ置き換えておく。
const TRANSLATE_PRE_REPLACEMENTS = [
  [/\bRep\b/g, "Reputation"],
  [/\bno\.\s*(?=\d)/gi, "#"],
];

// 表の見出しなど、決まった短い語は機械翻訳より辞書の方が正確(例: "Item name" が「項目名」になる)
const FIXED_PHRASES = {
  "N/A": "なし",
  Icon: "アイコン",
  "Item name": "アイテム名",
  Amount: "数量",
  Requirement: "条件",
  Required: "必須",
  Notes: "備考",
  "Related Quest Items": "関連クエストアイテム",
  "Handover item": "納品アイテム",
  Optional: "任意",
  Yes: "はい",
  No: "いいえ",
  or: "または",
};

// マップ名・トレーダー名・アイテム名などは Wiki 内で必ずリンク(<a>)になっているため、
// リンクテキストは翻訳せず英語のまま保持し、地の文だけを翻訳する。
// 対応表にないラベル・見出しは機械翻訳する。
const INFOBOX_LABEL_MAP = {
  Location: "マップ",
  "Given by": "依頼者",
  "Loyalty level": "ロイヤリティレベル",
  "Level Required": "必要レベル",
  Predecessor: "前提クエスト",
  Successor: "後続クエスト",
  "Requires reg. Foundation": "ファンデーション必須",
  "Kappa Container Required": "カッパコンテナ必須",
  "Wiki link": "Wikiリンク",
};

const SECTION_LABEL_MAP = {
  Dialogue: "依頼時の会話",
  Requirements: "受注条件",
  Objectives: "目的",
  Rewards: "報酬",
  Guide: "攻略ガイド",
  Trivia: "小ネタ",
  Media: "メディア",
  Initial_Equipment: "初期装備",
  Failure_Penalty: "失敗時のペナルティ",
};

// マップ名だけの小見出し(Customs など)は固有名詞なので翻訳しない
const MAP_NAMES = new Set([
  "Customs",
  "Woods",
  "Interchange",
  "Shoreline",
  "Reserve",
  "Lighthouse",
  "Factory",
  "Streets of Tarkov",
  "The Lab",
  "Ground Zero",
  "Labyrinth",
  "Terminal",
]);

const searchInput = document.getElementById("searchInput");
const suggestList = document.getElementById("suggestList");
const listStatus = document.getElementById("listStatus");
const reloadListButton = document.getElementById("reloadListButton");
const resultEl = document.getElementById("result");

let questTitles = [];
let activeSuggestIndex = -1;
const questRenderCache = new Map(); // 選択済みクエストの翻訳結果を保持し、再選択時の再翻訳を防ぐ
const translateCache = new Map(); // 同一文の翻訳結果を使い回すためのキャッシュ(セッション内のみ)

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

async function init() {
  questTitles = await loadQuestTitles({ forceRefresh: false });
}

// ---- クエスト一覧の取得(オートコンプリート用) ----

async function loadQuestTitles({ forceRefresh }) {
  if (!forceRefresh) {
    const cached = readQuestListCache();
    if (cached) {
      setListStatus(`クエスト一覧: ${cached.length}件(キャッシュ)`);
      return cached;
    }
  }

  setListStatus("クエスト一覧を取得中...");
  try {
    const titles = await fetchAllQuestTitles();
    writeQuestListCache(titles);
    setListStatus(`クエスト一覧: ${titles.length}件`);
    return titles;
  } catch (err) {
    console.error(err);
    setListStatus("クエスト一覧の取得に失敗しました(通信環境を確認してください)");
    return [];
  }
}

async function fetchAllQuestTitles() {
  const titles = [];
  let cmcontinue = null;

  do {
    const params = {
      action: "query",
      list: "categorymembers",
      cmtitle: QUEST_CATEGORY,
      cmlimit: "500",
      format: "json",
      origin: "*",
    };
    if (cmcontinue) {
      params.cmcontinue = cmcontinue;
    }

    const data = await callApi(params);
    const members = data?.query?.categorymembers ?? [];
    for (const member of members) {
      if (member.ns === 0) {
        titles.push(member.title);
      }
    }
    cmcontinue = data?.continue?.cmcontinue ?? null;
  } while (cmcontinue);

  titles.sort((a, b) => a.localeCompare(b));
  return titles;
}

function readQuestListCache() {
  try {
    const raw = localStorage.getItem(QUEST_LIST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const ageHours = (Date.now() - parsed.savedAt) / (1000 * 60 * 60);
    if (ageHours > QUEST_LIST_CACHE_HOURS) return null;
    if (!Array.isArray(parsed.titles) || parsed.titles.length === 0) return null;
    return parsed.titles;
  } catch {
    return null;
  }
}

function writeQuestListCache(titles) {
  try {
    localStorage.setItem(
      QUEST_LIST_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), titles })
    );
  } catch {
    // ストレージが使えない環境では黙って諦める(キャッシュなしで動作継続)
  }
}

reloadListButton.addEventListener("click", async () => {
  reloadListButton.disabled = true;
  questTitles = await loadQuestTitles({ forceRefresh: true });
  reloadListButton.disabled = false;
});

function setListStatus(text) {
  listStatus.textContent = text;
}

// ---- 検索ボックスの候補表示 ----

let debounceTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderSuggestions, 120);
});

searchInput.addEventListener("keydown", (event) => {
  const items = Array.from(suggestList.querySelectorAll("li"));
  if (items.length === 0) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeSuggestIndex = Math.min(activeSuggestIndex + 1, items.length - 1);
    highlightSuggestion(items);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    activeSuggestIndex = Math.max(activeSuggestIndex - 1, 0);
    highlightSuggestion(items);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const index = activeSuggestIndex >= 0 ? activeSuggestIndex : 0;
    const title = items[index]?.dataset.title;
    if (title) selectQuest(title);
  } else if (event.key === "Escape") {
    closeSuggestions();
  }
});

document.addEventListener("click", (event) => {
  if (!suggestList.contains(event.target) && event.target !== searchInput) {
    closeSuggestions();
  }
});

function renderSuggestions() {
  const query = searchInput.value.trim().toLowerCase();
  suggestList.innerHTML = "";
  activeSuggestIndex = -1;

  if (!query) {
    closeSuggestions();
    return;
  }

  const matches = questTitles
    .filter((title) => title.toLowerCase().includes(query))
    .slice(0, 30);

  if (matches.length === 0) {
    closeSuggestions();
    return;
  }

  for (const title of matches) {
    const li = document.createElement("li");
    li.textContent = title;
    li.dataset.title = title;
    li.addEventListener("click", () => selectQuest(title));
    suggestList.appendChild(li);
  }
  suggestList.hidden = false;
}

function highlightSuggestion(items) {
  items.forEach((item, index) => {
    item.classList.toggle("is-active", index === activeSuggestIndex);
  });
  items[activeSuggestIndex]?.scrollIntoView({ block: "nearest" });
}

function closeSuggestions() {
  suggestList.hidden = true;
  suggestList.innerHTML = "";
  activeSuggestIndex = -1;
}

// ---- クエスト詳細の取得と表示 ----

async function selectQuest(title) {
  searchInput.value = title;
  closeSuggestions();

  if (questRenderCache.has(title)) {
    renderQuestData(questRenderCache.get(title));
    return;
  }

  renderLoading(title, "情報を取得中...");

  try {
    const html = await fetchQuestPageHtml(title);
    const questData = parseQuestHtml(html, title);

    renderLoading(title, "日本語に翻訳中...");
    await translateQuestData(questData);

    // 一部の翻訳に失敗したものは保存せず、次に開いたときに翻訳し直す
    if (!questData.translationIncomplete) {
      questRenderCache.set(title, questData);
    }
    renderQuestData(questData);
  } catch (err) {
    console.error(err);
    renderError(title, err);
  }
}

async function fetchQuestPageHtml(title) {
  const data = await callApi({
    action: "parse",
    page: title,
    format: "json",
    prop: "text",
    redirects: "1",
    origin: "*",
  });

  if (data.error) {
    throw new Error(data.error.info || "ページが見つかりませんでした");
  }
  return data.parse.text["*"];
}

async function callApi(params) {
  const url = new URL(API_ENDPOINT);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Wiki API への通信に失敗しました(HTTP ${response.status})`);
  }
  return response.json();
}

function parseQuestHtml(html, fallbackTitle) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const infoboxTable = doc.querySelector("table.va-infobox");
  const titleText =
    infoboxTable?.querySelector(".va-infobox-title-main")?.textContent.trim() ||
    fallbackTitle;
  const imageSrc =
    infoboxTable?.querySelector(".va-infobox-mainimage-image img")?.getAttribute("src") ||
    null;

  const infoboxItems = [];
  if (infoboxTable) {
    infoboxTable.querySelectorAll("tr").forEach((row) => {
      const label = row.querySelector("td.va-infobox-label");
      const content = row.querySelector("td.va-infobox-content");
      if (label && content) {
        const contentNode = content.cloneNode(true);
        sanitizeContentFragment(contentNode);
        const labelText = label.textContent.trim();
        infoboxItems.push({
          label: labelText,
          displayLabel: INFOBOX_LABEL_MAP[labelText] || labelText,
          contentNode,
        });
      }
    });
  }

  const sections = extractSections(doc);

  return {
    title: titleText,
    imageSrc,
    infoboxItems,
    sections,
    wikiUrl: `${WIKI_ORIGIN}/wiki/${encodeURIComponent(fallbackTitle.replace(/ /g, "_"))}`,
  };
}

function extractSections(doc) {
  const headlines = Array.from(
    doc.querySelectorAll("h2 > span.mw-headline, h3 > span.mw-headline")
  ).filter((span) => span.id !== "mw-toc-heading");

  const sections = [];

  headlines.forEach((headline, index) => {
    const headingEl = headline.parentElement; // h2 または h3
    const nextHeadingEl = headlines[index + 1]?.parentElement ?? null;

    const container = document.createElement("div");
    let node = headingEl.nextElementSibling;
    while (node && node !== nextHeadingEl) {
      if (node.matches("table.navbox, table.va-navbox-border")) break;
      container.appendChild(node.cloneNode(true));
      node = node.nextElementSibling;
    }

    sanitizeContentFragment(container);

    if (container.childElementCount > 0) {
      container.classList.add("lang-ja");
      const englishNode = container.cloneNode(true);
      englishNode.classList.remove("lang-ja");
      englishNode.classList.add("lang-en");
      const headingText = headline.textContent.trim();
      sections.push({
        id: headline.id,
        headingText,
        label: SECTION_LABEL_MAP[headline.id] || headingText,
        contentNode: container,
        englishNode,
      });
    }
  });

  return sections;
}

// wiki から取得した HTML を表示用に無害化・整形する。
// script 等の危険要素を除去し、相対リンクを絶対URLに直して新規タブで開くようにする。
function sanitizeContentFragment(root) {
  root.querySelectorAll("script, style, iframe, object, embed").forEach((el) => el.remove());

  root.querySelectorAll("*").forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (attr.name.toLowerCase().startsWith("on")) {
        el.removeAttribute(attr.name);
      }
    });
  });

  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (href && href.startsWith("/")) {
      a.setAttribute("href", WIKI_ORIGIN + href);
    }
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener");
  });

  root.querySelectorAll(".mw-editsection").forEach((el) => el.remove());
}

// ---- 日本語翻訳 ----

// 直下の文章をひとまとまりの文として翻訳する要素
const TRANSLATION_UNIT_SELECTOR = "li, p, td, th, dd, dt, caption, div, blockquote, h1, h2, h3, h4, h5, h6";
// 文の区切りになる要素。これをまたいで1文にはしない(それぞれ別の単位として翻訳される)
const BLOCK_TAGS = new Set([
  "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "CAPTION",
  "P", "DIV", "BLOCKQUOTE", "DL", "DD", "DT", "FIGURE",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);
// 中身ごと英語のまま残す要素(リンクは固有名詞、画像や改行は文章ではない)
const PROTECTED_TAGS = new Set(["A", "IMG", "BR", "SUP"]);
const TOKEN_SPLIT_PATTERN = /(⟦\d+⟧)/;
const TOKEN_PATTERN = /⟦(\d+)⟧/g;

async function translateQuestData(questData) {
  const jobs = [];

  for (const section of questData.sections) {
    collectTextJobs(section.contentNode, jobs);
    if (!SECTION_LABEL_MAP[section.id] && !MAP_NAMES.has(section.headingText)) {
      jobs.push({ template: section.headingText, apply: (text) => { section.label = text.trim(); } });
    }
  }
  for (const item of questData.infoboxItems) {
    collectTextJobs(item.contentNode, jobs);
    if (!INFOBOX_LABEL_MAP[item.label]) {
      jobs.push({ template: item.label, apply: (text) => { item.displayLabel = text.trim(); } });
    }
  }

  questData.translationIncomplete = !(await translateJobs(jobs));
}

// 要素の直下を「ブロック要素で区切られた文のまとまり(run)」に分け、それぞれを翻訳ジョブにする
function collectTextJobs(root, jobs) {
  const units = [root, ...root.querySelectorAll(TRANSLATION_UNIT_SELECTOR)];
  for (const unit of units) {
    let run = [];
    for (const node of Array.from(unit.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName)) {
        pushRunJob(run, jobs);
        run = [];
      } else {
        run.push(node);
      }
    }
    pushRunJob(run, jobs);
  }
}

// 会話文などではマップ名がリンクなしで書かれていることがあるため、文中の出現も英語のまま保護する
const MAP_NAME_PATTERN = new RegExp(
  `\\b(${[...MAP_NAMES].sort((a, b) => b.length - a.length).join("|")})\\b`,
  "g"
);

function pushRunJob(run, jobs) {
  if (run.length === 0) return;
  const tokens = [];
  const template = run
    .map((node) => buildTemplate(node, tokens))
    .join("")
    .replace(/\s+/g, " ")
    .replace(MAP_NAME_PATTERN, (name) => {
      tokens.push(document.createTextNode(name));
      return `⟦${tokens.length - 1}⟧`;
    });
  if (!/[A-Za-z]/.test(template.replace(TOKEN_PATTERN, ""))) return;
  jobs.push({ template, apply: (text) => replaceRun(run, text, tokens) });
}

// リンクなど保護する要素はトークン(⟦0⟧など)に置き換え、翻訳後に元の要素へ戻す。
// 太字・色付けなどの装飾は、目印で挟むと翻訳で順序が崩れることがあるため、外して中身だけ翻訳する。
function buildTemplate(node, tokens) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const hasLetters = /[A-Za-z]/.test(node.textContent);
  if (PROTECTED_TAGS.has(node.tagName) || BLOCK_TAGS.has(node.tagName) || !hasLetters) {
    tokens.push(node);
    return `⟦${tokens.length - 1}⟧`;
  }
  return Array.from(node.childNodes).map((child) => buildTemplate(child, tokens)).join("");
}

// 翻訳結果は HTML として解釈せずテキストノードとして差し込み、トークン位置には元の要素(実物)を戻す
function replaceRun(run, translated, tokens) {
  const parent = run[0].parentNode;
  if (!parent) return;
  const marker = document.createComment("");
  parent.insertBefore(marker, run[0]);

  const fragment = document.createDocumentFragment();
  const used = new Set();
  for (const part of translated.split(TOKEN_SPLIT_PATTERN)) {
    const match = part.match(/^⟦(\d+)⟧$/);
    const index = match ? Number(match[1]) : -1;
    if (tokens[index]) {
      fragment.appendChild(used.has(index) ? tokens[index].cloneNode(true) : tokens[index]);
      used.add(index);
    } else if (part) {
      fragment.appendChild(document.createTextNode(part));
    }
  }
  // 翻訳でトークンが消えてしまった場合も、リンクなどを失わないよう末尾に残す
  tokens.forEach((token, index) => {
    if (!used.has(index)) fragment.appendChild(token);
  });

  for (const node of run) {
    if (node.parentNode === parent) parent.removeChild(node);
  }
  parent.replaceChild(fragment, marker);
}

// 翻訳ジョブをまとめて翻訳し、各ジョブに結果を反映する。すべて成功したら true を返す
async function translateJobs(jobs) {
  const pending = [
    ...new Set(
      jobs
        .map((job) => job.template.trim())
        .filter((text) => !Object.hasOwn(FIXED_PHRASES, text) && !translateCache.has(text))
    ),
  ];

  let allSucceeded = true;
  await runWithConcurrency(splitIntoBatches(pending), TRANSLATE_CONCURRENCY, async (batch) => {
    if (!(await translateBatch(batch))) allSucceeded = false;
  });

  for (const job of jobs) {
    const key = job.template.trim();
    const translated = Object.hasOwn(FIXED_PHRASES, key) ? FIXED_PHRASES[key] : translateCache.get(key);
    if (translated === undefined) continue; // 失敗した文は原文のまま残す
    const leading = /^\s/.test(job.template) ? " " : "";
    const trailing = /\s$/.test(job.template) ? " " : "";
    job.apply(leading + translated + trailing);
  }
  return allSucceeded;
}

function splitIntoBatches(texts) {
  const batches = [];
  let current = [];
  let length = 0;
  for (const text of texts) {
    if (current.length > 0 && (current.length >= TRANSLATE_BATCH_MAX_LINES || length + text.length > TRANSLATE_BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      length = 0;
    }
    current.push(text);
    length += text.length + 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function translateBatch(texts) {
  let lines;
  try {
    lines = (await requestTranslation(texts.map(applyPreTranslateGlossary).join("\n"))).split("\n");
  } catch (err) {
    console.warn("翻訳に失敗したため原文のまま表示します:", err);
    return false;
  }

  if (lines.length === texts.length) {
    texts.forEach((text, index) => translateCache.set(text, lines[index].trim()));
    return true;
  }

  // 行数がずれて対応が取れない場合だけ、1文ずつ翻訳し直す
  let allSucceeded = true;
  for (const text of texts) {
    try {
      translateCache.set(text, (await requestTranslation(applyPreTranslateGlossary(text))).trim());
    } catch (err) {
      console.warn("翻訳に失敗したため原文のまま表示します:", err);
      allSucceeded = false;
    }
  }
  return allSucceeded;
}

function applyPreTranslateGlossary(text) {
  return TRANSLATE_PRE_REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text
  );
}

// 長文でも URL の長さ制限にかからないよう POST で送る。一時的な失敗は間隔をあけて再試行する
async function requestTranslation(text) {
  const url = `${TRANSLATE_ENDPOINT}?client=gtx&sl=en&tl=ja&dt=t`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", body: new URLSearchParams({ q: text }) });
      if (!response.ok) {
        throw new Error(`翻訳APIへの通信に失敗しました(HTTP ${response.status})`);
      }
      const data = await response.json();
      return (data?.[0] ?? []).map((segment) => segment[0]).join("");
    } catch (err) {
      if (attempt >= TRANSLATE_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, TRANSLATE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function runWithConcurrency(items, limit, task) {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(limit, queue.length));
  const workers = new Array(workerCount).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await task(item);
    }
  });
  await Promise.all(workers);
}

function renderLoading(title, message) {
  resultEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "result__placeholder";
  p.textContent = `「${title}」: ${message}`;
  resultEl.appendChild(p);
}

function renderError(title, err) {
  resultEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = "result__error";
  p.textContent = `「${title}」の情報を取得できませんでした: ${err.message}`;
  resultEl.appendChild(p);
}

function renderQuestData(data) {
  resultEl.innerHTML = "";

  const header = document.createElement("div");
  header.className = "quest-header";

  if (data.imageSrc) {
    const img = document.createElement("img");
    img.className = "quest-header__image";
    img.src = data.imageSrc;
    img.alt = data.title;
    header.appendChild(img);
  }

  const main = document.createElement("div");
  main.className = "quest-header__main";

  const h2 = document.createElement("h2");
  h2.className = "quest-header__title";
  h2.textContent = data.title;
  main.appendChild(h2);

  const link = document.createElement("p");
  link.className = "quest-header__link";
  link.innerHTML = `<a href="${data.wikiUrl}" target="_blank" rel="noopener">Wiki の元ページを見る ↗</a>`;
  main.appendChild(link);

  header.appendChild(main);
  resultEl.appendChild(header);

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "lang-toggle";
  toggleLabel.innerHTML = `<input type="checkbox" id="showOriginalCheckbox" /> 原文(英語)を表示`;
  resultEl.appendChild(toggleLabel);

  if (data.translationIncomplete) {
    const notice = document.createElement("p");
    notice.className = "result__notice";
    notice.textContent = "一部の文章を翻訳できず、英語のまま表示しています。少し待ってからもう一度このクエストを開くと翻訳し直します。";
    resultEl.appendChild(notice);
  }

  toggleLabel
    .querySelector("#showOriginalCheckbox")
    .addEventListener("change", (event) => {
      resultEl.classList.toggle("show-original", event.target.checked);
    });

  if (data.infoboxItems.length > 0) {
    const table = document.createElement("table");
    table.className = "infobox-table";
    const tbody = document.createElement("tbody");
    for (const item of data.infoboxItems) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = item.displayLabel;
      const td = document.createElement("td");
      td.innerHTML = item.contentNode.innerHTML;
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    resultEl.appendChild(table);
  }

  for (const section of data.sections) {
    const sectionEl = document.createElement("section");
    sectionEl.className = "quest-section";

    const heading = document.createElement("h2");
    heading.textContent = section.label;
    sectionEl.appendChild(heading);

    sectionEl.appendChild(section.contentNode);
    sectionEl.appendChild(section.englishNode);
    resultEl.appendChild(sectionEl);
  }

  if (data.sections.length === 0 && data.infoboxItems.length === 0) {
    const p = document.createElement("p");
    p.className = "result__placeholder";
    p.textContent = "このページから構造化された情報を抽出できませんでした。Wiki の元ページを確認してください。";
    resultEl.appendChild(p);
  }
}
