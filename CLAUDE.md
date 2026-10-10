# knowledge-graph

Local, open-source canvas that grows a concept graph while a user chats with any LLM, fed through MCP.
Decisions and architecture: `docs/ARCHITETTURA.md`. Talk to Luca in Italian; code, comments and commits in English.

## Layout
- `src/core/` domain: `tracker.ts` holds every tracking rule; storage only via the `Repository` interface (`sqlite-repository.ts`, `node:sqlite`).
- `src/server/` Fastify daemon: `/mcp` (Streamable HTTP), `/api` REST, `/ws` live events, static canvas. MCP tools in `mcp.ts`, model instructions in `instructions.ts`.
- `src/bridge/` stdio→HTTP bridge for stdio-only clients (auto-starts the daemon).
- `web/` React + React Flow + ELK canvas (Vite). Imports domain types from `src/core/types.ts`.
- `scripts/simulate.ts` plays a scripted conversation against a running daemon.

## Commands
- `npm start` daemon on :7777 (`KG_PORT`, `KG_DB` override); `npm run dev:web` canvas with hot reload.
- `npm run build` compiles the publishable package (`dist/` + `web/dist/`; `prepack` runs it).
- `npm run typecheck`, `npm test` (unit + MCP over HTTP), `npm run test:e2e` (builds the canvas, headless Chromium; set `CHROMIUM_PATH=/opt/pw-browsers/chromium` in the cloud sandbox).
- While working run only the tests of the touched area; full suite once before the PR.

## Rules
- TypeScript runs directly on Node 22 (type stripping): erasable syntax only, `.ts` import extensions.
- Keep MCP tool descriptions and results short: they cost tokens on every call.
- Server never calls an LLM; titles and summaries come from the client model.
