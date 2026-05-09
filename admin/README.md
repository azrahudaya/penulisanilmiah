# Admin Dashboard

Dashboard ini memakai Express, EJS, dan vanilla CSS/JS.

## Menjalankan

Pastikan `.env` berisi password yang kuat:

```env
DASHBOARD_PASSWORD=isi-password-kuat
ADMIN_PORT=3000
```

Lalu jalankan:

```bash
npm install
npm run admin
```

Buka:

```text
http://localhost:3000
```

## Fitur

- Overview data penelitian.
- Review audio, transcript, ground truth task, dan metrik.
- Data responden dari registrasi WhatsApp.
- Export CSV untuk log penelitian dan summary per responden.
