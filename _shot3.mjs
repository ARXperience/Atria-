import { chromium } from 'playwright-core';
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = 'http://localhost:4000';
const OUT = '/tmp/claude-0/-home-user-Atria-/72a7b9c5-13ae-54be-a007-983b12a16a20/scratchpad';
const login = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gerente@atria.co', password: 'atria2026' }) })).json();
const pid = login.properties[0].id;
const H = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
// publicar sitio con contenido
await fetch(`${BASE}/api/content/site`, { method: 'PUT', headers: H, body: JSON.stringify({ propertyId: pid, heroTitle: 'Vive Bogotá desde el corazón de la ciudad', heroSubtitle: 'Reserva directa sin comisiones de intermediarios', promoText: '10% de descuento reservando directo', published: true }) });
// dar contenido a una habitación
const rooms = await (await fetch(`${BASE}/api/content/rooms?propertyId=${pid}`, { headers: H })).json();
await fetch(`${BASE}/api/content/rooms/${rooms[0].id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ longDescription: 'Amplia habitación con cama king, vista a la ciudad y wifi de alta velocidad.', bedConfig: '1 cama king', view: 'ciudad', features: 'wifi,aire,minibar' }) });
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
await page.goto(`${BASE}/sitio/${pid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/shot-site.png`, fullPage: false });
await browser.close();
console.log('site shot OK');
