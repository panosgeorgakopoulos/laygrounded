<div align="center">
  
# 🌊 LayGrounded

**The Tier-1 AI-Powered Laytime & Demurrage Claims Engine**

[![Next.js](https://img.shields.io/badge/Next.js-16_App_Router-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Auth_%26_DB-3ECF8E?style=for-the-badge&logo=supabase)](https://supabase.com/)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude_3.5_Sonnet-D97757?style=for-the-badge&logo=anthropic)](https://www.anthropic.com/)
[![Docker](https://img.shields.io/badge/Docker-Alpine_%2B_Caddy-2496ED?style=for-the-badge&logo=docker)](https://www.docker.com/)

[Features](#-features) • [Architecture](#-tier-1-architecture) • [Quick Start](#-quick-start) • [Deployment](#-deployment) • [Contributing](#-contributing)

</div>

---

LayGrounded is an enterprise-grade SaaS platform built for the global dry bulk shipping industry. It autonomously ingests PDF Statements of Facts (SoF), extracts events using highly-resilient Vision-Language Models (VLMs), and processes them through a deterministic, hour-by-hour GENCON 94 rules engine to calculate precise demurrage and despatch financial totals.

## ✨ Features

- **Resilient AI Extraction pipeline:** Utilizes Anthropic's Claude to parse unstructured SoF documents. Features a fortified `withRetry` circuit breaker, jittered exponential backoff for rate limits, and zero-trust confidence gates.
- **Deterministic Rules Engine:** Implements deep GENCON 94 hour-by-hour logic. Fully handles NOR validation, standard/SHEX turn time, working-hour advancement, and complex operational window detection.
- **Intelligent Clause Flagging:** Automatically audits event chronologies and flags ambiguous triggers (e.g., NOR tendered at anchorage, shifting prior to ALL_FAST) based on standard maritime spec rules.
- **Enterprise Data Layer:** Leverages strict PostgreSQL compound indexing and hyper-optimized Supabase Row Level Security (RLS) policies evaluated in-memory via custom JWT Auth Hooks.
- **Modern Streaming UI:** Built heavily on React Server Components (RSC) and Suspense boundaries for zero-waterfall, instant data table renders with a polished financial terminal aesthetic.

---

## 🏗 Tier-1 Architecture

LayGrounded is heavily optimized for zero-downtime SaaS production:

- **Frontend/API:** Next.js 16 (App Router, Turbopack, standalone output optimized for Node.js Alpine).
- **Styling:** Tailwind CSS + custom shadcn/ui components utilizing Space Grotesk & JetBrains Mono typography.
- **Database & Auth:** Supabase (PostgreSQL) with strictly typed schema generation and isolated tenant architectures.
- **Infrastructure:** Docker Compose orchestrated stack featuring a hardened Caddy reverse proxy (Zstandard compression, strict HSTS/CSP security headers).
- **Telemetry:** Structured JSON global error boundaries designed for direct ingestion into Datadog/Sentry sinks.

---

## 🚀 Quick Start

### Prerequisites
- [Bun](https://bun.sh/) (or Node.js)
- [Docker & Docker Compose](https://www.docker.com/)
- Supabase Project & Anthropic API keys

### 1. Environment Setup

Clone the repository and set up your environment variables:

```bash
git clone https://github.com/laygrounded/laygrounded.git
cd laygrounded
cp .env.example .env
```

Ensure the following critical variables are present in your `.env`:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
ANTHROPIC_API_KEY=your_anthropic_api_key
NEXTAUTH_SECRET=your_32_byte_random_string
```
*(Tip: Generate a NEXTAUTH_SECRET quickly via `openssl rand -base64 32`)*

### 2. Local Development (Standard)

If you are actively writing code or UI components:

```bash
bun install
bun run dev
```
Navigate to `http://localhost:3000`.

### 3. Full Production Stack Simulation (Docker)

To test the application exactly as it runs in the cloud (with the Caddy reverse proxy and Alpine Next.js runner):

```bash
docker compose build --no-cache
docker compose up -d
```
The application is exposed securely via the Caddy proxy at `http://localhost:81`.

---

## ☁️ Deployment

LayGrounded's containerized infrastructure makes deploying to platforms like AWS ECS, DigitalOcean App Platform, or a bare-metal VPS trivial.

The included `Dockerfile` and `docker-compose.yml` automatically strips the `.env` from the build context, passes essential `NEXT_PUBLIC_` variables at build time for SSG, and executes a heavily optimized, minimal Node.js Alpine final runner image.

### Recommended CI/CD Flow
1. **Build Phase:** GitHub Actions builds the Docker image and pushes it to your registry (e.g., GHCR, ECR).
2. **Deploy Phase:** The production host pulls the `latest` tag and cycles the containers gracefully.
3. **Secrets:** Inject the runtime secrets (Anthropic Key, Supabase Keys) exclusively at the host environment level.

---

<div align="center">
  <i>Built to modernize global shipping.</i><br>
  <b>LayGrounded © 2026</b>
</div>
