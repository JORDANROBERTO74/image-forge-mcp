---
name: image-forge-create
description: Create a new image from a text prompt with the image-forge MCP server (generate_image). Use when the user asks to generate, draw, render or design a picture, illustration, photo, logo, banner or mockup, and the image-forge MCP is available.
license: MIT
compatibility: opencode
metadata:
  mcp: image-forge
  model: flux-2-klein-4b
---

# Create an image

## What to do

1. Call `generate_image` on the `image-forge` MCP server. Never call it more than once in
   parallel: each call spends the daily Neurons allowance.
2. Do not pass `model`. The server default is `flux-2-klein-4b` (~126 neurons per 1024px image,
   ~79 images/day on the free plan), and it is the model this MCP is tuned for.
3. Write the prompt as a description of the final image, not of an action: subject, style,
   lighting, framing, palette, background. Keep it under 4000 characters.
4. Pass `width` and `height` only when the aspect ratio matters; otherwise 1024x1024 is used.
   Minimum 256, maximum 2048. `steps` defaults to the model value; `seed` only to reproduce.
5. Ask for `count` variants only when the user wants alternatives (max 4 per call).
6. Report the returned file paths. Do not paste the image back into the conversation.

## Notes

- `negative_prompt` and `strength` are ignored by `flux-2-klein-4b`; do not pass them.
- `sd15-img2img` cannot generate from text alone (it errors) and returns 403 / error 5018 on
  accounts without access. Use it only if the user says their account has access.
- If the tool reports a quota error, tell the user: lower `count`, wait for the 00:00 UTC reset,
  or raise `IMAGE_FORGE_HARD_NEURONS` if they accept the spend.
- Missing credentials show up as a CONFIG error: point the user to `image-forge/.env`
  (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`).
