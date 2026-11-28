# Goop: manual Render deployment (your own Render account)

Your existing S3 site stays at https://mathscholar.s3.us-east-2.amazonaws.com/index.html. Upload this repository to **your** GitHub account, then create Render services through Render's website. You do **not** need to connect Render to ChatGPT.

## Step 1 — GitHub

Create a new repo such as `goop-backend` and upload the **contents** of this folder to the repo root. GitHub should show `backend/`, `services/`, `site/`, `compose.yaml` and this README at the root. Do **not** upload the ZIP itself as the only GitHub file.

## Step 2 — Create the Render services manually

Visit https://dashboard.render.com/new/web , connect your GitHub account to Render itself, and select your new `goop-backend` repository. Repeat for each service below. Use **Docker** runtime, Docker Build Context `.`, and the Dockerfile path below. Keep automatic deploy enabled if desired. Choose a plan only after checking Render's displayed cost. The services must be running publicly over HTTPS for the S3 page to use them.

| Create in order | Render name (example) | Dockerfile path | Environment variables to add |
|---|---|---|---|
| 1 | `goop-manga` | `services/Dockerfile.manga.render` | `PORT=10000`, `HOST=0.0.0.0` |
| 2 | `goop-music` | `services/Dockerfile.music` | `MUSIC_PORT=10000`, `YTM_BASE=https://music.youtube.com`, `YT_DLP_PATH=/usr/local/bin/yt-dlp` |
| 3 | `goop-movies` | `services/Dockerfile.movies.render` | `PORT=10000`, `HOST=0.0.0.0`, `TMDB_API_KEY=<YOUR KEY>` |
| 4 | `goop-gateway` | `backend/Dockerfile` | `CORS_ORIGINS=https://mathscholar.s3.us-east-2.amazonaws.com`, `MOVIES_URL=https://<movies-service>.onrender.com`, `MUSIC_URL=https://<music-service>.onrender.com`, `MANGA_URL=https://<manga-service>.onrender.com`, `PORT=10000` |

Use `PORT=10000` as the recommended Render listener port; Render also automatically provides a `PORT` environment variable. Do not put your API keys in GitHub; set them in Render **Environment** settings. If you don't have a TMDB key, Movies metadata features will not work yet.

After each deployment finishes, copy its `https://...onrender.com` URL into the gateway environment variables. These are **public** service URLs, not `http://manga:3000` container names from Docker Compose.

Check `https://<gateway>.onrender.com/health` (should contain `status: ok`) and `https://<gateway>.onrender.com/api/status`. The latter shows which upstreams are reachable; it does not guarantee playback works.

### Optional GoopBlox

Create a fifth Render Docker Web Service using `services/Dockerfile.blox`; set `PORT=10000` and `HOST=0.0.0.0`. Add `BLOX_URL=https://<blox-service>.onrender.com` to the gateway environment and redeploy it. GoopBlox downloads large Roblox engine files, needs a suitable paid/adequately sized machine, Roblox login, and browser WebTransport compatibility. It may not run reliably on Render; deploy it only after the other three services are stable.

## Step 3 — Connect the existing S3 site (once)

With the gateway showing healthy, extract this ZIP on your **own Windows PC**, install the AWS CLI and configure access to your `mathscholar` bucket, then double-click `CONNECT-S3.bat`. Enter the gateway HTTPS URL, e.g. `https://goop-gateway-xxxx.onrender.com`. The script updates `site/goop-config.js` and uploads the static site. No visitors need to configure URLs.

**Warning:** `CONNECT-S3.bat` overwrites your bucket's `index.html` and related files using the included `site/` snapshot. Back up your current S3 site first if you have changed it since this ZIP was made. It does **not** upload Scramjet runtime files, so keep your existing Scramjet assets in the bucket if browser search is working. Don't run the script before the gateway exists.

## Limitations / checks

- Movies needs a TMDB API key, and playback availability depends on upstream services and lawful rights to the content.
- Music search can work while playback fails due to missing `yt-dlp`, blocks, or provider restrictions; container already includes `yt-dlp`.
- Render free/low-tier services may sleep, lack memory, or lose on-disk caches. Check prices and resource plans before deploying.
- GoopBlox requires a full Roblox engine and browser support; it must open top-level and is not guaranteed to function via reverse proxy.
- This package does not deploy anything automatically to your accounts. A full end-to-end live deployment has not been verified.

## Chat staff keys

Staff sign in to Goop Chat by typing their key in the Username box, then their own
username and password. Set each key on the **goop-gateway2** service under
Environment. Every key must be at least 24 characters, and must be different from
the others. Leave a variable unset to turn that rank off.

| Variable | Rank | Can do |
| --- | --- | --- |
| `GOOP_CHAT_TRIAL_MOD_CODE` | Trial mod | See mod-only channels, time people out |
| `GOOP_CHAT_MOD_CODE` | Moderator | Trial mod, plus kick |
| `GOOP_CHAT_STAFF_ADMIN_CODE` | Admin | Moderator, plus temporary bans (1–365 days) |
| `GOOP_CHAT_CO_OWNER_CODE` | Co-owner | Admin, plus permanent bans and mutes, creating channels and roles, channel settings |
| `GOOP_CHAT_ADMIN_CODE` | Owner | Everything, including deleting anyone's messages |

Staff cannot act on someone signed in with the same or a higher rank. A staff key
typed into a chat message is blocked by the filter.
