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

// Free-tier safety: cap the longest side so a render fits in 512MB memory.
// If you upgrade the Render instance, you can raise this (e.g. 1280 or 1920).
const MAX_LONG_SIDE = 960;

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
async function renderOverlay({ arabic, translit, translation, W, H, out, arFactor = 0.064, position = 'middle', color = '#ffffff' }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const arSize = Math.max(12, Math.round(W * arFactor));
  const tlSize = Math.round(arSize * 0.46);
  const enSize = Math.round(arSize * 0.6);
  const pad = Math.round(W * 0.085);
  const justify = position === 'top' ? 'flex-start' : position === 'bottom' ? 'flex-end' : 'center';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:transparent;}
    .wrap{box-sizing:border-box;width:${W}px;height:${H}px;display:flex;flex-direction:column;
      align-items:center;justify-content:${justify};text-align:center;padding:${pad}px;}
    .ar{font-family:'Amiri',serif;direction:rtl;color:${color};font-size:${arSize}px;line-height:1.95;
      text-shadow:0 2px 22px rgba(0,0,0,.75);}
    .tl{font-family:serif;font-style:italic;color:${color};opacity:.9;font-size:${tlSize}px;margin-top:${Math.round(W * 0.03)}px;
      text-shadow:0 2px 14px rgba(0,0,0,.85);}
    .en{font-family:'Liberation Serif',serif;color:${color};font-size:${enSize}px;margin-top:${Math.round(W * 0.025)}px;
      line-height:1.45;text-shadow:0 2px 14px rgba(0,0,0,.85);}
  </style></head><body><div class="wrap">
    ${arabic ? `<div class="ar">${esc(arabic)}</div>` : ''}
    ${translit ? `<div class="tl">${esc(translit)}</div>` : ''}
    ${translation ? `<div class="en">&ldquo;${esc(translation)}&rdquo;</div>` : ''}
  </div></body></html>`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(0);
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 0 });
    await page.evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()));
    await page.screenshot({ path: out, omitBackground: true });
  } finally {
    await browser.close();
  }
}

// Build one ASS Style line.
function assStyle(name, { fontSize, color, align, marginV, marginLR, italic = 0 }) {
  return `Style: ${name},Amiri,${fontSize},${assColor(color)},&H50FFFFFF,&H00000000,&H78000000,0,${italic},0,0,100,100,0,0,1,3,1,${align},${marginLR},${marginLR},${marginV},1`;
}

// Build an ASS subtitle file from ready-made Style + Dialogue lines and burn it over a
// moving background (Pexels or gradient) with the audio. libass shapes Arabic correctly.
async function composeWithAss(dir, { W, H, stylesBlock, dialogues, audio, totalSec, background }) {
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${stylesBlock}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogues.join('\n')}
`;
  const assPath = path.join(dir, 'subs.ass');
  await writeFile(assPath, ass);

  const bg = path.join(dir, 'bg.mp4');
  let haveBg = false;
  if (PEXELS_KEY) {
    try { await fetchPexels(background, W >= H ? 'landscape' : 'portrait', bg); haveBg = true; }
    catch (e) { console.warn('Pexels fallback:', e.message); }
  }

  const out = path.join(dir, 'out.mp4');
  const assFilter = `subtitles=${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`;
  if (haveBg) {
    await run('ffmpeg', [
      '-y', '-stream_loop', '-1', '-i', bg, '-i', audio,
      '-filter_complex',
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
        `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.4:t=fill,${assFilter}[v]`,
      '-map', '[v]', '-map', '1:a', '-t', String(totalSec), '-r', '30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
    ]);
  } else {
    await run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i',
      `gradients=s=${W}x${H}:speed=0.006:c0=0x0d2018:c1=0x2f7d5f:c2=0x0a1411:c3=0xd4b676:d=${totalSec}:r=30`,
      '-i', audio,
      '-filter_complex', `[0:v]drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.32:t=fill,${assFilter}[v]`,
      '-map', '[v]', '-map', '1:a', '-t', String(totalSec), '-r', '30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
    ]);
  }
  return out;
}

// Escape text for an ASS event (newlines -> \N, strip braces).
function assText(s) {
  return String(s || '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
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
      arFactor = 0.064, position = 'middle', color = '#ffffff',
      synced = false, lines = [],
    } = req.body || {};

    const useSynced = synced && Array.isArray(lines) && lines.length > 0;
    if (!useSynced && (!Array.isArray(audioUrls) || audioUrls.length === 0)) {
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

    // ----- TIMED BLOCKS: each ayah shows for its own recitation window, then disappears -----
    if (useSynced) {
      const listLines = [];
      const dialogues = [];
      let offMs = 0;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const f = path.join(dir, `a${i}.mp3`);
        await download(ln.audioUrl, f);
        listLines.push(`file '${f}'`);
        const durMs = (await probeDuration(f)) * 1000;
        const parts = [];
        if (ln.arabic) parts.push(assText(ln.arabic));
        if (ln.translit) parts.push('{\\i1}' + assText(ln.translit) + '{\\i0}');
        if (ln.translation) parts.push('\u201c' + assText(ln.translation) + '\u201d');
        dialogues.push(`Dialogue: 0,${assTime(offMs)},${assTime(offMs + durMs)},AR,,0,0,0,,${parts.join('\\N')}`);
        offMs += durMs;
      }
      await writeFile(path.join(dir, 'list.txt'), listLines.join('\n'));
      const audioS = path.join(dir, 'audio.mp3');
      await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c:a', 'libmp3lame', audioS]);
      const fontSizePx = Math.max(14, Math.round(W * (arFactor || 0.064)));
      const align = position === 'top' ? 8 : position === 'bottom' ? 2 : 5;
      const stylesBlock = assStyle('AR', { fontSize: fontSizePx, color, align, marginV: Math.round(H * 0.12), marginLR: Math.round(W * 0.07) });
      const out = await composeWithAss(dir, {
        W, H, stylesBlock, dialogues,
        audio: audioS, totalSec: Math.max(1, offMs / 1000), background,
      });
      const buf = await readFile(out);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="verse.mp4"');
      return res.send(buf);
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
    await renderOverlay({ arabic, translit, translation, W, H, out: textPng, arFactor, position, color });

    // 4) composite
    const out = path.join(dir, 'out.mp4');
    if (haveBg) {
      await run('ffmpeg', [
        '-y', '-stream_loop', '-1', '-i', bg, '-i', textPng, '-i', audio,
        '-filter_complex',
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
          `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.4:t=fill[b];[b][1:v]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]', '-map', '2:a', '-t', String(dur), '-r', '30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
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
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
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

// ===================== WORD-BY-WORD KARAOKE =====================
// Uses Quran.com word-timing segments + ASS karaoke subtitles burned by FFmpeg (libass).

function assColor(hex) {
  const h = String(hex).replace('#', '');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
function assTime(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// Fetch words + audio URL + word-timing segments for one ayah from Quran.com.
async function fetchVerseTiming(recitationId, key, withTranslation = false) {
  const tr = withTranslation ? '&translations=20' : ''; // 20 = Saheeh International
  const url = `https://api.quran.com/api/v4/verses/by_key/${key}?words=true&word_fields=text_uthmani&audio=${recitationId}${tr}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`quran.com ${r.status} for ${key}`);
  const j = await r.json();
  const v = j.verse || {};
  const words = (v.words || [])
    .filter((w) => (w.char_type_name || w.char_type) === 'word')
    .map((w) => w.text_uthmani || w.text || '');
  const audio = v.audio || {};
  const audioUrl = audio.url ? (String(audio.url).startsWith('http') ? audio.url : 'https://verses.quran.com/' + audio.url) : null;
  const segments = audio.segments || [];
  const translation = (withTranslation && v.translations && v.translations[0])
    ? String(v.translations[0].text).replace(/<[^>]*>/g, '').trim()
    : '';
  return { words, audioUrl, segments, translation };
}

app.post('/render-karaoke', async (req, res) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qk-'));
  try {
    let {
      recitationId = 7, verseKeys = [], background = 'nature',
      width = 1080, height = 1920, color = '#d4b676', position = 'middle',
    } = req.body || {};
    if (!Array.isArray(verseKeys) || verseKeys.length === 0) {
      return res.status(400).json({ error: 'verseKeys is required' });
    }

    let W = Math.max(360, Math.min(1080, parseInt(width) || 1080));
    let H = Math.max(360, Math.min(1920, parseInt(height) || 1920));
    const long = Math.max(W, H);
    if (long > MAX_LONG_SIDE) {
      const k = MAX_LONG_SIDE / long;
      W = Math.round((W * k) / 2) * 2;
      H = Math.round((H * k) / 2) * 2;
    }

    // 1) fetch timing + download each ayah's audio
    const listLines = [];
    const dialogues = [];
    let offsetMs = 0;
    for (let i = 0; i < verseKeys.length; i++) {
      const { words, audioUrl, segments } = await fetchVerseTiming(recitationId, verseKeys[i]);
      if (!audioUrl) throw new Error(`no audio for ${verseKeys[i]} (try another reciter)`);
      const f = path.join(dir, `a${i}.mp3`);
      await download(audioUrl, f);
      listLines.push(`file '${f}'`);
      const durMs = (await probeDuration(f)) * 1000;

      // word index -> [startMs, endMs] (relative to this ayah)
      const segByWord = {};
      for (const s of segments) {
        if (Array.isArray(s) && s.length >= 3) {
          const idx = s[0];
          if (idx >= 1) segByWord[idx] = [s[1], s[2]];
        }
      }
      // build karaoke tokens; fall back to even split if timing is missing
      const n = words.length || 1;
      let cursor = 0;
      const tokens = words.map((w, wi) => {
        let st, en;
        if (segByWord[wi + 1]) { [st, en] = segByWord[wi + 1]; }
        else { st = (durMs * wi) / n; en = (durMs * (wi + 1)) / n; }
        const lead = Math.max(0, Math.round((st - cursor) / 10));
        const dur = Math.max(1, Math.round((en - st) / 10));
        cursor = en;
        return `${lead ? `{\\k${lead}}` : ''}{\\k${dur}}${w}`;
      });
      dialogues.push(`Dialogue: 0,${assTime(offsetMs)},${assTime(offsetMs + durMs)},AR,,0,0,0,,${tokens.join(' ')}`);
      offsetMs += durMs;
    }

    await writeFile(path.join(dir, 'list.txt'), listLines.join('\n'));
    const audio = path.join(dir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c:a', 'libmp3lame', audio]);
    const totalSec = Math.max(1, offsetMs / 1000);

    // 2) write the ASS karaoke file
    const fontSize = Math.round(W * 0.075);
    const align = position === 'top' ? 8 : position === 'bottom' ? 2 : 5;
    const marginV = Math.round(H * 0.12);
    const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: AR,Amiri,${fontSize},${assColor(color)},&H50FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,0,0,1,3,1,${align},60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogues.join('\n')}
`;
    const assPath = path.join(dir, 'karaoke.ass');
    await writeFile(assPath, ass);

    // 3) background (Pexels or gradient)
    const bg = path.join(dir, 'bg.mp4');
    let haveBg = false;
    if (PEXELS_KEY) {
      try { await fetchPexels(background, W >= H ? 'landscape' : 'portrait', bg); haveBg = true; }
      catch (e) { console.warn('Pexels fallback:', e.message); }
    }

    // 4) compose: background + dark scrim + burned karaoke subtitles + audio
    const out = path.join(dir, 'out.mp4');
    const assFilter = `subtitles=${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}`;
    if (haveBg) {
      await run('ffmpeg', [
        '-y', '-stream_loop', '-1', '-i', bg, '-i', audio,
        '-filter_complex',
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
          `drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.4:t=fill,${assFilter}[v]`,
        '-map', '[v]', '-map', '1:a', '-t', String(totalSec), '-r', '30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
      ]);
    } else {
      await run('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i',
        `gradients=s=${W}x${H}:speed=0.006:c0=0x0d2018:c1=0x2f7d5f:c2=0x0a1411:c3=0xd4b676:d=${totalSec}:r=30`,
        '-i', audio,
        '-filter_complex', `[0:v]drawbox=x=0:y=0:w=${W}:h=${H}:color=black@0.32:t=fill,${assFilter}[v]`,
        '-map', '[v]', '-map', '1:a', '-t', String(totalSec), '-r', '30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
      ]);
    }

    const buf = await readFile(out);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="verse-karaoke.mp4"');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ===================== PHRASE SEGMENTS (Quran Captions style) =====================
// Groups each ayah's words into short phrases shown in time with the recitation,
// large and centered, with the ayah translation underneath.
app.post('/render-segments', async (req, res) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qs-'));
  try {
    let {
      recitationId = 7, verseKeys = [], background = 'nature',
      width = 1080, height = 1920, color = '#ffffff', position = 'middle',
      wordsPerSegment = 4, showTranslation = false,
    } = req.body || {};
    if (!Array.isArray(verseKeys) || verseKeys.length === 0) {
      return res.status(400).json({ error: 'verseKeys is required' });
    }
    wordsPerSegment = Math.max(1, Math.min(8, parseInt(wordsPerSegment) || 4));

    let W = Math.max(360, Math.min(1080, parseInt(width) || 1080));
    let H = Math.max(360, Math.min(1920, parseInt(height) || 1920));
    const long = Math.max(W, H);
    if (long > MAX_LONG_SIDE) {
      const k = MAX_LONG_SIDE / long;
      W = Math.round((W * k) / 2) * 2;
      H = Math.round((H * k) / 2) * 2;
    }

    const listLines = [];
    const arDialogues = [];
    const trDialogues = [];
    let offMs = 0;

    for (let i = 0; i < verseKeys.length; i++) {
      const { words, audioUrl, segments, translation } = await fetchVerseTiming(recitationId, verseKeys[i], showTranslation);
      if (!audioUrl) throw new Error(`no audio for ${verseKeys[i]} (try another reciter)`);
      const f = path.join(dir, `a${i}.mp3`);
      await download(audioUrl, f);
      listLines.push(`file '${f}'`);
      const durMs = (await probeDuration(f)) * 1000;

      // per-word [start,end] relative to this ayah
      const segByWord = {};
      for (const s of segments) {
        if (Array.isArray(s) && s.length >= 3 && s[0] >= 1) segByWord[s[0]] = [s[1], s[2]];
      }
      const n = words.length || 1;
      const wt = words.map((w, wi) => {
        let st, en;
        if (segByWord[wi + 1]) { [st, en] = segByWord[wi + 1]; }
        else { st = (durMs * wi) / n; en = (durMs * (wi + 1)) / n; }
        return { w, st, en };
      });

      // group words into phrases (by count, or break on a long pause)
      let group = [];
      const flush = () => {
        if (!group.length) return;
        const st = group[0].st;
        const en = group[group.length - 1].en;
        const text = group.map((g) => g.w).join(' ');
        arDialogues.push(`Dialogue: 0,${assTime(offMs + st)},${assTime(offMs + en)},AR,,0,0,0,,${assText(text)}`);
        group = [];
      };
      for (let k = 0; k < wt.length; k++) {
        group.push(wt[k]);
        const gap = k + 1 < wt.length ? wt[k + 1].st - wt[k].en : 0;
        if (group.length >= wordsPerSegment || gap > 600) flush();
      }
      flush();

      if (showTranslation && translation) {
        trDialogues.push(`Dialogue: 0,${assTime(offMs)},${assTime(offMs + durMs)},TR,,0,0,0,,${assText(translation)}`);
      }
      offMs += durMs;
    }

    await writeFile(path.join(dir, 'list.txt'), listLines.join('\n'));
    const audio = path.join(dir, 'audio.mp3');
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-c:a', 'libmp3lame', audio]);

    const arFont = Math.round(W * 0.092);
    const trFont = Math.round(W * 0.034);
    const arAlign = position === 'top' ? 8 : position === 'bottom' ? 2 : 5;
    const arMarginV = showTranslation ? Math.round(H * 0.20) : Math.round(H * 0.12);
    const stylesBlock = [
      assStyle('AR', { fontSize: arFont, color, align: arAlign, marginV: arMarginV, marginLR: Math.round(W * 0.07) }),
      assStyle('TR', { fontSize: trFont, color, align: 2, marginV: Math.round(H * 0.09), marginLR: Math.round(W * 0.08), italic: 1 }),
    ].join('\n');

    const out = await composeWithAss(dir, {
      W, H, stylesBlock, dialogues: [...arDialogues, ...trDialogues],
      audio, totalSec: Math.max(1, offMs / 1000), background,
    });

    const buf = await readFile(out);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="verse-segments.mp4"');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e?.message || e) });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`Video server listening on ${PORT}`));
