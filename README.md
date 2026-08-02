# LIVAI

Chat AI local — offline 100% sau khi cài xong.

## A. Cài đặt (chỉ 1 lần, cần mạng)

### 1. Cài Ollama

Cài vào hệ thống máy, không phải vào thư mục LIVAI.

| OS | Lệnh |
|----|------|
| Mac | `brew install ollama` |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Windows | Tải file `.exe` trên [ollama.com](https://ollama.com) |

### 2. Tải model

```bash
ollama pull llama3.2
```

Model khác (tuỳ chọn):

```bash
ollama pull llama3.2:1b   # siêu nhẹ
ollama pull llama3.1:8b   # cân bằng
# llama3.1:70b cần RAM/GPU mạnh
```

## B. Dùng hàng ngày (offline)

1. Mở terminal trong thư mục LIVAI:

   ```bash
   cd ~/Desktop/LIVAI
   ```

2. Kiểm tra Ollama đang chạy nền:

   ```bash
   ollama list
   ```

   Có danh sách model là ổn. Linux thường đã tự chạy Ollama sau khi cài — **không cần** `ollama serve` nữa.

   Nếu `ollama list` lỗi kết nối mới chạy:

   ```bash
   ollama serve
   ```

   Báo `address already in use` (port `11434`) = Ollama **đã chạy sẵn**, bỏ qua và sang bước 3.

3. Chạy UI chat:

   ```bash
   python3 server.py
   ```

   Báo `Address already in use` (port `5173`) = còn `server.py` cũ. Giải phóng rồi chạy lại:

   ```bash
   fuser -k 5173/tcp
   python3 server.py
   ```

4. Mở trình duyệt: [http://127.0.0.1:5173](http://127.0.0.1:5173)

5. Dùng chat:
   - **Enter** — gửi
   - **Shift+Enter** — xuống dòng
   - **Dừng** — ngắt đang trả lời
   - **Đoạn chat mới** — xoá hội thoại

6. Tắt UI: `Ctrl+C` trong terminal đang chạy `server.py`

## C. Luồng hoạt động

```text
Bạn (browser)
    │  http://127.0.0.1:5173
    ▼
public/            ← giao diện (HTML/CSS/JS) — không gọi mạng ngoài
    │
server.py          ← phục vụ UI + proxy /api → Ollama
    │  localhost:11434
    ▼
Ollama + llama3.2  ← model chạy trên máy bạn
```

## D. Quản lý model

Xem model đã tải:

```bash
ollama list
```

Tải thêm model:

```bash
ollama pull llama3.2:1b
```

Xóa model:

```bash
ollama rm llama3.2
```

Chạy thử trong terminal (không qua UI):

```bash
ollama run llama3.2
```

Trong màn hình `>>>`: gõ câu hỏi để chat. `/bye` (hoặc `Ctrl+D`) chỉ **thoát chat CLI**, không tắt Ollama chạy nền.

Model lưu tại `~/.ollama` — dùng `ollama rm` để xóa sạch, không cần xóa tay.

Đổi model cho UI LIVAI: sửa hằng `MODEL` trong `public/app.js` cho khớp tên trong `ollama list` (mặc định: `llama3.2`).

## E. Ghi chú

- Offline 100%: sau bước A, mọi thứ chạy local (UI không còn tải font/CDN ngoài).
- Thư mục LIVAI chỉ chứa UI. Ollama được cài toàn hệ thống (vd Linux: `/usr/local`) vì lệnh `install.sh` luôn cài như vậy, bất kể bạn đang đứng ở thư mục nào khi gõ lệnh.
- Model lưu ở thư mục home của user (vd `~/.ollama`), không nằm trong LIVAI.
