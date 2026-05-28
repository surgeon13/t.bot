'use strict';

const fs = require('fs');
const path = require('path');
const { randomDelay, pause } = require('./utils');
const log = require('./logger');
const { getActiveControl, isTaskInterrupted } = require('./terminalControl');

const VIDEO_DIALOG_SELECTOR = [
  '.dialogWrapper.dialogV2 .dialog.videoFeature',
  '.dialog.basic.videoFeature',
  '.dialog.videoFeature',
  '#reactDialogWrapper .dialog.videoFeature',
  '.paymentShopV5 .videoFeature',
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
const VIDEO_APPEAR_TIMEOUT = 25_000;
const { DEBUG_DIR } = require('./paths');

/** Button labels on the pre-player info step (multiple languages). */
const WATCH_LABEL_PATTERNS = [
  /watch\s*video/i,
  /\bwatch\b/i,
  /\bvideo\b/i,
  /continue/i,
  /^ok$/i,
  /start/i,
  /play/i,
  /ansehen/i,
  /regarder/i,
  /ver/i,
];

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

async function detectVideoUi(page) {
  return page.evaluate(() => {
    const vis = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 8 && r.height > 8
        && st.visibility !== 'hidden'
        && st.display !== 'none'
        && parseFloat(st.opacity || '1') > 0.05;
    };

    const dialogs = Array.from(document.querySelectorAll(
      '#reactDialogWrapper .dialog, .dialogWrapper .dialog, .dialog.paymentShopV5, .dialog.videoFeature'
    ));
    const visibleDialogs = dialogs.filter(vis).map(d => ({
      class: (d.className || '').slice(0, 140),
      hasVideoArea: !!d.querySelector('#videoArea'),
      text: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    }));

    const buttons = Array.from(document.querySelectorAll(
      'button.dialogButtonOk, button.textButtonV2.purple, button.textButtonV2.green, button.textButtonV2'
    )).filter(vis).map(b => (b.innerText || '').trim().slice(0, 50));

    return {
      videoFeature: vis(document.querySelector('.dialog.videoFeature, .dialog.basic.videoFeature')),
      videoArea: vis(document.querySelector('#videoArea')),
      overlay: vis(document.querySelector('#dialogOverlay.dialogVisible, #dialogOverlay.enabled')),
      visibleDialogs,
      buttons,
    };
  }).catch(() => ({
    videoFeature: false,
    videoArea: false,
    overlay: false,
    visibleDialogs: [],
    buttons: [],
  }));
}

async function dumpVideoDialog(page, label) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ui = await detectVideoUi(page);
    const dialogHtml = await page
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll(
          '#reactDialogWrapper, .dialogWrapper, .dialog.videoFeature, .dialog.paymentShopV5, #videoArea'
        ));
        return nodes.map(el => (el.outerHTML || '').slice(0, 6000)).join('\n---\n') || null;
      })
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
      JSON.stringify({ ts: new Date().toISOString(), label, pageUrl: page.url(), ui, dialogHtml, frameInfo }, null, 2)
    );
    log.warn('video', `Saved video debug snapshot: ${file}`);
  } catch (err) {
    log.warn('video', `Could not write video debug snapshot: ${err.message}`);
  }
}

async function waitForVideoUiStart(page, timeoutMs = VIDEO_APPEAR_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await detectVideoUi(page);
    if (s.videoFeature || s.videoArea) {
      log.info('video', `Video layer detected (feature=${s.videoFeature}, #videoArea=${s.videoArea})`);
      return true;
    }
    if (s.buttons.some(t => WATCH_LABEL_PATTERNS.some(re => re.test(t)))) {
      log.info('video', `Pre-video dialog detected (buttons: ${s.buttons.slice(0, 3).join(' | ')})`);
      return true;
    }
    if (s.visibleDialogs.some(d => /video/i.test(d.class) || d.hasVideoArea)) {
      log.info('video', 'Nested dialog with video markup detected');
      return true;
    }
    await pause(280);
  }
  return false;
}

async function clickWatchVideoIfPresent(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await page.evaluate(() => {
      const vis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 8 && r.height > 8
          && st.visibility !== 'hidden'
          && st.display !== 'none';
      };
      const patterns = [
        /watch\s*video/i, /\bwatch\b/i, /\bvideo\b/i, /continue/i, /^ok$/i,
        /start/i, /play/i, /ansehen/i, /regarder/i, /\bver\b/i,
      ];
      const buttons = Array.from(document.querySelectorAll(
        'button.dialogButtonOk, button.textButtonV2.purple, button.textButtonV2.green, button.textButtonV2'
      ));
      for (const btn of buttons) {
        if (!vis(btn) || btn.disabled) continue;
        const t = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
        if (/cancel|close|abbrechen|schließen/i.test(t) && !/watch|video|ansehen/i.test(t)) continue;
        if (patterns.some(re => re.test(t))) {
          btn.click();
          return t.slice(0, 60);
        }
      }
      return null;
    }).catch(() => null);

    if (clicked) {
      log.info('video', `Clicked through dialog: "${clicked}"`);
      await randomDelay();
      const s = await detectVideoUi(page);
      if (s.videoArea || s.videoFeature) return true;
      continue;
    }

    try {
      const locators = [
        page.locator(WATCH_VIDEO_BTN).filter({ hasText: /watch/i }),
        page.locator(WATCH_VIDEO_BTN).filter({ hasText: /video/i }),
        page.locator('button.textButtonV2.purple').filter({ hasText: /watch|video/i }),
      ];
      for (const loc of locators) {
        const btn = loc.first();
        if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
          const text = (await btn.innerText().catch(() => '')).trim();
          log.info('video', `Clicking "${text.slice(0, 40)}" (playwright)`);
          await btn.click({ timeout: 8000 });
          await randomDelay();
          return true;
        }
      }
    } catch {
      /* try evaluate path again */
    }

    await pause(350);
  }
  return false;
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
    await pause(500);
  }
  return false;
}

async function waitForVideoUiGone(page) {
  await withTerminalControl(
    page.waitForFunction(() => {
      const vis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const checks = [
        '.dialog.basic.videoFeature',
        '.dialog.videoFeature',
        '#videoArea',
      ];
      const videoBlocking = checks.some(sel => vis(document.querySelector(sel)));
      if (videoBlocking) return false;
      const watchBtn = Array.from(document.querySelectorAll('button.dialogButtonOk')).find(b => {
        if (!vis(b)) return false;
        return /watch\s*video/i.test(b.innerText || '');
      });
      return !watchBtn;
    }, { timeout: VIDEO_TIMEOUT })
  );
}

async function waitForVideoToFinish(page) {
  log.info('video', 'Waiting for video UI after bonus click');

  let appeared = false;
  try {
    appeared = await waitForVideoUiStart(page);
  } catch (err) {
    if (isTaskInterrupted(err)) throw err;
  }

  if (!appeared) {
    try {
      await withTerminalControl(page.waitForSelector(VIDEO_DIALOG_SELECTOR, { state: 'visible', timeout: 5_000 }));
      appeared = true;
    } catch {
      /* fall through */
    }
  }

  if (!appeared) {
    log.warn('video', 'Video UI did not appear - skipping');
    await dumpVideoDialog(page, 'no-video-ui');
    return false;
  }

  await randomDelay();

  let clickedInfo = false;
  for (let step = 0; step < 6; step++) {
    const s = await detectVideoUi(page);
    if (s.videoArea) break;
    const advanced = await clickWatchVideoIfPresent(page);
    if (advanced) clickedInfo = true;
    else if (s.videoFeature) break;
    else if (step >= 2) break;
    await pause(400);
  }

  let playClicked = false;
  if (clickedInfo || (await detectVideoUi(page)).videoArea) {
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

module.exports = { waitForVideoToFinish, detectVideoUi, dumpVideoDialog };
