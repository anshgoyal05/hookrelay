# HookRelay: Operational Runbook

## 1. Local Development Setup

### Prerequisites
- Node.js >= 22 (Node 24 recommended)
- Docker & Docker Compose
- npm >= 10

### Quickstart Commands
```bash
# 1. Install dependencies
npm install

# 2. Start local infrastructure (Postgres 16, Redis 7, RabbitMQ 3)
make up

# 3. Copy environment configuration
cp .env.example .env

# 4. Run tests and type verification
make verify

# 5. Start API server in development mode
npm run dev:api

# 6. Start Worker process in development mode
npm run dev:worker
```

## 2. Infrastructure Services
| Service | Image | Local Port | Healthcheck | Credentials / Path |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL** | `postgres:16-alpine` | `5432` | `pg_isready -U postgres` | `postgres:postgres` / `hookrelay` |
| **Redis** | `redis:7-alpine` | `6379` | `redis-cli ping` | Default (no auth in dev) |
| **RabbitMQ** | `rabbitmq:3-management-alpine` | `5672` (AMQP)<br>`15672` (UI) | `rabbitmq-diagnostics -q ping` | `guest:guest` |

RabbitMQ Management Dashboard: [http://localhost:15672](http://localhost:15672)

## 3. Operational Checks & Troubleshooting

### Readiness Probe Failure (`GET /readyz` returns 503)
1. Inspect the response body:
   ```bash
   curl -i http://localhost:3000/readyz
   ```
   Check which component is marked `"down"` in `checks`.
2. Inspect Docker container status:
   ```bash
   docker compose -f infra/docker-compose.yml ps
   ```
3. Check container logs:
   ```bash
   docker compose -f infra/docker-compose.yml logs postgres
   docker compose -f infra/docker-compose.yml logs redis
   docker compose -f infra/docker-compose.yml logs rabbitmq
   ```

### Worker Process Startup
The worker process emits a structured JSON line on successful connection:
```json
{"level":"info","time":"2026-11-14T17:30:00.000Z","service":"worker","status":"connected","postgres":"ok","redis":"ok","rabbitmq":"ok","msg":"worker_ready"}
```
If any dependency fails, it logs a fatal error and terminates with exit code 1.
