# 📥 Telegram Client — Browser-Based MTProto

A full-featured Telegram client running entirely in your browser. No server needed — connects directly to Telegram via MTProto WebSocket using [teleproto](https://github.com/sanyok12345/teleproto) (actively maintained GramJS fork with up-to-date TL layers).

**[Live Demo](https://tg-file-dl.pages.dev)** • **[Deploy Your Own](#deploy)**

## ✨ Features

### 🤖 Bot Mode
- Download files from Telegram via bot token — **no file size limits**
- Parallel multi-connection downloads (up to 8x faster)
- Receive incoming messages and files from your bot
- Reply to messages directly from the browser
- Paste any `t.me` link to fetch and download files

### 👤 User Mode
- **Login with phone number** — full Telegram user session
- **2FA support** — two-factor authentication works in browser
- **Multi-account** — up to 10 accounts with account switcher
- **Browse all chats** — private, groups, channels with unread counts
- **Saved Messages** — your self-chat shows as "Saved Messages"
- **Search** — find chats by name, @username, or Telegram ID
- **Send & receive messages** — real-time with new message listener
- **Photo thumbnails** — inline previews with full-size lightbox
- **Video & audio** — play button with inline player, download to disk
- **File downloads** — any file type with progress bar
- **Stealth mode** — read messages without sending read receipts
- **Auto-load photos** — configurable thumbnail auto-download

### ⚙️ Settings (separate for Bot & User mode)
- Parallel workers & chunk size configuration
- Cloudflare Proxy toggle with custom domain
- Stealth mode, auto-photos, notifications
- Send with Enter / Ctrl+Enter
- Font size options

## 🚀 Deploy

### Cloudflare Pages (Recommended)

1. Fork this repo
2. Go to [Cloudflare Pages](https://pages.cloudflare.com) → Create a project → Connect your fork
3. Build settings:
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
4. Deploy!

### Local Development

```bash
git clone https://github.com/CloudflareHackers/TGCFWorkersDLBot.git
cd TGCFWorkersDLBot
npm install
npm run dev
```

Open `http://localhost:3000`

## 🌐 Proxy Setup (Optional)

If Telegram WebSocket connections are blocked in your region, deploy the **TG-WS-API** proxy:

### One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CloudflareHackers/TG-WS-API)

> This deploys a Cloudflare Worker with Durable Objects that proxies WebSocket connections to Telegram servers. Works on the **free plan**.

### Manual Deploy

```bash
git clone https://github.com/CloudflareHackers/TG-WS-API.git
cd TG-WS-API
npm install
npx wrangler deploy
```

### Configure in the App

1. Open Settings in the web app
2. Enable **🌐 Cloudflare Proxy**
3. Enter your worker domain: `tg-ws-api.your-account.workers.dev`
4. Save — all Telegram connections now route through your proxy

### Free vs Paid Proxy Plan

The proxy works on the **free Cloudflare plan** by default (SQLite-backed Durable Objects).

For heavy usage, upgrade to the **Workers Paid plan** ($5/month)

**Paid plan benefits:** 10M+ requests/month, 1M+ DO operations, global low-latency, no daily limits, detailed analytics.

## 🔐 Default API Credentials

The app comes pre-filled with Telegram Web's public API credentials:
- **API ID:** `1025907`
- **API Hash:** `452b0359b988148995f22ff0f4229750`

You can use your own from [my.telegram.org](https://my.telegram.org) → API Development Tools.

## 🏗️ Architecture

```
Browser (teleproto MTProto)
  ↓ WebSocket (direct or via CF Proxy)
Telegram Servers (DC1-DC5)
```

- **No backend server** — everything runs client-side in the browser
- **Sessions stored in localStorage** — never leaves your device
- **IndexedDB** for message/file history persistence
- **teleproto** for MTProto protocol (maintained fork of GramJS with latest TL layers)
- **Vite** for bundling with tree-shaking
- **Custom browser shims** — AES-256 crypto, zlib inflate, WebSocket transport

## 📦 Tech Stack

| Component | Technology |
|-----------|-----------|
| MTProto Client | [teleproto](https://github.com/sanyok12345/teleproto) (maintained GramJS fork) |
| Build Tool | [Vite](https://vitejs.dev) |
| Hosting | [Cloudflare Pages](https://pages.cloudflare.com) |
| Proxy (optional) | [Cloudflare Workers + Durable Objects](https://github.com/CloudflareHackers/TG-WS-API) |
| Crypto | Pure-JS AES-256 + Web Crypto API (SHA-256, PBKDF2) |
| Storage | localStorage + IndexedDB |

## 🔒 Security

- All processing happens in your browser
- Credentials and sessions never leave your device
- No server-side data collection
- Open source — audit the code yourself

## 📄 License

MIT
