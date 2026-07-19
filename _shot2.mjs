import { chromium } from 'playwright-core';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://localhost:4000';
const OUT = '/tmp/claude-0/-home-user-Atria-/72a7b9c5-13ae-54be-a007-983b12a16a20/scratchpad';

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'gerente@atria.co', password: 'atria2026' }),
})).json();
const token = login.token, pid = login.properties[0].id;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(([t, u, props, p]) => {
  localStorage.setItem('atria_token', t);
  localStorage.setItem('atria_user', JSON.stringify(u));
  localStorage.setItem('atria_props', JSON.stringify(props));
  localStorage.setItem('atria_prop', p);
}, [token, login.user, login.properties, pid]);
await page.goto(BASE + '#copilot', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
// Preguntar por el estado de habitaciones
await page.fill('#copText', '¿Cómo están las habitaciones y las llegadas de hoy?');
await page.click('#copSend');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/shot-copilot.png` });
await browser.close();
console.log('copilot shot OK');
