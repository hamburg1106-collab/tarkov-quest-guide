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
const TRANSLATE_CONCURRENCY = 4;

// 短い略語は文脈がないと機械翻訳が誤訳しやすい(例: "Rep" が「代表者」と誤訳される)。
// 翻訳に送る前に曖昧さのない語へ置き換えておく。
const TRANSLATE_PRE_REPLACEMENTS = [[/\bRep\b/g, "Reputation"]];

// マップ名・トレーダー名・アイテム名などは Wiki 内で必ずリンク(<a>)になっているため、
// リンクテキストは翻訳せず英語のまま保持し、地の文だけを翻訳する。
const INFOBOX_LABEL_MAP = {
  Location: "マップ",
  "Given by": "依頼者",
  "Level Required": "必要レベル",
  Predecessor: "前提クエスト",
  Successor: "後続クエスト",
  "Requires reg. Foundation": "ファンデーション必須",
  "Kappa Container Required": "カッパコンテナ必須",
  "Wiki link": "Wikiリンク",
};

// Wiki の見出し(英語)を UI 表示用の日本語ラベルに変換する対応表。
// 対応表にない見出しは英語のまま表示する。
const SECTION_LABEL_MAP = {
  Dialogue: "依頼時の会話",
  Requirements: "受注条件",
  Objectives: "目的",
  Rewards: "報酬",
  Guide: "攻略ガイド",
  Trivia: "小ネタ",
  Media: "メディア",
};

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

    questRenderCache.set(title, questData);
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
        infoboxItems.push({
          label: label.textContent.trim(),
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
      sections.push({
        id: headline.id,
        label: SECTION_LABEL_MAP[headline.id] || headline.textContent.trim(),
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

async function translateQuestData(questData) {
  for (const section of questData.sections) {
    await translateSectionContent(section.contentNode);
  }
}

// li/p 要素を「入れ子ブロック(ul/ol/table)を含まないもの」から先に翻訳し、
// その後で入れ子を含む要素(報酬の階層リストなど)を処理する。
// こうすることで、外側の要素を組み立て直すときには内側の翻訳が既に終わっている。
async function translateSectionContent(root) {
  const allBlocks = Array.from(root.querySelectorAll("li, p"));
  const leafBlocks = allBlocks.filter((el) => !el.querySelector("ul, ol, table"));
  // 深い入れ子にも対応できるよう、内側の要素から先に処理されるよう逆順にする
  const containerBlocks = allBlocks.filter((el) => el.querySelector("ul, ol, table")).reverse();

  await runWithConcurrency(leafBlocks, TRANSLATE_CONCURRENCY, translateInlineContent);

  for (const el of containerBlocks) {
    await translateInlineContent(el);
  }
}

// 要素直下の子ノードだけを対象に翻訳する。
// <a> などのインライン要素はトークン(⟦0⟧など)に置き換えて翻訳対象から保護し、
// 翻訳後に元の HTML(英語の固有名詞リンクなど)へ戻す。
// ul/ol/table などのブロック子要素に到達したら、それ以降は翻訳せずそのまま末尾に残す。
async function translateInlineContent(el) {
  const tokens = [];
  const tailNodes = [];
  let template = "";
  let sawBlockChild = false;

  for (const node of Array.from(el.childNodes)) {
    if (sawBlockChild) {
      tailNodes.push(node);
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      template += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (/^(UL|OL|TABLE)$/.test(node.tagName)) {
        sawBlockChild = true;
        tailNodes.push(node);
      } else {
        const index = tokens.length;
        tokens.push(node.outerHTML);
        template += `⟦${index}⟧`;
      }
    }
  }

  const hasTranslatableText = template.replace(/⟦\d+⟧/g, "").trim().length > 0;
  const translated = hasTranslatableText
    ? await translateWithCache(applyPreTranslateGlossary(template))
    : template;
  const inlineHtml = translated.replace(/⟦(\d+)⟧/g, (_, i) => tokens[Number(i)] ?? "");
  const tailHtml = tailNodes
    .map((node) => (node.nodeType === Node.ELEMENT_NODE ? node.outerHTML : node.textContent))
    .join("");

  el.innerHTML = inlineHtml + tailHtml;
}

function applyPreTranslateGlossary(text) {
  return TRANSLATE_PRE_REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text
  );
}

async function translateWithCache(text) {
  if (translateCache.has(text)) {
    return translateCache.get(text);
  }
  try {
    const translated = await translateText(text);
    translateCache.set(text, translated);
    return translated;
  } catch (err) {
    console.warn("翻訳に失敗したため原文のまま表示します:", err);
    return text;
  }
}

async function translateText(text) {
  const url = new URL(TRANSLATE_ENDPOINT);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", "ja");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`翻訳APIへの通信に失敗しました(HTTP ${response.status})`);
  }
  const data = await response.json();
  const segments = data?.[0] ?? [];
  return segments.map((segment) => segment[0]).join("");
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
      th.textContent = INFOBOX_LABEL_MAP[item.label] || item.label;
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
