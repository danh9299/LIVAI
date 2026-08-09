#!/usr/bin/env python3
"""Serve LIVAI chat UI and proxy /api/* to local Ollama + save chats to SQLite."""

from __future__ import annotations

import http.client
import mimetypes
import json
import os
import secrets
import sqlite3
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent / "public"
DB_PATH = Path(__file__).resolve().parent / "livai.db"
PASSWORD_FILE = Path(__file__).resolve().parent / ".livai_password"
OLLAMA_HOST = "127.0.0.1"
OLLAMA_PORT = 11434
PORT = 5173
SESSION_TTL_SEC = 60 * 60 * 24 * 14  # 14 days
COOKIE_NAME = "livai_session"

# In-memory sessions: token -> expiry unix ts
_sessions: dict[str, float] = {}
_sessions_lock = threading.Lock()


def load_password() -> str | None:
    """Password from LIVAI_PASSWORD env, else .livai_password file. Empty = auth off."""
    env = os.environ.get("LIVAI_PASSWORD", "").strip()
    if env:
        return env
    if PASSWORD_FILE.is_file():
        pw = PASSWORD_FILE.read_text(encoding="utf-8").strip()
        return pw or None
    return None


ACCESS_PASSWORD = load_password()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT,
            data TEXT,
            updatedAt INTEGER
        )
    """)
    conn.commit()
    conn.close()


init_db()


def purge_expired_sessions() -> None:
    now = time.time()
    with _sessions_lock:
        dead = [t for t, exp in _sessions.items() if exp <= now]
        for t in dead:
            del _sessions[t]


def create_session() -> str:
    purge_expired_sessions()
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[token] = time.time() + SESSION_TTL_SEC
    return token


def revoke_session(token: str | None) -> None:
    if not token:
        return
    with _sessions_lock:
        _sessions.pop(token, None)


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    purge_expired_sessions()
    with _sessions_lock:
        exp = _sessions.get(token)
        if exp is None:
            return False
        # sliding refresh
        _sessions[token] = time.time() + SESSION_TTL_SEC
        return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _wants_secure_cookie(self) -> bool:
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        return proto == "https"

    def _session_cookie_header(self, token: str, clear: bool = False) -> str:
        parts = [
            f"{COOKIE_NAME}={'' if clear else token}",
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
        ]
        if clear:
            parts.append("Max-Age=0")
        else:
            parts.append(f"Max-Age={SESSION_TTL_SEC}")
        if self._wants_secure_cookie():
            parts.append("Secure")
        return "; ".join(parts)

    def _read_session_token(self) -> str | None:
        raw = self.headers.get("Cookie", "")
        if not raw:
            # Optional: Bearer token for curl / scripts
            auth = self.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                return auth[7:].strip() or None
            return None
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def auth_required(self) -> bool:
        return bool(ACCESS_PASSWORD)

    def is_authorized(self) -> bool:
        if not self.auth_required():
            return True
        return session_valid(self._read_session_token())

    def require_auth(self) -> bool:
        """Return True if request may proceed; otherwise send 401 and return False."""
        if self.is_authorized():
            return True
        self.send_json({"error": "unauthorized", "authRequired": True}, status=401)
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/auth/status":
            self.handle_auth_status()
            return
        if parsed.path.startswith("/api/chats"):
            if not self.require_auth():
                return
            self.handle_get_chats()
            return
        if parsed.path.startswith("/api/"):
            if not self.require_auth():
                return
            self.proxy()
            return
        self.serve_static()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/auth/login":
            self.handle_login()
            return
        if parsed.path == "/api/auth/logout":
            self.handle_logout()
            return
        if parsed.path.startswith("/api/chats"):
            if not self.require_auth():
                return
            self.handle_save_chats()
            return
        if parsed.path.startswith("/api/"):
            if not self.require_auth():
                return
            self.proxy()
            return
        self.send_error(405, "Method Not Allowed")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/chats/"):
            if not self.require_auth():
                return
            chat_id = parsed.path.split("/")[-1]
            conn = sqlite3.connect(DB_PATH)
            conn.execute("DELETE FROM chats WHERE id=?", (chat_id,))
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
            return
        self.send_error(404)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        )
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.end_headers()

    def handle_auth_status(self) -> None:
        required = self.auth_required()
        self.send_json(
            {
                "authRequired": required,
                "ok": (not required) or self.is_authorized(),
            }
        )

    def handle_login(self) -> None:
        if not self.auth_required():
            self.send_json({"ok": True, "authRequired": False})
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self.send_json({"error": "invalid json"}, status=400)
            return
        password = str(payload.get("password", ""))
        expected = (ACCESS_PASSWORD or "").encode("utf-8")
        provided = password.encode("utf-8")
        if not secrets.compare_digest(provided, expected):
            self.send_json({"error": "wrong password"}, status=401)
            return
        token = create_session()
        data = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie", self._session_cookie_header(token))
        self.end_headers()
        self.wfile.write(data)

    def handle_logout(self) -> None:
        revoke_session(self._read_session_token())
        data = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie", self._session_cookie_header("", clear=True))
        self.end_headers()
        self.wfile.write(data)

    def handle_get_chats(self):
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("SELECT data FROM chats ORDER BY updatedAt DESC")
        rows = cur.fetchall()
        conn.close()
        chats = []
        for r in rows:
            try:
                chats.append(json.loads(r[0]))
            except Exception:
                continue
        self.send_json(chats)

    def handle_save_chats(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        try:
            chat = json.loads(body)
            conn = sqlite3.connect(DB_PATH)
            conn.execute(
                "INSERT OR REPLACE INTO chats (id, title, data, updatedAt) VALUES (?,?,?,?)",
                (
                    chat["id"],
                    chat.get("title", ""),
                    json.dumps(chat, ensure_ascii=False),
                    chat.get("updatedAt", 0),
                ),
            )
            conn.commit()
            conn.close()
            self.send_json({"ok": True})
        except Exception as e:
            print(f"DB Error: {e}")
            self.send_json({"error": str(e)}, status=400)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        file_path = (ROOT / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(ROOT.resolve())) or not file_path.is_file():
            self.send_error(404, "Not Found")
            return
        content = file_path.read_bytes()
        ctype, _ = mimetypes.guess_type(str(file_path))
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def proxy(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else None
        conn = http.client.HTTPConnection(OLLAMA_HOST, OLLAMA_PORT, timeout=600)
        try:
            headers = {"Content-Type": self.headers.get("Content-Type", "application/json")}
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            self.send_header("Content-Type", resp.getheader("Content-Type", "application/x-ndjson"))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except ConnectionRefusedError:
            msg = '{"error":"Ollama chua chay. Chay: ollama serve"}'.encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
        except BrokenPipeError:
            pass
        finally:
            conn.close()


class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main() -> None:
    if not ROOT.is_dir():
        raise SystemExit(f"Missing UI folder: {ROOT}")
    print(f"LIVAI chat → http://127.0.0.1:{PORT}")
    print(f"DB luu tai: {DB_PATH}")
    if ACCESS_PASSWORD:
        print("Bao mat: BAT (LIVAI_PASSWORD hoac .livai_password) — API can dang nhap")
    else:
        print(
            "Bao mat: TAT — /api/chats ai cung doc duoc. "
            "Dat mat khau: echo 'mat-khau' > .livai_password  (hoac export LIVAI_PASSWORD=...)"
        )
    print("Ctrl+C de dung")
    with ReusableServer(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
