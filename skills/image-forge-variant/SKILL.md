---
name: image-forge-variant
description: Create an exact variant of an existing image with the image-forge MCP server (edit_image). Use when the user says "make a variant of this image", "copy this image but change X", "same image with another color/text", or provides an image path or URL and wants a new version of it.
license: MIT
compatibility: opencode
metadata:
  mcp: image-forge
  model: flux-2-klein-4b
---

# Variant of an existing image

## What to do

1. Locate the input: absolute local path, `file://`, or `https://` URL. If the user gave no
   path, ask for it; do not invent one.
2. Call `get_image_info` on it (free, no quota) to learn width, height and format.
3. Call `edit_image` with:
   - `image`: that same input
   - `prompt`: a sentence that **keeps everything and changes one thing**:
     "same image, same composition, framing, lighting, colors and style; only change the
     background to a dark blue gradient"
   - `width` / `height`: the input's own size, so nothing is rescaled or cropped
   - `model`: omit it — `flux-2-klein-4b` is the default and the model this MCP is tuned for
   - `count`: 1 for one variant, 2-4 when the user wants options
4. Report the returned paths and note which parameter differed from the original.

## Exactness

`flux-2-klein-4b` edits by prompt; it ignores `strength`. "Exact" therefore comes from three
things, not from a strength value:

- pass the original image and keep `width`/`height` identical;
- describe the kept features explicitly in the prompt (composition, framing, lighting, style);
- reuse the original `seed` when reproducing, or pass a `seed` and `count` > 1 to get
  neighbouring seeds (the server adds the image index to the seed).

`sd15-img2img` is the only model with `strength` (0 = almost identical, 1 = ignores the input),
but it returns 403 / error 5018 on accounts without access. Offer it only if the user says
they have access.

## Notes

- Input images are capped at `IMAGE_FORGE_MAX_INPUT_MB` (10 MB by default).
- Out-of-budget calls fail with a QUOTA error instead of overspending.
- Never inline the resulting image into the conversation; return the file paths.
