# Deploy the Video Server (step by step)

This makes the "Render video (with audio)" button work. The video is built on a small free
server, then sent back to your phone. Follow these in order — it takes about 20–30 minutes the
first time, and you only do the setup once.

You'll need two free accounts: **GitHub** (to hold the code) and **Render** (to run it).
Optional: a free **Pexels** account for real stock footage.

---

## Step 1 — Put the server code on GitHub

1. Create a free account at https://github.com if you don't have one.
2. Click the **+** (top right) → **New repository**. Name it `quran-captions-video`, keep it
   **Public**, and click **Create repository**.
3. On the new repo page, click **uploading an existing file** (the link in "…or upload an existing file").
4. Open the **`quran-captions-video-server`** folder on your computer, select **all the files
   inside it** (`server.js`, `Dockerfile`, `package.json`, `render.yaml`, `.gitignore`,
   `.dockerignore`, this guide) and drag them into the GitHub upload box.
   > Important: upload the **contents** of the folder, so `Dockerfile` sits at the top level of the repo.
5. Click **Commit changes**.

## Step 2 — Deploy on Render

1. Create a free account at https://render.com (sign up with GitHub — easiest).
2. Click **New +** → **Web Service**.
3. Connect your GitHub and pick the `quran-captions-video` repo.
4. Render reads the `Dockerfile` automatically. Confirm/选择 these settings:
   - **Language / Runtime:** Docker
   - **Instance type:** **Free**
   - **Region:** pick the one closest to you
5. Click **Create Web Service** (or **Deploy**).
6. Wait. The first build takes ~5–10 minutes (it installs FFmpeg + Chromium). Watch the log;
   when you see **"Video server listening on …"** and the status turns **Live**, it's ready.
7. Copy your service URL from the top of the page. It looks like:
   `https://quran-captions-video.onrender.com`
8. Test it: open that URL in a browser. You should see **"Quran Captions video server is running."**

## Step 3 — Connect your app

1. In VS Code, open `QuranCaptions/src/config.js`.
2. Replace the placeholder with your real URL (no trailing slash):
   ```js
   export const VIDEO_SERVER_URL = 'https://quran-captions-video.onrender.com';
   ```
3. Save. If `npx expo start` is running, the app reloads automatically.

## Step 4 — Add new libraries the app now needs

The app gained one package (`expo-file-system`). In the `QuranCaptions` folder terminal:
```
npx expo install expo-file-system
```
Then restart: `npx expo start --tunnel`.

## Step 5 — Try it

In the app: **Create → pick a surah → choose ayat → reciter → format → Studio**, choose a
**Moving background**, then tap **Render video (with audio)**. After a short wait the video saves
to your photo library and the share sheet opens.

> Start with a **short selection (1–3 short ayat)** for your first test — it renders fastest.

---

## Optional — real stock footage instead of the gradient

By default (no key) the background is an animated gradient, so the button works immediately.
For real moving footage from Pexels:

1. Create a free account at https://www.pexels.com/api/ and copy your API key.
2. In Render → your service → **Environment** → **Add Environment Variable**:
   - Key: `PEXELS_API_KEY`
   - Value: *(paste your key)*
3. Click **Save changes** — Render redeploys. Now the "Moving background" choices pull live clips.

---

## Heads-up about the free tier (so nothing surprises you)

- **It sleeps after ~15 min idle.** The first request after a nap takes ~30–60s to wake up
  ("cold start"). That's normal on the free plan; the next renders are quick.
- **Memory is limited (512MB).** Keep clips short and resolution at 720p–1080p. Long surahs or 4K
  may fail on free — upgrade to a paid instance (a few dollars/month) for those.
- **Each render takes time** (downloading audio + footage + encoding). A few short ayat is fastest.

---

## If something fails

| Symptom | Likely cause / fix |
|---|---|
| Button says "Set up the server first" | You haven't pasted your URL into `src/config.js`. |
| Long wait then works | Cold start (server was asleep). Normal. |
| "Server error 500" | Open Render → **Logs**. Usually a bad audio URL or out-of-memory on a long clip — try fewer ayat / lower resolution. |
| Build fails on Render | Make sure `Dockerfile` is at the **top level** of the repo (Step 1.4). |
| No audio in the video | Check the reciter plays in the Listen tab first; if a custom reciter's folder is wrong, audio download fails. |
| Gradient background only | That's expected until you add `PEXELS_API_KEY` (optional section above). |
