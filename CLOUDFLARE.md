# LIVAI + Cloudflare Tunnel — máy nhà làm server 24/7

Hướng dẫn để máy của bạn chạy LIVAI liên tục, máy khác truy cập qua Internet **không cần mở port router**.

## Luồng hoạt động

```text
Máy khác (browser)
        │  https://livai.ten-ban.com
        ▼
Cloudflare edge
        │  Cloudflare Tunnel (mã hóa)
        ▼
Máy bạn (luôn bật)
  cloudflared  →  127.0.0.1:5173 (server.py)  →  Ollama :11434
```

Không cần IP public cố định. Không cần port-forward trên router.

---

## 0. Cảnh báo bảo mật (đọc trước)

LIVAI **chưa có đăng nhập / mật khẩu**. Ai biết URL là chat được và đọc được lịch sử trong `livai.db`.

Khuyến nghị:

1. Chỉ dùng URL riêng, **không đăng** lên mạng xã hội.
2. Bật **Cloudflare Access** (free) — bắt login email trước khi vào app (mục 6).
3. Chỉ chia sẻ cho người tin tưởng.

---

## 1. Chuẩn bị trên máy server (máy nhà)

### 1.1 Phần cứng / mạng

- Máy **không tắt nguồn**, có điện ổn định (nên dùng UPS nếu hay mất điện).
- Internet ổn định (wifi OK, dây LAN tốt hơn).
- Tắt sleep / Hibernate (mục 7).

### 1.2 Chạy LIVAI local trước

```bash
# Terminal 1 — Ollama (Linux thường đã chạy sẵn)
ollama list
# nếu lỗi kết nối:
ollama serve

# Terminal 2 — UI
cd ~/Desktop/LIVAI
python3 server.py
```

Mở [http://127.0.0.1:5173](http://127.0.0.1:5173) trên chính máy đó — chat được rồi mới làm Cloudflare.

### 1.3 Tài khoản Cloudflare

1. Đăng ký / đăng nhập: [https://dash.cloudflare.com](https://dash.cloudflare.com)
2. **Nên có domain** (ví dụ mua ở Cloudflare / Namecheap rồi add vào Cloudflare) để URL cố định kiểu `livai.tenban.com`.
3. Không có domain: dùng **Quick Tunnel** (URL dạng `*.trycloudflare.com`, **đổi mỗi lần restart** — chỉ hợp test).

---

## 2. Cài `cloudflared`

### Linux (Debian/Ubuntu/Fedora/Arch — script chính thức)

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

Nếu máy ARM (Raspberry Pi):

```bash
# thay amd64 bằng arm64 nếu cần
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
```

Hoặc xem bản mới nhất: [cloudflared releases](https://github.com/cloudflare/cloudflared/releases).

### macOS

```bash
brew install cloudflared
```

### Windows

Tải `cloudflared-windows-amd64.exe` từ [releases](https://github.com/cloudflare/cloudflared/releases), đổi tên thành `cloudflared.exe`, thêm vào PATH.

---

## 3. Cách A — Quick Tunnel (test nhanh, 2 phút)

Chỉ để thử “máy khác vào được chưa”. URL **đổi mỗi lần** chạy lại.

Giữ `python3 server.py` đang chạy, mở terminal mới:

```bash
cloudflared tunnel --url http://127.0.0.1:5173
```

Terminal sẽ in URL dạng:

```text
https://random-words-xxxx.trycloudflare.com
```

Mở URL đó trên điện thoại / máy khác (cùng hoặc khác mạng). Nếu chat được → tunnel OK.

**Không dùng cách này cho 24/7** vì URL không cố định.

---

## 4. Cách B — Named Tunnel + domain (khuyên dùng cho 24/7)

### 4.1 Login Cloudflare

```bash
cloudflared tunnel login
```

Trình duyệt mở → chọn domain bạn muốn dùng (domain phải đã nằm trong Cloudflare).

File chứng chỉ lưu tại `~/.cloudflare/cert.pem`.

### 4.2 Tạo tunnel

```bash
cloudflared tunnel create livai
```

Ghi lại **Tunnel ID** (UUID) in ra. Credential file thường nằm:

```text
~/.cloudflared/<TUNNEL_ID>.json
```

Liệt kê tunnel:

```bash
cloudflared tunnel list
```

### 4.3 File cấu hình

Tạo file `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<USER>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: livai.ten-ban.com
    service: http://127.0.0.1:5173
  - service: http_status:404
```

Thay:

- `<TUNNEL_ID>` — UUID từ bước 4.2  
- `<USER>` — user Linux của bạn (vd `d-anh92`)  
- `livai.ten-ban.com` — subdomain thật của bạn  

### 4.4 Trỏ DNS về tunnel

```bash
cloudflared tunnel route dns livai livai.ten-ban.com
```

Hoặc trong Cloudflare Dashboard → DNS → thêm bản ghi **CNAME**:

| Type  | Name  | Target                         | Proxy |
|-------|-------|--------------------------------|-------|
| CNAME | livai | `<TUNNEL_ID>.cfargotunnel.com` | Proxied (cam) |

### 4.5 Chạy tunnel thử

```bash
# Ollama + server.py phải đang chạy
cloudflared tunnel run livai
```

Mở `https://livai.ten-ban.com` từ máy khác.

---

## 5. Chạy 24/7 bằng systemd (Linux)

Mục tiêu: sau reboot, Ollama / LIVAI / tunnel tự lên lại.

### 5.1 Ollama

Nếu đã cài bằng `install.sh`, thường đã có service:

```bash
systemctl status ollama
# nếu chưa enable:
sudo systemctl enable --now ollama
```

### 5.2 Service `livai` (server.py)

```bash
sudo tee /etc/systemd/system/livai.service >/dev/null <<'EOF'
[Unit]
Description=LIVAI chat UI
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=REPLACE_USER
WorkingDirectory=/home/REPLACE_USER/Desktop/LIVAI
ExecStart=/usr/bin/python3 /home/REPLACE_USER/Desktop/LIVAI/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

Sửa `REPLACE_USER` (vd `d-anh92`), rồi:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now livai
sudo systemctl status livai
```

### 5.3 Service Cloudflare Tunnel

Cách nhanh (Cloudflare cài service sẵn):

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

`service install` dùng `~/.cloudflared/config.yml` của user chạy lệnh (thường cần chạy với user đã `tunnel login`, hoặc copy config vào `/etc/cloudflared/`).

Nếu dùng `/etc/cloudflared/config.yml`:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/
# sửa credentials-file trong config trỏ tới /etc/cloudflared/<TUNNEL_ID>.json
sudo systemctl enable --now cloudflared
```

### 5.4 Kiểm tra sau reboot

```bash
sudo reboot
# sau khi máy lên lại:
curl -sI http://127.0.0.1:5173 | head
systemctl is-active ollama livai cloudflared
```

Từ máy khác mở `https://livai.ten-ban.com`.

---

## 6. (Khuyến nghị) Cloudflare Access — khóa cổng bằng email

1. Dashboard → **Zero Trust** → bắt đầu free team.  
2. **Access** → **Applications** → **Add an application** → **Self-hosted**.  
3. Application domain: `livai.ten-ban.com`.  
4. Policy: Allow → Include → Emails → thêm email được phép (vd Gmail của bạn và người nhà).  
5. Save.

Lần sau mở URL sẽ bắt xác thực email (OTP / login) trước khi vào LIVAI.

---

## 7. Máy không sleep (quan trọng)

### Linux (GNOME)

Settings → Power → **Automatic Suspend** = Off (khi cắm điện).

Hoặc:

```bash
# chặn suspend khi cắm AC (systemd)
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

> Chỉ mask nếu bạn chắc muốn máy luôn thức. Muốn bỏ: `sudo systemctl unmask ...`

### Laptop

- Cắm sạc thường xuyên.  
- Settings → Power → khi đóng nắp: **Do nothing** / không sleep (nếu dùng laptop làm server).  
- Tắt Wi‑Fi power saving nếu mạng hay đứt.

### Router / ISP

- Tắt “AP Isolation / Client Isolation” nếu test LAN.  
- Tunnel Cloudflare **không cần** mở port WAN.

---

## 8. Checklist “máy khác truy cập được”

| Bước | OK? |
|------|-----|
| `ollama list` chạy được trên máy nhà | ☐ |
| `python3 server.py` / `systemctl status livai` active | ☐ |
| Local mở được http://127.0.0.1:5173 | ☐ |
| `cloudflared tunnel run livai` / service active | ☐ |
| DNS `livai.ten-ban.com` Proxied trên Cloudflare | ☐ |
| Máy khác mở `https://...` chat được | ☐ |
| (Tuỳ chọn) Cloudflare Access bật | ☐ |
| Sleep đã tắt + enable systemd | ☐ |

---

## 9. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|------------|------------|
| Tunnel OK nhưng chat lỗi “Ollama chưa chạy” | `systemctl start ollama` hoặc `ollama serve` |
| 502 / Bad gateway trên Cloudflare | `server.py` chưa chạy hoặc sai port trong `config.yml` |
| DNS không resolve | Chờ vài phút; kiểm tra CNAME Proxied |
| Chỉ máy nhà vào được, máy ngoài không | Đang mở `127.0.0.1` trực tiếp — phải dùng URL `https://...` của tunnel |
| URL trycloudflare đổi | Chuyển sang Named Tunnel (mục 4) |
| Reboot là mất | Thiếu `systemctl enable` cho `livai` / `cloudflared` / `ollama` |
| Model chậm / timeout | Máy yếu hoặc model lớn — thử `llama3.2:1b` |

---

## 10. Tắt tạm thời / gỡ

```bash
sudo systemctl stop cloudflared livai
# hoặc xóa tunnel:
cloudflared tunnel delete livai
```

Xóa DNS CNAME `livai` trên Cloudflare Dashboard nếu không dùng nữa.

---

## Tóm tắt lệnh tối thiểu (đã setup xong)

```bash
# một lần: login + create + DNS + config.yml + systemd (mục 4–5)

# hàng ngày: gần như không làm gì — máy bật là đủ
# kiểm tra nhanh:
systemctl status ollama livai cloudflared
```

Máy khác chỉ cần mở: `https://livai.ten-ban.com`
