# renderer-api

API simples para renderizar HTML em PNG usando Puppeteer.

## Rotas

- GET /health -> { ok: true }
- POST /render -> retorna image/png

Body (JSON):

- html (string, obrigatório)
- width (number, default 720)
- height (number, default 1280)
- selector (string, default "#rg-card")

## Variáveis de ambiente

- PORT: porta do servidor
- PUPPETEER_EXECUTABLE_PATH (ou CHROME_PATH): caminho do Chromium/Chrome
- JSON_LIMIT: limite do body JSON (ex.: 30mb)

## Rodando local

- npm install
- npm start

## Deploy no Render (Docker)

A pasta já inclui Dockerfile. No Render, crie um Web Service do tipo Docker apontando para este diretório.

Depois, no bot, configure RG_RENDER_API_URL com a URL pública do Render (ex.: https://seu-servico.onrender.com).
