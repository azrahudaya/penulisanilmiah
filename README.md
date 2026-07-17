# WhatsApp Voice Note Reminder Bot

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Web.js-25D366?style=flat-square&logo=whatsapp&logoColor=white)](https://wwebjs.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Whisper-412991?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/docs/guides/speech-to-text)
[![PM2](https://img.shields.io/badge/PM2-Production-2B037A?style=flat-square&logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

A WhatsApp bot that creates reminders from voice notes or text. It extracts the title and deadline, asks for confirmation through a poll, then sends reminders 10 minutes before and at the deadline.

## Features

- Voice note transcription and reminder extraction.
- **Save / Edit / Cancel** confirmation through WhatsApp polls.
- Reminder scheduling and recovery after server restarts.
- Admin dashboard for audio, transcripts, respondents, exports, backups, and operational status.
- Local SQLite storage with no external database service.

## Run Locally

Requirements: Node.js 18+, npm, FFmpeg, Chrome/Chromium, and a WhatsApp account.

```bash
git clone https://github.com/azrahudaya/penulisanilmiah.git
cd penulisanilmiah
npm install
cp .env.example .env
npm start
```

Add the minimum configuration to `.env`:

```env
OPENAI_API_KEY=
TIMEZONE=Asia/Jakarta
ADMIN_PHONE=628xxxxxxxxxx
DASHBOARD_PASSWORD=change-this-password
ADMIN_SESSION_SECRET=replace-with-a-random-string-at-least-32-characters-long
```

Scan the WhatsApp QR code shown in the terminal. Run the dashboard separately:

```bash
npm run admin
```

The local dashboard is available at `http://127.0.0.1:3000`.

## Bot Commands

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

## VPS Deployment

Production uses PM2 to keep the bot and dashboard running, with Nginx as the reverse proxy. An example configuration is available at [`deploy/reminderbot.nginx`](deploy/reminderbot.nginx).

```bash
pm2 start src/index.js --name reminderbot
pm2 start admin/server.js --name reminderbot-admin
pm2 save
```

Do not commit `.env`, WhatsApp sessions, databases, user audio, or backup files. They are already covered by `.gitignore`.
