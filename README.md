# WhatsApp Voice Note Reminder Bot

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Web.js-25D366?style=flat-square&logo=whatsapp&logoColor=white)](https://wwebjs.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Whisper-412991?style=flat-square&logo=openai&logoColor=white)](https://platform.openai.com/docs/guides/speech-to-text)
[![PM2](https://img.shields.io/badge/PM2-Production-2B037A?style=flat-square&logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

Bot WhatsApp untuk membuat pengingat dari voice note atau teks. Bot mengekstrak judul dan tenggat, meminta konfirmasi lewat polling, lalu mengirim pengingat 10 menit sebelum dan saat deadline.

## Fitur

- Transkripsi voice note dan parsing pengingat.
- Konfirmasi **Simpan / Edit / Batal** melalui polling WhatsApp.
- Penjadwalan dan pemulihan reminder setelah server restart.
- Dashboard admin untuk audio, transkrip, responden, ekspor, backup, dan status operasional.
- SQLite sebagai penyimpanan lokal tanpa layanan database tambahan.

## Menjalankan Lokal

Persyaratan: Node.js 18+, npm, FFmpeg, Chrome/Chromium, dan akun WhatsApp.

```bash
git clone https://github.com/azrahudaya/penulisanilmiah.git
cd penulisanilmiah
npm install
cp .env.example .env
npm start
```

Isi konfigurasi minimum di `.env`:

```env
OPENAI_API_KEY=
TIMEZONE=Asia/Jakarta
ADMIN_PHONE=628xxxxxxxxxx
DASHBOARD_PASSWORD=ganti-password-ini
ADMIN_SESSION_SECRET=ganti-dengan-string-acak-minimal-32-karakter
```

Scan QR WhatsApp yang muncul di terminal. Jalankan dashboard secara terpisah:

```bash
npm run admin
```

Dashboard lokal tersedia di `http://127.0.0.1:3000`.

## Perintah Bot

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

## Deployment VPS

Production menggunakan PM2 untuk menjaga proses bot dan dashboard tetap aktif, serta Nginx sebagai reverse proxy. Contoh konfigurasi tersedia di [`deploy/reminderbot.nginx`](deploy/reminderbot.nginx).

```bash
pm2 start src/index.js --name reminderbot
pm2 start admin/server.js --name reminderbot-admin
pm2 save
```

Jangan commit `.env`, sesi WhatsApp, database, audio pengguna, atau file backup. Semuanya sudah tercakup dalam `.gitignore`.
