#!/usr/bin/env python3
"""Serve LIVAI chat UI and proxy /api/* to local Ollama + save chats to SQLite."""

from __future__ import annotations

import http.client
import mimetypes
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent / "public"
DB_PATH = Path(__file__).resolve().parent / "livai.db"
OLLAMA_HOST = "127.0.0.1"
OLLAMA_PORT = 11434
PORT = 5173

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

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/chats"):
            self.handle_get_chats()
            return
        if parsed.path.startswith("/api/"):
            self.proxy()
            return
        self.serve_static()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/chats"):
            self.handle_save_chats()
            return
        if parsed.path.startswith("/api/"):
            self.proxy()
            return
        self.send_error(405, "Method Not Allowed")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/chats/"):
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

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
            except:
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
                (chat["id"], chat.get("title",""), json.dumps(chat, ensure_ascii=False), chat.get("updatedAt",0))
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def serve_static(self) -> None:
        path = urlparse(self.path).path
        if path == "/": path = "/index.html"
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
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            while True:
                chunk = resp.read(4096)
                if not chunk: break
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
    if not ROOT.is_dir(): raise SystemExit(f"Missing UI folder: {ROOT}")
    with ReusableServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"LIVAI chat → http://127.0.0.1:{PORT}")
        print(f"DB luu tai: {DB_PATH}")
        print("Ctrl+C de dung")
        httpd.serve_forever()

if __name__ == "__main__":
    main()
