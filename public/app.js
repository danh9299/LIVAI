const MODEL = "llama3.2";

const els = {
  welcome: document.getElementById("welcome"),
  thread: document.getElementById("thread"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  error: document.getElementById("error"),
  newChat: document.getElementById("new-chat"),
  modelLabel: document.getElementById("model-label"),
};

els.modelLabel.textContent = MODEL;

/** @type {{ role: "user" | "assistant", content: string }[]} */
let messages = [];
let streaming = false;
/** @type {AbortController | null} */
let abortController = null;

function uid() {
  return crypto.randomUUID();
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

function renderEmpty() {
  const empty = messages.length === 0;
  els.welcome.hidden = !empty;
  els.thread.hidden = empty;
  els.newChat.hidden = empty;
  if (empty) els.thread.innerHTML = "";
}

/**
 * @param {"user" | "assistant"} role
 * @param {string} content
 * @param {string} id
 */
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

/**
 * @param {string} id
 * @param {string} content
 */
function updateBubble(id, content) {
  const article = els.thread.querySelector(`[data-id="${id}"]`);
  if (!article) return;
  const body = article.querySelector(".body");
  if (!body) return;
  body.textContent = content;
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || streaming) return;

  showError("");
  els.input.value = "";
  resizeInput();

  messages.push({ role: "user", content: text });
  renderEmpty();
  appendBubble("user", text, uid());

  const assistantId = uid();
  messages.push({ role: "assistant", content: "" });
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
        messages: messages.slice(0, -1),
      }),
      signal: abortController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(
        `Ollama lỗi ${res.status}. Kiểm tra đã chạy \`ollama pull llama3.2\` chưa.`
      );
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
        messages[messages.length - 1].content = full;
        updateBubble(assistantId, full);
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      if (!messages[messages.length - 1]?.content) {
        messages.pop();
        const node = els.thread.querySelector(`[data-id="${assistantId}"]`);
        node?.remove();
      }
    } else {
      const msg = e instanceof Error ? e.message : "Không kết nối được Ollama.";
      showError(msg);
      if (!messages[messages.length - 1]?.content) {
        messages.pop();
        const node = els.thread.querySelector(`[data-id="${assistantId}"]`);
        node?.remove();
      }
    }
  } finally {
    abortController = null;
    setStreaming(false);
    renderEmpty();
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

els.newChat.addEventListener("click", () => {
  abortController?.abort();
  messages = [];
  showError("");
  renderEmpty();
  setStreaming(false);
});

resizeInput();
els.input.focus();
