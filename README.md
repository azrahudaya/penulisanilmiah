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
