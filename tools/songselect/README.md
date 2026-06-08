# SongSelect Lead Sheet Fetcher

Fetches lead sheet PDFs from SongSelect (songselect.ccli.com) using browser authentication.

## Setup (one-time)

Run the cookie exporter to authenticate:

```bash
./songselect.sh export-cookies
```

This opens Chrome. Log in to your SongSelect account, then close the browser. Cookies are saved to `cookies.json`.

## Usage

### Fetch a lead sheet (prints to stdout)
```bash
./songselect.sh fetch "Goodness Of God"
```

### Download to a directory
```bash
./songselect.sh fetch "Goodness Of God" --download ./leadsheets/
```

### Search by CCLI number
```bash
./songselect.sh fetch "Goodness Of God" --ccli 7117726
```

### Browse (non-headless, for debugging)
```bash
./songselect.sh fetch "Song Name" --view
```

### Options
| Flag | Description |
|------|-------------|
| `--headless` | Run without UI (default when --download is used) |
| `--download DIR` | Save PDF to directory |
| `--ccli NUMBER` | Search by CCLI number instead of title |
| `--view` | Open in browser for manual inspection |

## How it works

1. **Authentication**: Uses saved browser cookies (exported via Playwright) to authenticate with SongSelect
2. **Search**: Navigates to SongSelect search page, finds the song
3. **Fetch**: Navigates to the lead sheet PDF endpoint
4. **Output**: Either prints PDF to stdout or saves to disk

## Cookie expiry

Cookies typically expire after 30-60 days. Re-run `export-cookies.js` when authentication fails.

## Files

- `export-cookies.js` - Exports cookies from a browser login session
- `fetch-leadsheet.js` - Fetches lead sheet PDFs using saved cookies
- `songselect.sh` - Shell wrapper for easy usage
