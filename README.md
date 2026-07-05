# Penulisan Ilmiah Reminder Bot

WhatsApp reminder bot for voice-note based task extraction. Users send a voice note or text, confirm the detected reminder through a WhatsApp poll, and receive reminders automatically.

Try the bot:

```text
https://bot.azrahudaya.me
```

Repository:

```text
https://github.com/azrahudaya/penulisanilmiah
```

## Features

- Short onboarding: consent, name, gender.
- Reminder creation from WhatsApp voice notes or free text.
- WhatsApp poll confirmation before saving a reminder.
- Default reminders: 10 minutes before and at the deadline.
- Missed reminder recovery after server restart.
- Admin dashboard for research review, respondents, export, backup, and operations status.

## Tech Stack

- Node.js
- whatsapp-web.js
- SQLite
- Express + EJS
- OpenAI Whisper/GPT, with local/rule-based fallback options

## Requirements

- Node.js 18+
- npm
- A WhatsApp account for the bot
- OpenAI API key, or a local Whisper setup

## Quick Start

```bash
git clone https://github.com/azrahudaya/penulisanilmiah.git
cd penulisanilmiah
npm install
cp .env.example .env
```

Edit `.env`:

```env
OPENAI_API_KEY=your_openai_key
TIMEZONE=Asia/Jakarta
DB_PATH=./data/tasks.db
RESEARCH_MODE=true
ADMIN_PHONE=628xxxxxxxxxx
DASHBOARD_PASSWORD=change-this
ADMIN_SESSION_SECRET=change-this-random-32-char-secret
TRANSCRIPTION_PROVIDER=openai
TASK_PARSER_PROVIDER=auto
OPENAI_WHISPER_MODEL=whisper-1
```

Run the WhatsApp bot:

```bash
npm start
```

Run the admin dashboard:

```bash
npm run admin
```

Local dashboard:

```text
http://localhost:3000
```

On first run, scan the WhatsApp QR code shown in the terminal.

## VPS Deploy

Install basic tools:

```bash
sudo apt update
sudo apt install -y git curl nginx chromium
sudo npm install -g pm2
```

Use system Chromium:

```env
CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ADMIN_COOKIE_SECURE=true
```

Run with PM2:

```bash
pm2 start src/index.js --name reminderbot
pm2 start admin/server.js --name reminderbot-admin
pm2 save
```

## User Commands

```text
help
list
done <id>
delete <id>
reschedule <id> <YYYY-MM-DD HH:mm>
profile
editdata
deletedata confirm
```

## Research Data

When research mode is enabled, the app stores:

- respondent profile
- voice note audio
- transcription
- extracted reminder
- review metrics

Users can delete their data from WhatsApp with:

```text
deletedata confirm
```

## GitHub Banner

Recommended repository social preview image:

```text
1280 x 640 px
PNG/JPG/GIF
Under 1 MB
```

Keep the main text centered with enough margin. Suggested copy:

```text
Penulisan Ilmiah
WhatsApp Voice Note Reminder Bot
```

Upload it from GitHub repository Settings -> Social preview.

## Roadmap

- WhatsApp session status in the admin dashboard.
- Daily automatic backup for SQLite and audio files.
- Anonymous CSV export without names or WhatsApp numbers.
- Review queue that jumps to the next pending item after save.
- Error-code summary in the admin dashboard.
