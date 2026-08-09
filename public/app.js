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
  authGate: document.getElementById("auth-gate"),
  authForm: document.getElementById("auth-form"),
  authPassword: document.getElementById("auth-password"),
  authError: document.getElementById("auth-error"),
};

els.modelLabel.textContent = MODEL;

let chats = [];
let currentChatId = null;
let streaming = false;
let abortController = null;
let authRequired = false;

function uid() {
  return crypto.randomUUID();
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...options,
  });
  if (res.status === 401 && authRequired) {
    showAuthGate("Phiên hết hạn — nhập lại mật khẩu.");
  }
  return res;
}

function showAuthGate(message = "") {
  if (!els.authGate) return;
  els.authGate.hidden = false;
  if (els.authError) {
    if (message) {
      els.authError.hidden = false;
      els.authError.textContent = message;
    } else {
      els.authError.hidden = true;
      els.authError.textContent = "";
    }
  }
  els.authPassword?.focus();
}

function hideAuthGate() {
  if (!els.authGate) return;
  els.authGate.hidden = true;
  if (els.authError) {
    els.authError.hidden = true;
    els.authError.textContent = "";
  }
  if (els.authPassword) els.authPassword.value = "";
}

async function ensureAuth() {
  try {
    const res = await apiFetch("/api/auth/status");
    const data = await res.json();
    authRequired = !!data.authRequired;
    if (!authRequired || data.ok) {
      hideAuthGate();
      return true;
    }
    showAuthGate();
    return false;
  } catch {
    // offline / old server without auth routes
    authRequired = false;
    hideAuthGate();
    return true;
  }
}

async function login(password) {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error === "wrong password" ? "Sai mật khẩu." : "Đăng nhập thất bại.");
  }
  hideAuthGate();
  return true;
}

// --- DB API ---
async function loadChatsFromDB() {
  try {
    const res = await apiFetch("/api/chats");
    if (res.status === 401) return;
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
    await apiFetch("/api/chats", {
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
    await apiFetch(`/api/chats/${id}`, { method: "DELETE" });
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
function isMobileSidebar() {
  return window.matchMedia("(max-width: 900px)").matches;
}

function openSidebar() {
  if (!els.sidebar) return;
  els.sidebar.classList.add("open");
  els.sidebar.classList.remove("collapsed");
  if (isMobileSidebar()) els.overlay?.classList.add("open");
  else els.overlay?.classList.remove("open");
  localStorage.setItem("livai_sidebar", "open");
}

function closeSidebar({ persist = true } = {}) {
  if (!els.sidebar) return;
  els.sidebar.classList.remove("open");
  els.overlay?.classList.remove("open");
  if (!isMobileSidebar()) els.sidebar.classList.add("collapsed");
  else els.sidebar.classList.remove("collapsed");
  if (persist) localStorage.setItem("livai_sidebar", "closed");
}

function toggleSidebar() {
  if (isMobileSidebar()) {
    els.sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
    return;
  }
  els.sidebar.classList.contains("collapsed") ? openSidebar() : closeSidebar();
}

function restoreSidebar() {
  if (isMobileSidebar()) {
    closeSidebar({ persist: false });
    return;
  }
  if (localStorage.getItem("livai_sidebar") === "closed") closeSidebar();
  else openSidebar();
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
        if (isMobileSidebar()) closeSidebar();
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
  if (isMobileSidebar()) closeSidebar();
}

function thinkingMarkup() {
  const wrap = document.createElement("span");
  wrap.className = "thinking-row";
  wrap.setAttribute("aria-label", "LIVAI đang nghĩ");
  wrap.innerHTML = `
    <span class="thinking-pulse" aria-hidden="true"></span>
    <span class="thinking-label">Đang nghĩ</span>
    <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
  `;
  return wrap;
}

function typingTrailMarkup(waiting) {
  const trail = document.createElement("span");
  trail.className = waiting ? "typing-trail is-paused" : "typing-trail";
  trail.setAttribute("aria-hidden", "true");
  trail.innerHTML = `
    <span class="caret"></span>
    <span class="typing-dots"><i></i><i></i><i></i></span>
  `;
  return trail;
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
    body.classList.add("is-thinking");
    body.appendChild(thinkingMarkup());
  }
  article.append(label, body);
  els.thread.appendChild(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
  return body;
}

function updateBubble(id, content, { waiting = false } = {}) {
  const article = els.thread.querySelector(`[data-id="${id}"]`);
  if (!article) return;
  const body = article.querySelector(".body");
  if (!body) return;

  if (body.classList.contains("is-thinking")) {
    body.classList.remove("is-thinking");
  }
  body.classList.add("is-composing");
  body.classList.toggle("is-waiting", waiting);

  body.replaceChildren();
  if (content) body.append(document.createTextNode(content));
  body.appendChild(typingTrailMarkup(waiting));
  article.scrollIntoView({ block: "nearest" });
}

function finishBubble(id) {
  const article = els.thread.querySelector(`[data-id="${id}"]`);
  if (!article) return;
  const body = article.querySelector(".body");
  if (!body) return;
  body.classList.remove("is-thinking", "is-composing", "is-waiting");
  body.querySelector(".typing-trail")?.remove();
}

/** Smooth on-screen typing so pauses between Ollama chunks still feel alive. */
const typewriter = {
  id: null,
  shown: "",
  pending: "",
  networkDone: false,
  timer: null,
  onDone: null,
};

function clearTypewriter() {
  if (typewriter.timer) {
    clearTimeout(typewriter.timer);
    typewriter.timer = null;
  }
  const done = typewriter.onDone;
  typewriter.id = null;
  typewriter.shown = "";
  typewriter.pending = "";
  typewriter.networkDone = false;
  typewriter.onDone = null;
  done?.();
}

function startTypewriter(id) {
  clearTypewriter();
  typewriter.id = id;
}

function enqueueTypewriter(chunk) {
  if (!typewriter.id || !chunk) return;
  typewriter.pending += chunk;
  if (!typewriter.timer) pumpTypewriter();
}

function endTypewriterNetwork() {
  typewriter.networkDone = true;
  return new Promise((resolve) => {
    typewriter.onDone = resolve;
    if (!typewriter.id) {
      typewriter.onDone = null;
      resolve();
      return;
    }
    if (!typewriter.timer) pumpTypewriter();
  });
}

function pumpTypewriter() {
  const id = typewriter.id;
  if (!id) return;

  if (typewriter.pending.length > 0) {
    // Catch up faster when backlog is large; still animate char-by-char feel
    const backlog = typewriter.pending.length;
    const take = backlog > 80 ? 10 : backlog > 30 ? 5 : backlog > 8 ? 2 : 1;
    const slice = typewriter.pending.slice(0, take);
    typewriter.pending = typewriter.pending.slice(take);
    typewriter.shown += slice;
    updateBubble(id, typewriter.shown, { waiting: false });
    const delay = backlog > 80 ? 12 : backlog > 30 ? 16 : backlog > 8 ? 22 : 28;
    typewriter.timer = setTimeout(pumpTypewriter, delay);
    return;
  }

  if (!typewriter.networkDone) {
    // Stream still open, waiting for next tokens — keep typing indicator alive
    updateBubble(id, typewriter.shown, { waiting: true });
    typewriter.timer = null;
    return;
  }

  updateBubble(id, typewriter.shown, { waiting: false });
  finishBubble(id);
  typewriter.timer = null;
  typewriter.id = null;
  const done = typewriter.onDone;
  typewriter.onDone = null;
  done?.();
}

function flushTypewriterNow() {
  if (!typewriter.id) {
    const done = typewriter.onDone;
    typewriter.onDone = null;
    done?.();
    return;
  }
  if (typewriter.pending) {
    typewriter.shown += typewriter.pending;
    typewriter.pending = "";
  }
  if (typewriter.timer) {
    clearTimeout(typewriter.timer);
    typewriter.timer = null;
  }
  updateBubble(typewriter.id, typewriter.shown, { waiting: false });
  finishBubble(typewriter.id);
  typewriter.id = null;
  typewriter.networkDone = true;
  const done = typewriter.onDone;
  typewriter.onDone = null;
  done?.();
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
  startTypewriter(assistantId);
  setStreaming(true);
  abortController = new AbortController();

  try {
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: chat.messages.slice(0, -1),
      }),
      signal: abortController.signal,
    });

    if (res.status === 401) {
      throw new Error("Chưa đăng nhập.");
    }
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
        enqueueTypewriter(chunk);
      }
    }
    await endTypewriterNetwork();
    await saveChatToDB(chat);
    renderChatList();
  } catch (e) {
    if (e?.name === "AbortError") {
      if (!chat.messages[chat.messages.length - 1]?.content) {
        chat.messages.pop();
        clearTypewriter();
        const node = els.thread.querySelector(`[data-id="${assistantId}"]`);
        node?.remove();
      } else {
        flushTypewriterNow();
      }
    } else {
      const msg = e instanceof Error ? e.message : "Không kết nối được Ollama.";
      showError(msg);
      if (!chat.messages[chat.messages.length - 1]?.content) {
        chat.messages.pop();
        clearTypewriter();
        const node = els.thread.querySelector(`[data-id="${assistantId}"]`);
        node?.remove();
      } else {
        flushTypewriterNow();
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
els.toggleSidebar?.addEventListener("click", toggleSidebar);
els.overlay?.addEventListener("click", () => closeSidebar());
window.addEventListener("resize", () => {
  // Keep desktop/mobile modes consistent when crossing breakpoint
  if (isMobileSidebar()) {
    if (!els.sidebar.classList.contains("open")) closeSidebar({ persist: false });
  } else {
    restoreSidebar();
  }
});

els.authForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = els.authPassword?.value || "";
  try {
    await login(password);
    await bootApp();
  } catch (err) {
    showAuthGate(err instanceof Error ? err.message : "Đăng nhập thất bại.");
  }
});

async function bootApp() {
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
}

// INIT
(async () => {
  restoreSidebar();
  const ok = await ensureAuth();
  if (!ok) return;
  await bootApp();
})();
