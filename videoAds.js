'use strict';

const fs = require('fs');
const path = require('path');
const { randomDelay } = require('./utils');
const log = require('./logger');
const { getActiveControl, isTaskInterrupted } = require('./terminalControl');

const VIDEO_DIALOG = [
  '.dialogWrapper.dialogV2 .dialog.videoFeature',
  '.dialog.basic.videoFeature',
  '.dialog.videoFeature',
].join(', ');
const WATCH_VIDEO_BTN = 'button.dialogButtonOk';
const VIDEO_IFRAME = '#videoArea';
const PLAY_SELECTORS = [
  '.atg-gima-big-play-button',
  'button[aria-label*="Play" i]',
  '[class*="big-play" i]',
  '[class*="play-button" i]',
  '.vjs-big-play-button',
  'video',
];
const VIDEO_TIMEOUT = 2 * 60 * 1000;
const DEBUG_DIR = path.join(__dirname, 'debug');

function withTerminalControl(promise) {
  const control = getActiveControl();
  return control ? control.race(promise) : promise;
}

function isAdFrameUrl(url) {
  if (!url || url === 'about:blank') return false;
  if (/travian\.com/i.test(url)) return false;
  if (/consentmanager|cmp\.|quantcast|iubenda/i.test(url)) return false;
  return true;
}

async function dumpVideoDialog(page, label) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dialogHtml = await page
      .evaluate(sel => {
        const nodes = Array.from(document.querySelectorAll(sel.split(', ').join(',')));
        return nodes.map(el => (el.outerHTML || '').slice(0, 8000)).join('\n---\n') || null;
      }, VIDEO_DIALOG)
      .catch(() => null);

    const frameInfo = page.frames().map(f => ({
      url: (() => {
        try {
          return f.url();
        } catch {
          return null;
        }
      })(),
      name: f.name(),
    }));

    const file = path.join(DEBUG_DIR, `video-${label}-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), label, pageUrl: page.url(), dialogHtml, frameInfo }, null, 2)
    );
    log.warn('video', `Saved video debug snapshot: ${file}`);
  } catch (err) {
    log.warn('video', `Could not write video debug snapshot: ${err.message}`);
  }
}

async function clickWatchVideoIfPresent(page) {
  try {
    const btn = page.locator(WATCH_VIDEO_BTN).filter({ hasText: /watch video/i });
    await withTerminalControl(btn.waitFor({ state: 'visible', timeout: 8_000 }));
    log.info('video', 'Clicking "Watch video" on info screen');
    await btn.click({ timeout: 10_000 });
    await randomDelay();
    return true;
  } catch {
    return false;
  }
}

async function clickPlayInLocator(loc, label) {
  try {
    await withTerminalControl(loc.waitFor({ state: 'visible', timeout: 4_000 }));
    log.info('video', `Clicking play (${label})`);
    await loc.click({ timeout: 5_000 });
    await randomDelay();
    return true;
  } catch {
    return false;
  }
}

async function tryClickPlayInVideoIframe(page) {
  try {
    await withTerminalControl(page.waitForSelector(VIDEO_IFRAME, { state: 'attached', timeout: 25_000 }));
  } catch {
    return false;
  }

  const frame = page.frameLocator(VIDEO_IFRAME);
  for (const sel of PLAY_SELECTORS) {
    if (await clickPlayInLocator(frame.locator(sel).first(), sel)) return true;
  }

  try {
    const box = page.locator(VIDEO_IFRAME);
    if (await box.isVisible({ timeout: 1_000 })) {
      log.info('video', 'Clicking center of #videoArea');
      await box.click({ position: { x: 240, y: 135 }, timeout: 3_000 });
      await randomDelay();
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function tryClickPlayInAdFrames(page, deadlineMs = 25_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!isAdFrameUrl(frame.url())) continue;
      for (const sel of PLAY_SELECTORS) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.isVisible({ timeout: 400 })) {
            if (await clickPlayInLocator(loc, `${sel} @ ${frame.url().slice(0, 48)}`)) return true;
          }
        } catch {
          /* try next */
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForVideoUiGone(page) {
  await withTerminalControl(
    page.waitForFunction(
      () => {
        const checks = [
          '.dialog.basic.videoFeature',
          '.dialog.videoFeature',
          '#videoArea',
          'button.dialogButtonOk',
        ];
        return !checks.some(sel => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
        });
      },
      { timeout: VIDEO_TIMEOUT }
    )
  );
}

async function waitForVideoToFinish(page) {
  log.info('video', 'Waiting for video dialog to appear');
  try {
    await withTerminalControl(page.waitForSelector(VIDEO_DIALOG, { state: 'visible', timeout: 15_000 }));
  } catch (err) {
    if (isTaskInterrupted(err)) throw err;
    log.warn('video', 'Video dialog did not appear - skipping');
    return false;
  }
  await randomDelay();

  const clickedInfo = await clickWatchVideoIfPresent(page);

  let playClicked = false;
  if (clickedInfo) {
    playClicked = (await tryClickPlayInVideoIframe(page)) || (await tryClickPlayInAdFrames(page));
  } else {
    playClicked =
      (await tryClickPlayInVideoIframe(page)) ||
      (await tryClickPlayInAdFrames(page, 8_000));
  }

  if (!playClicked) {
    log.warn('video', 'Play button not found - video may auto-play; waiting for dialog to close');
    if (!clickedInfo) await dumpVideoDialog(page, 'no-play-button');
  }

  log.info('video', 'Waiting for video to finish');
  const t0 = Date.now();
  try {
    await waitForVideoUiGone(page);
    log.info('video', `Video finished after ~${Math.round((Date.now() - t0) / 1000)}s`);
    return true;
  } catch (err) {
    if (isTaskInterrupted(err)) throw err;
    log.warn('video', `Timed out after ${VIDEO_TIMEOUT / 1000}s - moving on`);
    await dumpVideoDialog(page, 'timeout');
    return false;
  }
}

module.exports = { waitForVideoToFinish };
