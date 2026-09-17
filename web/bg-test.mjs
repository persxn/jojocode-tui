/**
 * The backdrop, checked the only way that means anything: in a browser.
 *
 * Two things are asserted, and the first one is the bug that prompted this
 * file — the old loop stopped animating past `scrollY > innerHeight * 1.6`, so
 * the page froze mid-motion once you had read two screens.
 *
 *   1. It is still moving at the bottom of the page.
 *   2. The shaders compile and nothing throws (a broken shader in three.js is
 *      a console error and a blank canvas, not an exception, so the pixels are
 *      what has to be inspected).
 *
 *   node web/bg-test.mjs [url]        # default http://127.0.0.1:7420/
 *
 * Needs playwright. It is not a dependency of this repo — the landing page
 * ships as one static file with no build step, and that is worth keeping — so
 * point NODE_PATH at an install that has it:
 *
 *   NODE_PATH=../JojoCode/node_modules node web/bg-test.mjs
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:7420/';

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright not found — see the header of this file');
  process.exit(2);
});

// Headless Chromium has no GPU; SwiftShader gives it a real WebGL context.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/**
 * Read the canvas the way a person does: off the screen.
 *
 * `gl.readPixels` is no use here. The page creates its context without
 * `preserveDrawingBuffer`, so the drawing buffer is empty by the time any
 * later task can look at it — it reads back all zeros however well the thing
 * is working. A screenshot is the composited frame, which is the thing under
 * test anyway.
 *
 * Everything but the canvas is hidden first (`visibility`, so the layout and
 * the scroll position stay put): the page has a blinking cursor and two
 * drifting gradients of its own, and either would answer "yes, pixels are
 * changing" whether or not the backdrop ever drew a frame.
 */
async function isolate(page) {
  await page.evaluate(() => {
    for (const el of document.body.children) {
      if (el.id !== 'bg') el.style.visibility = 'hidden';
    }
  });
}

async function stats(page, clip) {
  const png = (await page.screenshot({ clip, type: 'png' })).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0, lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      // The page background is a near-black green; an ember is green *above*
      // it. Score the excess, so the background contributes nothing.
      const v = Math.max(0, data[i + 1] - 24) + Math.max(0, data[i] - 16) + Math.max(0, data[i + 2] - 20);
      sum += v;
      if (v > 10) lit++;
    }
    return { sum, lit };
  }, png);
}

for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
  console.log(`\n${label} ${width}x${height}`);
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/status\.json|favicon|404/.test(t)) errors.push(t);
  });

  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  const webgl = await page.evaluate(() => {
    const c = document.getElementById('bg');
    return !!(c && (c.getContext('webgl2') || c.getContext('webgl')));
  });
  check(webgl, 'the canvas has a WebGL context');

  const clip = { x: width / 2 - 140, y: height / 2 - 140, width: 280, height: 280 };

  // The regression: two screens down, where the old code stopped rendering.
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);
  await isolate(page);
  const a = await stats(page, clip);
  await page.waitForTimeout(800);
  const b = await stats(page, clip);
  check(a.lit > 0, 'embers are drawn at the bottom of the page', `${a.lit} lit pixels`);
  check(a.sum !== b.sum, 'still animating after scrolling to the bottom',
        `frame brightness ${a.sum} → ${b.sum}`);

  // And at the top, where it always worked.
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(600);
  const c1 = await stats(page, clip);
  await page.waitForTimeout(800);
  const c2 = await stats(page, clip);
  check(c1.lit > 0 && c1.sum !== c2.sum, 'still animating at the top',
        `frame brightness ${c1.sum} → ${c2.sum}`);

  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// prefers-reduced-motion: one frame, then stillness — not a blank page.
{
  console.log('\nprefers-reduced-motion: reduce');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await isolate(page);
  const clip = { x: 500, y: 260, width: 280, height: 280 };
  const s1 = await stats(page, clip);
  await page.waitForTimeout(900);
  const s2 = await stats(page, clip);
  check(s1.lit > 0, 'the still frame is drawn', `${s1.lit} lit pixels`);
  check(s1.sum === s2.sum, 'and it does not move');
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
