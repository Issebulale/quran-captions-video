// Quran Captions — video render server
// Pipeline: download ayah audio -> get a moving background (Pexels stock, or animated
// gradient fallback) -> render the verse as a transparent overlay (Chromium, perfect Arabic
// shaping) -> composite everything with FFmpeg into an MP4 -> return it.

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PEXELS_KEY = process.env.PEXELS_API_KEY; // optional; set in Render dashboard
const PORT = process.env.PORT || 10000;
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// Free-tier safety: cap the longest side so a render fits in memory/time.
const MAX_LONG_SIDE = 1280;

// ---------- small helpers ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.slice(-600)}`))));
  });
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(parseFloat(out.trim()) || 0) : reject(new Error('ffprobe failed'))));
  });
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

// Optional: fetch a moving stock clip from Pexels (free API key).
async function fetchPexels(query, orientation, dest) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=8&size=medium`;
  const r = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
  if (!r.ok) throw new Error('pexels ' + r.status);
  const j = await r.json();
  const vids = (j.videos || []).filter((v) => v.video_files?.length);
  if (!vids.length) throw new Error('no pexels results');
  const v = vids[Math.floor(Math.random() * Math.min(vids.length, 6))];
  const files = v.video_files.filter((f) => f.file_type === 'video/mp4' && f.link);
  files.sort((a, b) => (a.height || 0) - (b.height || 0));
  const pick = files.find((f) => (f.height || 0) >= 700) || files[files.length - 1];
  if (!pick) throw new Error('no mp4 file');
  await download(pick.link, dest);
}

// Render the verse text to a transparent PNG using headless Chromium (reliable Arabic shaping).
async function renderOverlay({ arabic, translit, translation, W, H, out }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const arSize = Math.round(W * 0.064);
  const tlSize = Math.round(W * 0.03);
  const enSize = Math.round(W * 0.038);
  const pad = Math.round(W * 0.085);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:transparent;}
    .wrap{box-sizing:border-box;width:${W}px;height:${H}px;display:flex;flex-direction:column;
      align-items:center;justify-content:center;text-align:center;padding:${pad}px;}
    .ar{font-family:'Amiri',serif;direction:rtl;color:#fff;font-size:${arSize}px;line-height:1.95;
      text-shadow:0 2px 22px rgba(0,0,0,.75);}
    .tl{font-family:serif;font-style:italic;color:#f1e7d2;font-size:${tlSize}px;margin-top:${Math.round(W * 0.03)}px;
      text-shadow:0 2px 14px rgba(0,0,0,.85);}
    .en{font-family:'Liberation Serif',serif;color:#fff;font-size:${enSize}px;margin-top:${Math.round(W * 0.025)}px;
      line-height:1.45;text-shadow:0 2px 14px rgba(0,0,0,.85);}
  </style></head><body><div class="wrap">
    ${arabic ? `<div class="ar">${esc(arabic)}</div>` : ''}
    ${translit ? `<div class="tl">${esc(translit)}</div>` : ''}
    ${translation ? `<div class="en">&ldquo;${esc(translation)}&rdquo;</div>` : ''}
  </div></body></html>`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: out, omitBackground: true });
  } finally {
    await browser.close();
  }
}

// ---------- routes ----------
app.get('/', (_req, res) => res.send('Quran Captions video server is running.'));

app.post('/render', async (req, res) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qc-'));
  try {
    let {
      arabic = '', translit = '', translation = '',
      audioUrls = [], background = 'nature',
      width = 1080, height = 1920,
    } = req.body || {};

    if (!Array.isArray(audioUrls) || audioUrls.length === 0) {
      return res.status(400).json({ error: 'audioUrls is required' });
    }

    // clamp resolution for the free tier
    let W = Math.max(360, Math.min(1080, parseInt(width) || 1080));
    let H = Math.max(360, Math.min(1920, parseInt(height) || 1920));
    const long = Math.max(W, H);
    if (long > MAX_LONG_SIDE) {
      const k = MAX_LONG_SIDE / long;
      W = Math.round((W * k) / 2) * 2;
      H = Math.round((H * k) / 2) * 2;
    }

    // 1) download + concatenate the ayah audio
    const listLines = [];
    for (let i = 0; i < audioUrls.length; i++) {
      const f = path.join(dir, `a${i}.mp3`);
      await download(audioUrls[i], f);
      listLines.push(`file '${f}'`);
    }
    await writeFile(path.join(dir, 'list.txt'), listLines.join('\n'));
    const audio = path.join(dir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c:a', 'libmp3lame', audio]);
    const dur = Math.max(1, await probeDuration(audio));

    // 2) moving background (Pexels if a key is set, else an animated gradient)
    const bg = path.join(dir, 'bg.mp4');
    let haveBg = false;
    if (PEXELS_KEY) {
      try {
        await fetchPexels(background, W >= H ? 'landscape' : 'portrait', bg);
        haveBg = true;
      } catch (e) {
        console.warn('Pexels fallback:', e.message);
      }
    }

    // 3) verse overlay
    const textPng = path.join(dir, 'text.png');
    await renderOverlay({ arabic, translit, translation, W, H, out: textPng });

    // 4) composite
    const out = path.join(dir, 'out.mp4');
    if (haveBg) {
      await run('ffmpeg', [
        '-y', '-stream_loop', '-1', '-i', bg, '-i', textPng, '-i', audio,
        '-filter_complex',
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
          `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.4:t=fill[b];[b][1:v]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]', '-map', '2:a', '-t', String(dur), '-r', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
      ]);
    } else {
      await run('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i',
        `gradients=s=${W}x${H}:speed=0.006:c0=0x0d2018:c1=0x2f7d5f:c2=0x0a1411:c3=0xd4b676:d=${dur}:r=30`,
        '-i', textPng, '-i', audio,
        '-filter_complex',
        `[0:v]drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.32:t=fill[b];[b][1:v]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]', '-map', '2:a', '-t', String(dur), '-r', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
      ]);
    }

    const buf = await readFile(out);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="verse.mp4"');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`Video server listening on ${PORT}`));
