const MODEL = "llama3.2";

const els = {
  welcome: document.getElementById("welcome"),
  thread: document.getElementById("thread"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  error: document.getElementById("error"),
  newChat: document.getElementById("new-chat"),
  modelLabel: document.getElementById("model-label"),
  chatList: document.getElementById("chat-list"),
  createBtn: document.getElementById("create-chat-btn"),
  search: document.getElementById("search-chats"),
  sidebar: document.getElementById("sidebar"),
  overlay: document.getElementById("overlay"),
  toggleSidebar: document.getElementById("toggle-sidebar"),
};

els.modelLabel.textContent = MODEL;

let chats = [];
let currentChatId = null;
let streaming = false;
let abortController = null;

function uid() {
  return crypto.randomUUID();
}

// --- DB API ---
async function loadChatsFromDB() {
  try {
    const res = await fetch("/api/chats");
    if (!res.ok) throw new Error("no api");
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      chats = data;
      // also backup to localStorage
      localStorage.setItem("livai_chats", JSON.stringify(chats));
      return;
    }
    // if DB empty but localStorage has data, keep localStorage for migration
    const local = JSON.parse(localStorage.getItem("livai_chats") || "[]");
    if (local.length > 0) chats = local;
  } catch {
    // fallback to localStorage if API not available
    try {
      chats = JSON.parse(localStorage.getItem("livai_chats") || "[]");
    } catch {}
  }
}

async function saveChatToDB(chat) {
  chat.updatedAt = Date.now();
  // save local backup
  localStorage.setItem("livai_chats", JSON.stringify(chats));
  if (chat.id) localStorage.setItem("livai_current_id", chat.id);
  try {
    await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    });
  } catch (e) {
    console.warn("DB save failed, using localStorage only", e);
  }
}

async function deleteChatFromDB(id) {
  chats = chats.filter((x) => x.id !== id);
  localStorage.setItem("livai_chats", JSON.stringify(chats));
  try {
    await fetch(`/api/chats/${id}`, { method: "DELETE" });
  } catch {}
}

function getCurrentChat() {
  return chats.find((c) => c.id === currentChatId);
}

function showError(msg) {
  if (!msg) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = msg;
}
function resizeInput() {
  els.input.style.height = "0px";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}
function setStreaming(on) {
  streaming = on;
  els.input.disabled = on;
  if (on) {
    els.send.textContent = "Dừng";
    els.send.classList.add("stop");
    els.send.disabled = false;
  } else {
    els.send.textContent = "Gửi";
    els.send.classList.remove("stop");
    els.send.disabled = !els.input.value.trim();
    els.input.focus();
  }
}
function openSidebar() {
  els.sidebar?.classList.add("open");
  els.overlay?.classList.add("open");
}
function closeSidebar() {
  els.sidebar?.classList.remove("open");
  els.overlay?.classList.remove("open");
}

function renderChatList() {
  if (!els.chatList) return;
  const q = (els.search?.value || "").toLowerCase();
  els.chatList.innerHTML = "";
  chats
    .filter((c) => c.title.toLowerCase().includes(q))
    .forEach((chat) => {
      const div = document.createElement("div");
      div.className = `chat-item ${chat.id === currentChatId ? "active" : ""}`;
      div.innerHTML = `
      <div style="min-width:0">
        <div class="title">${chat.title}</div>
        <div class="meta">${new Date(chat.updatedAt).toLocaleDateString("vi-VN")}</div>
      </div>
      <div class="actions"><button class="icon-btn del" title="Xóa">✕</button></div>
    `;
      div.onclick = () => {
        currentChatId = chat.id;
        localStorage.setItem("livai_current_id", chat.id);
        renderChatList();
        renderThread();
        closeSidebar();
      };
      div.querySelector(".del").onclick = async (e) => {
        e.stopPropagation();
        if (!confirm("Xóa cuộc trò chuyện này?")) return;
        await deleteChatFromDB(chat.id);
        if (currentChatId === chat.id) currentChatId = chats[0]?.id || null;
        if (chats.length === 0) await createNewChat();
        else {
          renderChatList();
          renderThread();
        }
      };
      els.chatList.appendChild(div);
    });
}

function renderThread() {
  const chat = getCurrentChat();
  els.thread.innerHTML = "";
  if (!chat) {
    els.welcome.hidden = false;
    els.thread.hidden = true;
    els.newChat.hidden = true;
    return;
  }
  const empty = chat.messages.length === 0;
  els.welcome.hidden = !empty;
  els.thread.hidden = empty;
  els.newChat.hidden = empty;
  if (!empty) {
    chat.messages.forEach((m) => appendBubble(m.role, m.content, uid()));
  }
}

async function createNewChat() {
  const chat = {
    id: uid(),
    title: "Cuộc trò chuyện mới",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  chats.unshift(chat);
  currentChatId = chat.id;
  await saveChatToDB(chat);
  renderChatList();
  renderThread();
  closeSidebar();
}

function appendBubble(role, content, id) {
  const article = document.createElement("article");
  article.className = `bubble ${role}`;
  article.dataset.id = id;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = role === "user" ? "Bạn" : "LIVAI";
  const body = document.createElement("div");
  body.className = "body";
  if (content) {
    body.textContent = content;
  } else if (role === "assistant") {
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    body.appendChild(cursor);
  }
  article.append(label, body);
  els.thread.appendChild(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
  return body;
}
function updateBubble(id, content) {
  const article = els.thread.querySelector(`[data-id="${id}"]`);
  if (!article) return;
  const body = article.querySelector(".body");
  if (!body) return;
  body.textContent = content;
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

async function sendMessage() {
  const chat = getCurrentChat();
  if (!chat) return;
  const text = els.input.value.trim();
  if (!text || streaming) return;

  showError("");
  els.input.value = "";
  resizeInput();

  if (chat.messages.length === 0) {
    chat.title = text.slice(0, 35);
  }

  chat.messages.push({ role: "user", content: text });
  await saveChatToDB(chat);
  renderChatList();
  appendBubble("user", text, uid());

  const assistantId = uid();
  const assistantMsg = { role: "assistant", content: "" };
  chat.messages.push(assistantMsg);
  appendBubble("assistant", "", assistantId);
  setStreaming(true);
  abortController = new AbortController();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: chat.messages.slice(0, -1),
      }),
      signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama lỗi ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let json;
        try {
          json = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (json.error) throw new Error(json.error);
        const chunk = json.message?.content ?? "";
        if (!chunk) continue;
        full += chunk;
        chat.messages[chat.messages.length - 1].content = full;
        updateBubble(assistantId, full);
      }
    }
    await saveChatToDB(chat);
    renderChatList();
  } catch (e) {
    if (e?.name === "AbortError") {
      if (!chat.messages[chat.messages.length - 1]?.content) {
        chat.messages.pop();
        const node = els.thread.querySelector(`[data-id="${assistantId}"]`);
        node?.remove();
      }
    } else {
      const msg = e instanceof Error ? e.message : "Không kết nối được Ollama.";
      showError(msg);
      if (!chat.messages[chat.messages.length - 1]?.content) {
        chat.messages.pop();
        const node = els.thread.querySelector(`[data-id="${assistantId}"]`);
        node?.remove();
      }
    }
  } finally {
    abortController = null;
    setStreaming(false);
    await saveChatToDB(chat);
  }
}

els.input.addEventListener("input", () => {
  resizeInput();
  if (!streaming) els.send.disabled = !els.input.value.trim();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});
els.send.addEventListener("click", () => {
  if (streaming) {
    abortController?.abort();
    return;
  }
  void sendMessage();
});
els.newChat.addEventListener("click", () => createNewChat());
els.createBtn?.addEventListener("click", () => createNewChat());
els.search?.addEventListener("input", renderChatList);
els.toggleSidebar?.addEventListener("click", () =>
  els.sidebar.classList.contains("open") ? closeSidebar() : openSidebar(),
);
els.overlay?.addEventListener("click", closeSidebar);

// INIT
(async () => {
  await loadChatsFromDB();
  currentChatId = localStorage.getItem("livai_current_id");
  if (chats.length === 0) {
    await createNewChat();
  } else {
    if (!currentChatId || !chats.find((c) => c.id === currentChatId))
      currentChatId = chats[0].id;
    renderChatList();
    renderThread();
  }
  resizeInput();
  els.input.focus();
})();
