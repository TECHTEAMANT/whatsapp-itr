# WhatsApp ITR Microservice

A production-ready WhatsApp automation microservice built with **Node.js**, **TypeScript**, and **Baileys**. It provides a REST API to manage WhatsApp sessions via QR code, send messages, send PDFs, and process bulk Excel uploads — all backed by a **BullMQ** job queue, **PostgreSQL**, and **Redis**.

---

## Features

- 📱 **QR-based WhatsApp login** — scan a QR code to connect a WhatsApp session
- 🔄 **Auto-reconnect** — sessions automatically reconnect on server restart
- 📄 **PDF Sending** — send PDF documents to any WhatsApp number via URL or Base64
- 💬 **Text Messaging** — send text messages to individual numbers or groups
- 📊 **Excel Bulk Messaging** — upload an Excel file to send messages to multiple numbers at once
- 👥 **Group Fetching** — list all WhatsApp groups the connected account is part of
- 🔒 **API Key Authentication** — all routes are protected via an API key middleware
- ⚙️ **BullMQ Job Queue** — messages are sent in the background via a Redis-backed queue
- 🐳 **Dockerised** — multi-stage Docker build for lean production images
- 🚀 **CI/CD** — automated build & deploy to Azure VM via GitHub Actions

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript |
| WhatsApp | [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) |
| Web Framework | Express.js |
| Job Queue | BullMQ + Redis |
| Database | PostgreSQL (via `pg`) |
| Containerisation | Docker, Docker Compose |
| CI/CD | GitHub Actions → Azure VM |

---

## Project Structure

```
src/
├── api/
│   ├── controllers/
│   │   └── whatsappController.ts   # Route handlers
│   ├── middlewares/
│   │   └── auth.ts                 # API key middleware
│   └── routes/
│       └── whatsappRoutes.ts       # Express router
├── config/
│   └── env.ts                      # Environment config
├── database/
│   ├── connection.ts               # PostgreSQL pool
│   └── redis.ts                    # Redis client
├── queue/
│   ├── producer.ts                 # BullMQ job producer
│   └── worker.ts                   # BullMQ background worker
├── services/
│   └── whatsapp/
│       ├── sessionManager.ts       # Baileys session init & reconnect
│       └── messageSender.ts        # PDF & text send logic
└── utils/
    └── logger.ts                   # Pino logger
```

---

## API Endpoints

All routes are prefixed with `/api/whatsapp` and require an `x-api-key` header.

### Session

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/session/start` | Start a new WhatsApp session, returns a QR code (Base64 image) |
| `GET` | `/session/status/:userId` | Get connection status and connected phone number |

**`POST /session/start`** — Body:
```json
{ "userId": "user_123" }
```
Response (QR ready):
```json
{ "status": "qr_ready", "qr": "data:image/png;base64,..." }
```
Response (already connected):
```json
{ "status": "connected", "message": "Session is already active" }
```

**`GET /session/status/:userId`** — Response:
```json
{
  "status": "CONNECTED",
  "connectedNumber": "+919876543210"
}
```

---

### Messaging

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/messages/send-pdf` | Queue a PDF document to a WhatsApp number |
| `POST` | `/messages/send-text` | Queue a text message to a WhatsApp number |

**`POST /messages/send-pdf`** — Body:
```json
{
  "userId": "user_123",
  "targetNumber": "919876543210",
  "pdfUrl": "https://example.com/file.pdf",
  "caption": "Your document",
  "fileName": "document.pdf"
}
```

**`POST /messages/send-text`** — Body:
```json
{
  "userId": "user_123",
  "targetNumber": "919876543210",
  "message": "Hello!"
}
```

---

### Groups & Bulk

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/groups/:userId` | Fetch all WhatsApp groups for the connected session |
| `POST` | `/excel` | Upload an Excel file to bulk-send messages (multipart/form-data) |

**`POST /excel`** — Form Data:
- `userId` — the session user ID
- `file` — `.xlsx` file with **Column A = Phone Number**, **Column B = Message**

> Use `[Link]` anywhere in the message column to auto-inject a personalised upload link.

---

### Health Check

```
GET /health
```
```json
{ "status": "ok", "message": "WhatsApp Service is running" }
```

---

## Environment Variables

Create a `.env` file in the project root:

```env
# App
NODE_ENV=production
PORT=3000
API_KEY=your_secret_api_key
ALLOWED_ORIGINS=https://yourfrontend.com

# PostgreSQL
DB_HOST=postgres
DB_PORT=5432
DB_USER=wa_user
DB_PASSWORD=wa_pass
DB_NAME=whatsapp_db
POSTGRES_USER=wa_user
POSTGRES_PASSWORD=wa_pass
POSTGRES_DB=whatsapp_db

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Other
JWT_SECRET=your_jwt_secret
BACKEND_API_URL=https://your-backend-api.com
```

---

## Running Locally

### Prerequisites
- Node.js 20+
- Docker & Docker Compose

### Development (with hot reload)

```bash
npm install
npm run dev
```

### Docker Compose (full stack)

```bash
docker compose up --build
```

This starts:
- `whatsapp-api` on port `3000`
- `postgres` on port `5433`
- `redis` on port `6379`

---

## Deployment

The project uses a **GitHub Actions** CI/CD pipeline (`.github/workflows/deploy.yml`) that:

1. **Builds** a multi-stage Docker image and pushes it to **GitHub Container Registry (GHCR)** tagged as `latest`
2. **SSHes** into the Azure VM, pulls the new image, and restarts the containers via `docker compose up -d`

Triggered automatically on every push to `main`, or manually via the GitHub Actions UI.

### Required GitHub Secrets

| Secret | Description |
|---|---|
| `AZURE_VM_HOST` | Azure VM public IP or hostname |
| `AZURE_VM_USERNAME` | SSH username |
| `AZURE_VM_SSH_KEY` | Private SSH key |
| `GHCR_PAT` | GitHub Personal Access Token with `packages:write` |

---

## Database

The service auto-initialises the required PostgreSQL table on startup. Sessions are persisted in `users_whatsapp_sessions`:

| Column | Type | Description |
|---|---|---|
| `user_id` | `TEXT` | Unique user identifier |
| `whatsapp_number` | `TEXT` | Connected phone number |
| `session_status` | `TEXT` | `CONNECTED`, `DISCONNECTED`, `RECONNECTING` |
| `updated_at` | `TIMESTAMP` | Last status change |

WhatsApp auth credentials are stored locally in the `sessions/<userId>/` directory and mounted as a Docker volume.

---

## License

Private — internal use only.