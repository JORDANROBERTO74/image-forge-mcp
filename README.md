# Image Forge MCP Server

MCP server for text-to-image and image-to-image generation on **Cloudflare Workers AI**, built to run on the free plan.

- Text-to-image and image editing from a local file, `file://` URL or `https://` URL.
- Saves results to disk and returns paths + metadata, instead of dumping base64 into the model context.
- Tracks estimated Neuron usage per call and blocks runaway loops before they exhaust the daily allowance.
- Provider-agnostic core: adding another backend (e.g. Gemini) means one new file under `src/providers/`.
- Ships two [agent skills](#skills) that teach an agent to create an image and to clone an existing one with a controlled change.

## Requirements

- Node.js >= 20.6 (uses `--env-file`)
- pnpm (or npm)
- A Cloudflare account with Workers AI enabled (no credit card required for the free allowance)

## Cloudflare setup

1. Go to `dash.cloudflare.com` → **My Profile** → **API Tokens** → **Create Token**.
2. Custom token with permission **Account → Workers AI → Read**.
3. Copy your **Account ID** from the right sidebar of **Workers & Pages**.
4. Create the env file:

```bash
cp .env.example .env
# then fill CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
```

The token is only ever read from `.env` (gitignored). No configuration file contains the secret.

## Install

```bash
git clone https://github.com/JORDANROBERTO74/image-forge-mcp.git
cd image-forge-mcp
pnpm install
pnpm build
```

## Verify

```bash
pnpm test:local   # image I/O, naming, history, budget math (no credentials)
pnpm test:mcp     # MCP handshake, tools/list, error paths (no credentials)
pnpm spike        # real API calls: which models are available on your plan
```

`pnpm spike` is the first thing to run after adding credentials. It reports HTTP status,
`content-type`, latency and whether each model returns binary or base64, then saves whatever
it gets to `IMAGE_OUT_DIR`. If `flux-2-klein-4b` fails but `sd15-img2img` works, set
`IMAGE_FORGE_DEFAULT_MODEL=sd15-img2img` in `.env`.

## Register the server

Point the client at the `build/index.js` file of your clone. Use absolute paths.

### OpenCode (`~/.config/opencode/opencode.jsonc`)

```jsonc
"image-forge": {
  "type": "local",
  "command": [
    "node",
    "--env-file=/absolute/path/to/image-forge-mcp/.env",
    "/absolute/path/to/image-forge-mcp/build/index.js"
  ]
}
```

### Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`)

```json
"image-forge": {
  "command": "node",
  "args": [
    "--env-file=/absolute/path/to/image-forge-mcp/.env",
    "/absolute/path/to/image-forge-mcp/build/index.js"
  ]
}
```

On Windows use double backslashes (`C:\\path\\to\\...`) in JSON.

## Skills

Two Agent Skills live in `skills/`, in the standard `<name>/SKILL.md` layout:

| Skill | What it does |
|---|---|
| `image-forge-create` | Turns a request into a `generate_image` call: prompt shaping, size, variants. |
| `image-forge-variant` | Takes an existing image and produces a variant that keeps everything except the change the user asked for. |

Both use the default model `flux-2-klein-4b`, the same one the server is tuned for.

Install with the skills CLI:

```bash
npx skills add JORDANROBERTO74/image-forge-mcp
```

Or copy the folders by hand:

```bash
cp -r skills/* ~/.config/opencode/skills/       # OpenCode
cp -r skills/* ~/.claude/skills/                # Claude-compatible agents
```

Restart the client, then check that the skill is listed before asking for an image.

## Tools

### `edit_image`

| Parameter | Type | Notes |
|---|---|---|
| `image` | string | Local path, `file://` or `http(s)://`. Required. |
| `prompt` | string | What should change or how the result should look. |
| `model` | enum | `flux-2-klein-4b` (default) or `sd15-img2img`. |
| `strength` | 0–1 | `sd15-img2img` only: how far to move away from the input. |
| `negative_prompt` | string | `sd15-img2img` only. |
| `width` / `height` | 256–2048 | Defaults to the model's native size (1024 / 512). |
| `steps` | 1–20 | Diffusion steps. |
| `seed` | int | Reproducibility (honoured by both models). |
| `count` | 1–4 | Variants per call; each one uses `seed + index`. |
| `out_dir` | string | Overrides `IMAGE_OUT_DIR` for this call. |

### `generate_image`

Same parameters minus `image`, plus `negative_prompt`. With `sd15-img2img` this tool returns
an explicit error, because that model requires an input image.

### `get_image_info`

`{ path }` → format, dimensions, size. Reads headers only; no API call, no quota.

## Cost

Free allocation: **10,000 Neurons/day**, reset at 00:00 UTC, no credit card.

| Model | Neurons per 1 MP image | Images/day on the free plan |
|---|---|---|
| `sd15-img2img` | 0 (`$0.00` per step) | limited by rate, not quota |
| `flux-2-klein-4b` | ~126 | ~79 |
| `flux-2-klein-9b` | ~1,545 | ~6 |

`flux-2-dev` is excluded: it is priced per tile **per step** and its licence is non-commercial.

Verified against the live API on 2026-10-22: `flux-2-klein-4b` returns HTTP 200 for both
image editing (10.5 s at 1024x1024, ~580 KB PNG) and text-to-image (20.7 s).
`sd15-img2img` returned HTTP 403 / error 5018 ("account is not allowed to access") on the test
account, so the free fallback is not guaranteed — the model stays registered for accounts
that do have access, and the error message explains the 5018 case explicitly.

Every response reports `estimatedNeurons` and today's running total. The server refuses a call
that would cross `IMAGE_FORGE_HARD_NEURONS` (default 9,500) and warns above 8,000.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | — | Required to generate. |
| `CLOUDFLARE_API_TOKEN` | — | Required to generate. |
| `IMAGE_OUT_DIR` | `~/Downloads` | Output folder (created if missing). |
| `IMAGE_FORGE_DEFAULT_MODEL` | `flux-2-klein-4b` | Model when the tool call omits one. |
| `IMAGE_FORGE_MAX_IMAGES_PER_CALL` | `4` | Cap on `count`. |
| `IMAGE_FORGE_MAX_INPUT_MB` | `10` | Max input image size. |
| `IMAGE_FORGE_WARN_NEURONS` | `8000` | Warning threshold. |
| `IMAGE_FORGE_HARD_NEURONS` | `9500` | Hard stop. |
| `IMAGE_FORGE_TIMEOUT_MS` | `90000` | Per-request timeout. |
| `IMAGE_FORGE_HISTORY` | `~/.image-forge/history.jsonl` | Generation log. |
| `IMAGE_FORGE_MULTIPART_IMAGE_FIELD` | `input_image` | Multipart field name for FLUX.2. |

## Notes and limitations

- `flux-2-klein-4b` exposes a `multipart` input schema that Cloudflare's docs do not
  itemise. Verified 2026-10-22: the image field is `input_image`. It stays configurable
  through `IMAGE_FORGE_MULTIPART_IMAGE_FIELD` in case Cloudflare renames it.
- Output is written atomically (`.tmp` + rename); partial PNGs are never left behind.
- Images are never inlined into the conversation by default. This keeps context small.
- `sd15-img2img` returned 5018 on the test account. If it disappears everywhere, add another
  provider file; the tool surface does not change.
- Both models accept 256–2048 px, but SD 1.5 is natively 512 px and degrades above it.

## License

MIT
