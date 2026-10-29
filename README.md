# Image Forge

An MCP server that lets your coding agent generate or edit images on Cloudflare Workers AI and
save them to disk, keeping base64 out of the conversation.

It runs on Cloudflare's free daily allowance, so an agent can draw without a paid API key.

## Why this one

- **No card, no per-image bill.** Cloudflare gives 10,000 Neurons/day free. At roughly
  104–126 Neurons per 1024px image, that is about 80 images a day, resetting at 00:00 UTC.
- **Files, not payloads.** Every call writes a PNG/JPG to disk and returns its path, size and
  seed. Your context window never absorbs an image.
- **A budget guard, not a surprise invoice.** Each call is estimated before it runs; the server
  warns at 8,000 Neurons and refuses to cross 9,500.
- **One tool surface for both directions.** `generate_image` for text, `edit_image` to rework an
  existing file, URL or `file://` path.
- **Honest trade-off.** `flux-2-klein-4b` is fast and cheap, not a frontier image model: it
  handles style, palette and composition well, and struggles with long legible text. There is no
  mask-based inpainting and no upscaling.

Alternatives such as the OpenAI or Gemini image MCP servers buy stronger instruction following
and text rendering, paid per image with an API key. Pick those when that is the requirement;
pick this when you want many images a day for free and the results stored on disk.

## Quickstart

Requires Node.js >= 20.6 (the server uses `--env-file`).

```bash
git clone https://github.com/JORDANROBERTO74/image-forge-mcp.git
cd image-forge-mcp
pnpm install && pnpm build
cp .env.example .env
```

Fill two values in `.env`:

- `CLOUDFLARE_ACCOUNT_ID` — right sidebar of **Workers & Pages** in the Cloudflare dashboard.
- `CLOUDFLARE_API_TOKEN` — a custom token with permission **Account → Workers AI → Read**.

Then register the server with absolute paths. OpenCode (`~/.config/opencode/opencode.jsonc`):

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

Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
"image-forge": {
  "command": "node",
  "args": [
    "--env-file=/absolute/path/to/image-forge-mcp/.env",
    "/absolute/path/to/image-forge-mcp/build/index.js"
  ]
}
```

Use double backslashes for Windows paths inside JSON (`C:\\tools\\image-forge-mcp\\...`).

## Use it

Ask your agent in plain language: *"generate a 1024x1024 cover image of a lighthouse at dusk,
muted blues"*. It calls:

```json
{ "prompt": "a lighthouse at dusk, muted blue palette, soft haze", "width": 1024, "height": 1024 }
```

and gets back a path plus metadata:

```text
✅ 1 imagen(es) · flux-2-klein-4b · 1024x1024
1. /home/you/Downloads/image-forge-20261029-101500.png (1024x1024, 581 KB, seed n/a)
costo: ~104 neurons (hoy: ~104 de ~10.000)
```

For a variant, the agent calls `edit_image` with the original path and a prompt that describes
what to keep and what to change. Reusing the `seed` reproduces an earlier result.

## Tools

| Tool | Input | Use |
|---|---|---|
| `generate_image` | `prompt` | Text to image. |
| `edit_image` | `image` + `prompt` | Existing image plus instructions; local path, `file://` or `http(s)://`. |
| `get_image_info` | `path` | Dimensions, format, size. Reads headers only; no API call, no quota. |

Shared parameters: `model`, `width`/`height` (256–2048), `steps` (1–20), `seed`, `count` (1–4,
each image uses `seed + index`), `out_dir`. `strength` and `negative_prompt` exist but only
affect `sd15-img2img`, which most accounts cannot access — see [Limits](#limits-and-status).

## Skills

Two [Agent Skills](https://opencode.ai/docs/skills) are included so an agent knows how to drive
the server without being told the parameters:

| Skill | What it encodes |
|---|---|
| [`image-forge-create`](skills/image-forge-create/SKILL.md) | Prompt shaping, size, variants, quota discipline. |
| [`image-forge-variant`](skills/image-forge-variant/SKILL.md) | Cloning an existing image while changing one named thing, without losing composition or lighting. |

```bash
npx skills add JORDANROBERTO74/image-forge-mcp
```

Or copy them yourself: `cp -r skills/* ~/.config/opencode/skills/` (or `~/.claude/skills/` for
Claude-compatible agents), then restart the client.

## Configuration

Set in `.env`. Defaults work for a first run.

| Variable | Default | Purpose |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | — | Required to generate. |
| `CLOUDFLARE_API_TOKEN` | — | Required to generate. |
| `IMAGE_OUT_DIR` | `~/Downloads` | Output folder, created if missing. |
| `IMAGE_FORGE_DEFAULT_MODEL` | `flux-2-klein-4b` | Model when a call omits one. |
| `IMAGE_FORGE_MAX_IMAGES_PER_CALL` | `4` | Cap on `count`. |
| `IMAGE_FORGE_MAX_INPUT_MB` | `10` | Max input image size. |
| `IMAGE_FORGE_WARN_NEURONS` | `8000` | Warning threshold. |
| `IMAGE_FORGE_HARD_NEURONS` | `9500` | Hard stop before the daily limit. |
| `IMAGE_FORGE_TIMEOUT_MS` | `90000` | Per-request timeout. |
| `IMAGE_FORGE_HISTORY` | `~/.image-forge/history.jsonl` | Generation log. |
| `IMAGE_FORGE_MULTIPART_IMAGE_FIELD` | `input_image` | Multipart field name for FLUX.2. |

## Limits and status

Version 1.0.0, single maintainer. Built and tested on Windows with Node 24; no npm package yet,
install from source. Expectations are set by what the source and the live API show, not by a
roadmap.

- `flux-2-klein-4b` is the only dependable model here. It is verified for editing (10.5 s at
  1024x1024, ~580 KB PNG) and text-to-image (20.7 s) against the live API on 2026-10-22.
- `sd15-img2img` is registered for its `strength` control and $0.00 steps, but returned HTTP 403
  / error 5018 ("account is not allowed to access") on the test account and cannot do
  text-to-image at all. Treat it as unavailable unless your account says otherwise.
- Cloudflare does not itemise the multipart schema for FLUX.2; the verified field name is
  `input_image`, override with `IMAGE_FORGE_MULTIPART_IMAGE_FIELD` if that changes.
- Output is written atomically (`.tmp` then rename); partial files are never left behind.
- Tool output and error messages are in Spanish; the tool names and parameters are English.
- One provider today. Adding another means one file under `src/providers/`; the tool surface
  stays the same.

Development commands: `pnpm test:local` (image I/O, naming, history, budget math) and
`pnpm test:mcp` (handshake, tool list, error paths) run without credentials. `pnpm spike`
reports which models your account can actually reach.

## License

MIT. See [LICENSE](LICENSE).
