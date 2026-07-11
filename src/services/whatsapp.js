// Atria Connect — WhatsApp vía Baileys (vinculación como WhatsApp Web).
// Sesión por sede en storage/wa-sessions/<propertyId>. Emite QR para el panel,
// reconecta automáticamente y enruta mensajes entrantes al asistente IA.
import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { upsertConversation, saveInbound, sendOutbound } from './inbox.js';
import { assistantReply } from './ai/assistant.js';

const SESSIONS_DIR = path.resolve('storage/wa-sessions');

// Estado en memoria por sede
const sessions = new Map(); // propertyId -> { sock, status, qrDataUrl, number, startedAt, lastError }

function state(propertyId) {
  if (!sessions.has(propertyId)) {
    sessions.set(propertyId, { sock: null, status: 'disconnected', qrDataUrl: null, number: null, startedAt: null, lastError: null });
  }
  return sessions.get(propertyId);
}

export function whatsappStatus(propertyId) {
  const s = state(propertyId);
  return { status: s.status, qr: s.qrDataUrl, number: s.number, lastError: s.lastError, enabled: config.whatsappEnabled };
}

export async function startWhatsApp(propertyId) {
  if (!config.whatsappEnabled) throw new Error('WhatsApp está deshabilitado por configuración (WHATSAPP_ENABLED=false)');
  const s = state(propertyId);
  if (s.status === 'connected' || s.status === 'connecting') return whatsappStatus(propertyId);

  s.status = 'connecting';
  s.lastError = null;
  s.qrDataUrl = null;
  s.startedAt = new Date();

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } =
    await import('@whiskeysockets/baileys');

  const authDir = path.join(SESSIONS_DIR, propertyId);
  fs.mkdirSync(authDir, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }

  const sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    browser: ['Atria Hospitality OS', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    logger: logger.child({ mod: 'baileys', propertyId }, { level: 'warn' }),
  });
  s.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      s.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      s.status = 'qr';
      logger.info({ propertyId }, 'whatsapp QR generated — escanéalo desde el panel');
    }
    if (connection === 'open') {
      s.status = 'connected';
      s.qrDataUrl = null;
      s.number = sock.user?.id?.split(':')[0] || null;
      logger.info({ propertyId, number: s.number }, 'whatsapp connected');
      await prisma.property.update({ where: { id: propertyId }, data: { whatsappNumber: s.number } }).catch(() => {});
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      s.status = 'disconnected';
      s.sock = null;
      s.lastError = lastDisconnect?.error?.message || null;
      logger.warn({ propertyId, statusCode, loggedOut }, 'whatsapp connection closed');
      if (loggedOut) {
        // Sesión cerrada desde el teléfono: limpiar credenciales
        fs.rmSync(authDir, { recursive: true, force: true });
        s.qrDataUrl = null;
      } else {
        // Reconexión automática con retardo
        setTimeout(() => startWhatsApp(propertyId).catch(err => {
          s.lastError = err.message;
          logger.error({ err, propertyId }, 'whatsapp reconnect failed');
        }), 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncoming(propertyId, sock, msg);
      } catch (err) {
        logger.error({ err, propertyId }, 'whatsapp inbound handling failed');
      }
    }
  });

  return whatsappStatus(propertyId);
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || null;
}

async function handleIncoming(propertyId, sock, msg) {
  if (msg.key.fromMe) return;
  const jid = msg.key.remoteJid || '';
  if (!jid.endsWith('@s.whatsapp.net')) return; // ignorar grupos, estados y broadcast

  const text = extractText(msg);
  if (!text) return;

  const phone = jid.split('@')[0];
  const contactName = msg.pushName || null;

  const conversation = await upsertConversation({
    propertyId, channel: 'whatsapp', contactId: jid, contactName, contactPhone: phone,
  });
  await saveInbound(conversation.id, text);
  await sock.readMessages([msg.key]).catch(() => {});

  // Si la conversación está tomada por un humano, la IA no responde (sección 13)
  const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  if (!fresh.aiEnabled) return;

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  const { replies } = await assistantReply({ propertyId, conversation: fresh, text });
  for (const reply of replies) {
    await sendOutbound(conversation.id, reply, { sender: 'ai' });
  }
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

export async function sendWhatsAppMessage(propertyId, jid, text) {
  const s = state(propertyId);
  if (!s.sock || s.status !== 'connected') {
    throw new Error('WhatsApp no está conectado para esta sede. Vincula el número desde el panel (Inbox → WhatsApp).');
  }
  await s.sock.sendMessage(jid, { text });
}

export async function logoutWhatsApp(propertyId) {
  const s = state(propertyId);
  if (s.sock) {
    try { await s.sock.logout(); } catch { /* ya desconectado */ }
  }
  const authDir = path.join(SESSIONS_DIR, propertyId);
  fs.rmSync(authDir, { recursive: true, force: true });
  sessions.set(propertyId, { sock: null, status: 'disconnected', qrDataUrl: null, number: null, startedAt: null, lastError: null });
  return whatsappStatus(propertyId);
}

// Reanudar sesiones existentes al arrancar el servidor
export async function resumeSavedSessions() {
  if (!config.whatsappEnabled) return;
  if (!fs.existsSync(SESSIONS_DIR)) return;
  for (const propertyId of fs.readdirSync(SESSIONS_DIR)) {
    const credsFile = path.join(SESSIONS_DIR, propertyId, 'creds.json');
    if (fs.existsSync(credsFile)) {
      logger.info({ propertyId }, 'resuming saved whatsapp session');
      startWhatsApp(propertyId).catch(err => logger.error({ err, propertyId }, 'resume failed'));
    }
  }
}
