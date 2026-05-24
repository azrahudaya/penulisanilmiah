# Reminder Bot

WhatsApp reminder bot untuk penelitian voice note. Bot menerima VN, transkripsi dengan OpenAI Whisper API, ekstraksi reminder dengan GPT/rule-based parser, menyimpan data penelitian ke SQLite, dan menyediakan dashboard admin berbasis Express.

## Fitur

- Registrasi responden lewat WhatsApp.
- Voice note dan teks bebas untuk membuat reminder.
- Reminder default: H-10 menit dan saat deadline.
- Logging penelitian: audio WAV, transkrip, hasil ekstraksi, durasi proses, status review.
- Dashboard admin untuk overview, review data, respondent management, feedback, dan export CSV.

## Requirement

- Node.js 18+
- npm
- Akun WhatsApp untuk login WhatsApp Web
- OpenAI API key

## Setup Lokal

```bash
npm install
cp .env.example .env
```

Isi `.env` minimal:

```env
OPENAI_API_KEY=isi_api_key
TIMEZONE=Asia/Jakarta
DB_PATH=./data/tasks.db
RESEARCH_MODE=true
ADMIN_PHONE=628xxxxxxxxxx
DASHBOARD_PASSWORD=isi_password_kuat
ADMIN_SESSION_SECRET=isi_random_secret_min_32_karakter
AI_SUGGEST_RATE_LIMIT_MAX=20
AI_SUGGEST_RATE_LIMIT_WINDOW_MS=3600000
TRANSCRIPTION_PROVIDER=openai
TASK_PARSER_PROVIDER=auto
OPENAI_WHISPER_MODEL=whisper-1
```

Jalankan bot:

```bash
npm start
```

Jalankan dashboard admin:

```bash
npm run admin
```

Dashboard lokal:

```text
http://localhost:3000
```

## VPS

Install dependency dasar:

```bash
sudo apt update
sudo apt install -y git curl nginx chromium
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Jika download Chrome dari Puppeteer gagal atau koneksi VPS lambat, pakai Chromium system:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund
```

Tambahkan di `.env` VPS:

```env
CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ADMIN_COOKIE_SECURE=true
```

Jalankan proses:

```bash
pm2 start src/index.js --name reminderbot
pm2 start admin/server.js --name reminderbot-admin
pm2 save
```
