import { chromium } from 'playwright-core';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://localhost:4000';
const OUT = '/tmp/claude-0/-home-user-Atria-/72a7b9c5-13ae-54be-a007-983b12a16a20/scratchpad';

const login = await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'gerente@atria.co', password: 'atria2026' }),
})).json();
const token = login.token, pid = login.properties[0].id;
const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

// Preparar habitaciones que requieren atención (para ver los puntos pulsantes)
const rooms = await (await fetch(`${BASE}/api/admin/rooms?propertyId=${pid}`, { headers: H })).json();
await fetch(`${BASE}/api/admin/rooms/${rooms[3].id}/status`, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'dirty' }) });
await fetch(`${BASE}/api/admin/rooms/${rooms[8].id}/status`, { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'out_of_service' }) });

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

// Login por la UI para disparar la animación de bienvenida
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#email', 'gerente@atria.co');
await page.fill('#password', 'atria2026');
await page.click('#loginBtn');
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/shot-welcome.png` });

await page.waitForTimeout(2300);
await page.screenshot({ path: `${OUT}/shot-dashboard.png` });

await page.evaluate(() => (location.hash = 'rooms'));
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/shot-rooms.png` });

// Webchat con respuesta retardada para capturar el "escribiendo…"
const chat = await browser.newPage({ viewport: { width: 520, height: 820 } });
await chat.route('**/api/public/webchat/**', async route => {
  if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, 1600));
  route.continue();
});
await chat.goto(`${BASE}/chat.html?propertyId=${pid}`, { waitUntil: 'networkidle' });
await chat.fill('#text', '¿Tienen parqueadero?');
await chat.click('#send');
await chat.waitForTimeout(550);
await chat.screenshot({ path: `${OUT}/shot-chat-typing.png` });
await chat.waitForTimeout(1700);
await chat.screenshot({ path: `${OUT}/shot-chat-reply.png` });

await browser.close();
console.log('screenshots OK');
