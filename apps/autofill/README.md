# @expenser/autofill

A bot that runs on your own machine. Drop a photo or screenshot of a receipt into `inbox/` and it will:

1. Send the image to **Gemini**, which pulls out the expenses (amount, description, category). The
   prompt includes your actual Expenser categories, so Gemini picks from those.
2. Open the Expenser webapp with **Playwright**, log in as you, and fill in the "Add expense"
   form for each expense, the same way you would by hand.
3. Move the image to `processed/` with a `.json` report of what it added. If anything goes wrong,
   the image goes to `failed/` with the error instead.

It drives the real UI, not the API, so it goes through the same validation and category lookup a
person would. No backend changes are needed.

## Setup (once)

```sh
pnpm install                                   # from the repo root
pnpm --filter @expenser/autofill setup         # downloads Playwright's Chromium
cp apps/autofill/.env.example apps/autofill/.env
```

Fill in `apps/autofill/.env`:

| Var | Purpose |
|---|---|
| `GEMINI_API_KEY` | From https://aistudio.google.com/apikey |
| `GEMINI_MODEL` | Default `gemini-3.8-flash` |
| `EXPENSER_URL` | `https://expenser.juanromerodev.com`, or `http://localhost:4321` for local dev |
| `EXPENSER_EMAIL` / `EXPENSER_PASSWORD` | The Expenser account to add expenses to |
| `INBOX_DIR` / `PROCESSED_DIR` / `FAILED_DIR` | Default `./inbox`, `./processed`, `./failed` (relative to `apps/autofill`) |
| `HEADLESS` | `false` shows the browser while it works |
| `BROWSER_EXECUTABLE_PATH` | Optional: use an installed Chrome instead of Playwright's Chromium |

## Usage

```sh
pnpm --filter @expenser/autofill start     # watch inbox/ and process images as they arrive
pnpm --filter @expenser/autofill once      # process what's in inbox/ now, then exit
pnpm --filter @expenser/autofill dry-run   # extract and print only: adds nothing, moves nothing
```

Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.heic`, `.heif`.

Tip: point `INBOX_DIR` at a folder that syncs from your phone (iCloud Drive, Google Drive,
Syncthing, etc.). Then sharing a receipt photo to that folder is all it takes to log it. Watch
mode waits until a file has finished writing before reading it, and handles several images dropped
at once in a single browser session.

### Notes

- **Session:** after the first login, Playwright saves the browser session to `.auth/state.json`
  (gitignored) and reuses it, so it doesn't open a new backend session on every run. Delete the
  file to force a fresh login.
- **What Gemini extracts:** one expense per payment. A single receipt becomes one expense for its
  total. A bank or Mercado Pago screenshot listing several payments becomes one expense per
  outgoing payment. Incoming money and refunds are ignored. If Gemini returns a category that
  doesn't exist, the bot uses `Other` (or the first category if there is no `Other`).
- **Failures:** the `.json` next to an image in `failed/` includes `added`, the number of
  expenses that were saved before the error. Remove those from the image (or delete them in the
  app) before moving it back into `inbox/`, or they will be added twice. If the whole batch fails
  (bad login, network down), the images stay in `inbox/`. Run `once` after fixing the problem.
- **Dates:** the webapp always records expenses at the current time, so an old receipt counts
  toward this week.
- **Privacy:** the bot and browser run on your machine. The only thing sent to Google is the
  image, via the Gemini API.
