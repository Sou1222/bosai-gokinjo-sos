const requestForm = document.getElementById("request-form");
const helperForm = document.getElementById("helper-form");
const listEl = document.getElementById("requests-list");
const helpersListEl = document.getElementById("helpers-list");
const locateBtn = document.getElementById("locate-btn");
const locateStatus = document.getElementById("locate-status");
const sortSelect = document.getElementById("sort-select");

const TOKYO_STATION = [35.681, 139.767];
const map = L.map("leaflet-map").setView(TOKYO_STATION, 15);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const lineLayer = L.layerGroup().addTo(map);

let currentLocationMarker = null;

function showCurrentLocation(lat, lng, { recenter = true } = {}) {
  const icon = L.divIcon({
    className: "current-location-marker",
    iconSize: [18, 18],
  });
  if (currentLocationMarker) {
    currentLocationMarker.setLatLng([lat, lng]);
  } else {
    currentLocationMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
      .bindPopup("📍 現在地")
      .addTo(map);
  }
  if (recenter) {
    map.setView([lat, lng], 16);
  }
}

function locateUser({ recenter = true } = {}) {
  if (!navigator.geolocation) {
    locateStatus.textContent = "この端末では現在地を取得できません";
    return;
  }
  locateStatus.textContent = "現在地を取得中...";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      showCurrentLocation(latitude, longitude, { recenter });
      locateStatus.textContent = "";
      if (sortSelect.value === "distance") {
        refresh();
      }
    },
    (err) => {
      locateStatus.textContent =
        err.code === err.PERMISSION_DENIED
          ? "位置情報の利用が許可されていません"
          : "現在地を取得できませんでした";
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

locateBtn.addEventListener("click", () => locateUser({ recenter: true }));
locateUser({ recenter: true });

// ①助けてほしい / ②協力できる タブの切り替え
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = {
  request: document.getElementById("request-panel"),
  helper: document.getElementById("helper-panel"),
};
const clickTargetHint = document.getElementById("click-target-hint");
const TAB_LABELS = { request: "🆘 助けてほしい", helper: "🤝 協力できる" };
let activeTab = "request";

function setActiveTab(tab) {
  activeTab = tab;
  for (const btn of tabButtons) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  for (const key of Object.keys(tabPanels)) {
    tabPanels[key].classList.toggle("active", key === tab);
  }
  clickTargetHint.textContent = `地図クリックで、現在選択中のタブ（${TAB_LABELS[tab]}）に座標を入力します`;
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
}

// 地図クリックで、選択中のタブのフォームに座標を入力する
map.on("click", (e) => {
  const { lat, lng } = e.latlng;
  const target = activeTab === "request" ? requestForm : helperForm;
  target.lat.value = lat.toFixed(6);
  target.lng.value = lng.toFixed(6);
});

// 各フォームの「現在地を使う」ボタン
document.querySelectorAll(".locate-form-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const form = btn.dataset.form === "request" ? requestForm : helperForm;
    if (!navigator.geolocation) {
      locateStatus.textContent = "この端末では現在地を取得できません";
      return;
    }
    locateStatus.textContent = "現在地を取得中...";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        form.lat.value = latitude.toFixed(6);
        form.lng.value = longitude.toFixed(6);
        showCurrentLocation(latitude, longitude, { recenter: true });
        locateStatus.textContent = "";
      },
      (err) => {
        locateStatus.textContent =
          err.code === err.PERMISSION_DENIED
            ? "位置情報の利用が許可されていません"
            : "現在地を取得できませんでした";
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
});

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || "エラーが発生しました");
    throw new Error("request failed");
  }
  return res.json();
}

async function postForm(url, formData) {
  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || "エラーが発生しました");
    throw new Error("request failed");
  }
  return res.json();
}

requestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await postForm("/api/requests", new FormData(requestForm));
  requestForm.reset();
  refresh();
});

helperForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await postForm("/api/helpers", new FormData(helperForm));
  helperForm.reset();
  refresh();
});

async function resolveRequest(id) {
  await postJSON(`/api/requests/${id}/resolve`, {});
  refresh();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chatButtonHtml(requestId, helperId, requestName, helperName, defaultSender) {
  return `<button type="button" class="chat-btn"
      data-request-id="${requestId}" data-helper-id="${helperId}"
      data-request-name="${escapeHtml(requestName)}" data-helper-name="${escapeHtml(helperName)}"
      data-default-sender="${defaultSender}">💬 チャット</button>`;
}

function renderList(requests) {
  listEl.innerHTML = "";
  if (requests.length === 0) {
    listEl.innerHTML = "<p>まだSOSはありません。</p>";
    return;
  }
  for (const r of requests) {
    const card = document.createElement("div");
    card.className = "request-card";
    const matchesHtml = r.matches
      .map(
        (m) => `
        <div class="match-row">
          <span>👤 ${escapeHtml(m.name)}（${escapeHtml(m.skills)}）</span>
          <span>距離 ${m.distance_km}km ・ スコア ${m.score}</span>
          ${chatButtonHtml(r.id, m.helper_id, r.name, m.name, "requester")}
        </div>`
      )
      .join("");
    const distanceHtml =
      r.distance_from_me !== undefined
        ? `<span class="badge" style="background:#2e8b57">現在地から ${r.distance_from_me}km</span>`
        : "";
    card.innerHTML = `
      <strong>${escapeHtml(r.name)}</strong>
      <span class="badge urgency-${r.urgency}">${r.urgency_label}</span>
      <span class="badge" style="background:#666">${escapeHtml(r.category)}</span>
      ${distanceHtml}
      ${r.image_url ? `<img class="card-image" src="${r.image_url}" alt="投稿画像">` : ""}
      <p>${escapeHtml(r.description)}</p>
      ${
        matchesHtml
          ? `<div><b>マッチ候補（近い順・スコア順）</b>${matchesHtml}</div>`
          : "<p><i>近隣に条件の合う協力者がまだいません</i></p>"
      }
      <button class="resolve-btn" onclick="resolveRequest(${r.id})">解決済みにする</button>
    `;
    listEl.appendChild(card);
  }
}

function renderHelperList(helpers) {
  helpersListEl.innerHTML = "";
  if (helpers.length === 0) {
    helpersListEl.innerHTML = "<p>まだ協力者の登録はありません。</p>";
    return;
  }
  for (const h of helpers) {
    const card = document.createElement("div");
    card.className = "helper-card";
    const matchedHtml = (h.matched_requests || [])
      .map(
        (mr) => `
        <div class="match-row">
          <span>🆘 ${escapeHtml(mr.name)}（${escapeHtml(mr.category)}・${mr.urgency_label}）</span>
          <span>距離 ${mr.distance_km}km ・ スコア ${mr.score}</span>
          ${chatButtonHtml(mr.request_id, h.id, mr.name, h.name, "helper")}
        </div>`
      )
      .join("");
    card.innerHTML = `
      <strong>👤 ${escapeHtml(h.name)}</strong>
      <span class="badge" style="background:${'#3874cf'}">${escapeHtml(h.skills)}</span>
      ${h.image_url ? `<img class="card-image" src="${h.image_url}" alt="登録画像">` : ""}
      ${
        matchedHtml
          ? `<div><b>対応できそうなSOS</b>${matchedHtml}</div>`
          : "<p><i>現在、対応できそうなSOSはありません</i></p>"
      }
    `;
    helpersListEl.appendChild(card);
  }
}

function drawMap(requests, helpers) {
  markerLayer.clearLayers();
  lineLayer.clearLayers();

  const helperById = {};
  for (const h of helpers) {
    helperById[h.id] = h;
    const marker = L.circleMarker([h.lat, h.lng], {
      radius: 8,
      color: "#3874cf",
      fillColor: "#3874cf",
      fillOpacity: 0.85,
      weight: 2,
    }).addTo(markerLayer);
    marker.bindPopup(
      `<b>👤 ${escapeHtml(h.name)}</b><br>協力できること: ${escapeHtml(h.skills)}` +
        (h.image_url ? `<br><img class="popup-image" src="${h.image_url}">` : "")
    );
  }

  for (const r of requests) {
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 9,
      color: "#d64545",
      fillColor: "#d64545",
      fillOpacity: 0.85,
      weight: 2,
    }).addTo(markerLayer);
    marker.bindPopup(
      `<b>🆘 ${escapeHtml(r.name)}</b>（${r.urgency_label} / ${escapeHtml(r.category)}）<br>${escapeHtml(r.description)}<br>候補: ${r.matches.length}件` +
        (r.image_url ? `<br><img class="popup-image" src="${r.image_url}">` : "")
    );

    for (const m of r.matches) {
      L.polyline(
        [
          [r.lat, r.lng],
          [m.lat, m.lng],
        ],
        { color: "#000", weight: 1, opacity: 0.25, dashArray: "4 4" }
      ).addTo(lineLayer);
    }
  }

  const allPoints = [
    ...requests.map((r) => [r.lat, r.lng]),
    ...helpers.map((h) => [h.lat, h.lng]),
  ];
  if (allPoints.length > 0) {
    map.fitBounds(allPoints, { maxZoom: 16, padding: [30, 30] });
  }
}

function buildRequestsUrl() {
  const params = new URLSearchParams({ sort: sortSelect.value });
  if (sortSelect.value === "distance" && currentLocationMarker) {
    const { lat, lng } = currentLocationMarker.getLatLng();
    params.set("lat", lat);
    params.set("lng", lng);
  }
  return `/api/requests?${params.toString()}`;
}

async function refresh() {
  const [requests, helpers] = await Promise.all([
    fetch(buildRequestsUrl()).then((r) => r.json()),
    fetch("/api/helpers").then((r) => r.json()),
  ]);
  renderList(requests);
  renderHelperList(helpers);
  drawMap(requests, helpers);
}

sortSelect.addEventListener("change", () => {
  if (sortSelect.value === "distance" && !currentLocationMarker) {
    locateUser({ recenter: false });
  }
  refresh();
});

refresh();
setInterval(refresh, 5000);

// チャット機能
const chatModal = document.getElementById("chat-modal");
const chatTitle = document.getElementById("chat-title");
const chatMessagesEl = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatSenderSelect = document.getElementById("chat-sender");
const chatInput = document.getElementById("chat-input");
const chatCloseBtn = document.getElementById("chat-close");

let currentChat = null;
let chatPollTimer = null;

function renderChatMessages(messages) {
  chatMessagesEl.innerHTML = messages.length
    ? messages
        .map(
          (m) => `
        <div class="chat-message chat-message-${m.sender}">
          <span class="chat-sender-label">${m.sender === "requester" ? "🆘 依頼者" : "🤝 協力者"}</span>
          <p>${escapeHtml(m.body)}</p>
        </div>`
        )
        .join("")
    : "<p class='hint'>まだメッセージはありません。最初のメッセージを送ってみましょう。</p>";
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function loadChatMessages() {
  if (!currentChat) return;
  const { requestId, helperId } = currentChat;
  const res = await fetch(`/api/messages?request_id=${requestId}&helper_id=${helperId}`);
  renderChatMessages(await res.json());
}

function openChat(requestId, helperId, requestName, helperName, defaultSender) {
  currentChat = { requestId, helperId };
  chatTitle.textContent = `🆘 ${requestName}  ⇔  🤝 ${helperName}`;
  chatSenderSelect.value = defaultSender || "requester";
  chatModal.classList.remove("hidden");
  loadChatMessages();
  if (chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = setInterval(loadChatMessages, 3000);
  chatInput.focus();
}

function closeChat() {
  currentChat = null;
  chatModal.classList.add("hidden");
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".chat-btn");
  if (!btn) return;
  openChat(
    Number(btn.dataset.requestId),
    Number(btn.dataset.helperId),
    btn.dataset.requestName,
    btn.dataset.helperName,
    btn.dataset.defaultSender
  );
});

chatCloseBtn.addEventListener("click", closeChat);
chatModal.addEventListener("click", (e) => {
  if (e.target === chatModal) closeChat();
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentChat) return;
  const body = chatInput.value.trim();
  if (!body) return;
  await postJSON("/api/messages", {
    request_id: currentChat.requestId,
    helper_id: currentChat.helperId,
    sender: chatSenderSelect.value,
    body,
  });
  chatInput.value = "";
  loadChatMessages();
});
