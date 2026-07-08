# LayGrounded — Laytime & Demurrage Claims Engine

LayGrounded is a production-ready AI-powered laytime and demurrage claims engine designed for the global dry bulk shipping industry.

## Features

- **Automated SoF Extraction**: Uses Vision-Language Models (VLM) via Anthropic to parse Statements of Facts into structured events. Includes per-page retries, quality gates, and deterministic fallbacks for degraded environments.
- **Rules Engine (GENCON 94)**: Full hour-by-hour logic with clause citations. Calculates NOR validation, turn time, SHEX working-hour advancement, operational window detection, and final demurrage/despatch totals.
- **Clause Flagging**: Automatically flags ambiguous events per the spec's trigger rules (e.g. NOR tendered at anchorage, Shifting before ALL_FAST).
- **Modern Stack**: Built with Next.js 16 App Router, TypeScript, Supabase (PostgreSQL & Auth), Tailwind CSS, and shadcn/ui.
- **Design System**: Clean financial terminal aesthetic with navy/amber/teal tokens and Space Grotesk + JetBrains Mono typography.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (or Node.js)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for local database development)
- Docker (required by Supabase CLI)

### Installation

1. Clone the repository and install dependencies:
   ```bash
   bun install
   ```

2. Set up Environment Variables:
   Copy the example environment file and adjust values:
   ```bash
   cp .env.example .env
   ```
   Ensure you provide your `ANTHROPIC_API_KEY` for AI extraction.

3. Start the Local Database:
   Spin up the local Supabase stack:
   ```bash
   supabase start
   ```
   *Note: This will automatically apply migrations and seed the database if configured.*

4. Run the Development Server:
   ```bash
   bun run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment

The project is ready for deployment on platforms like Vercel. Ensure you link your project to a remote Supabase instance and provide the necessary environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`).
