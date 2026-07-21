// Catálogo de servicios/áreas del ecosistema (§55.1). Cada hotel puede habilitar
// un subconjunto distinto (no todos prestan restaurante, eventos, spa…) y el
// superadmin define, por usuario, a qué áreas accede. Un "servicio" agrupa uno o
// más dominios de permiso (los que ya usa el motor de roles en auth.js).
//
// Fuente única de verdad: el frontend arma la navegación y el backend hace el
// gating a partir de este mismo mapa.

export const SERVICES = [
  { key: 'reservations', label: 'Reservas y habitaciones', domains: ['reservations', 'booking', 'rooms', 'guests'] },
  { key: 'housekeeping', label: 'Housekeeping', domains: ['housekeeping'] },
  { key: 'maintenance', label: 'Mantenimiento', domains: ['maintenance'] },
  { key: 'crm', label: 'CRM y conversaciones', domains: ['crm', 'inbox', 'whatsapp'] },
  { key: 'marketing', label: 'Marketing y contenido', domains: ['marketing', 'content'] },
  { key: 'reputation', label: 'Reputación', domains: ['reputation'] },
  { key: 'events', label: 'Eventos y grupos', domains: ['events'] },
  { key: 'restaurant', label: 'Restaurante y POS', domains: ['pos', 'inventory'] },
  { key: 'revenue', label: 'Revenue y canales', domains: ['revenue', 'channels'] },
  { key: 'finance', label: 'Finanzas y pagos', domains: ['finance', 'payments', 'invoices'] },
  { key: 'hr', label: 'Talento humano', domains: ['hr', 'payroll', 'sgsst'] },
  { key: 'compliance', label: 'Cumplimiento', domains: ['compliance', 'fontur', 'dataprotection', 'documents'] },
  { key: 'automations', label: 'Automatizaciones e integraciones', domains: ['automations', 'integrations'] },
];

// Dominios que son parte del núcleo del sistema y no dependen de ningún servicio
// contratable: siempre disponibles si el rol los permite (panel, aprobaciones,
// auditoría, ajustes, notificaciones, usuarios).
export const CORE_DOMAINS = new Set(['dashboard', 'approvals', 'audit', 'settings', 'notifications', 'users']);

export const SERVICE_KEYS = SERVICES.map((s) => s.key);

// Servicios de cara al huésped, para reflejarlos en el sitio público (§14/§55.1).
// Subconjunto del catálogo con etiqueta e ícono amables para el cliente. Solo se
// muestran los que la sede tiene habilitados (y no estén apagados globalmente).
export const GUEST_SERVICES = [
  { key: 'reservations', icon: '🛏️', label: 'Alojamiento', blurb: 'Habitaciones cómodas y reserva directa sin comisiones.' },
  { key: 'restaurant', icon: '🍽️', label: 'Restaurante', blurb: 'Gastronomía y experiencias dentro del hotel.' },
  { key: 'events', icon: '🎉', label: 'Eventos y salones', blurb: 'Bodas, reuniones y celebraciones a tu medida.' },
];

// Mapa inverso dominio -> clave de servicio.
export const DOMAIN_SERVICE = (() => {
  const m = {};
  for (const s of SERVICES) for (const d of s.domains) m[d] = s.key;
  return m;
})();

// Servicio al que pertenece un permiso ("crm.view" -> "crm"). Devuelve null si el
// dominio es núcleo o no está mapeado (en cuyo caso no se aplica gating de servicio).
export function serviceForPermission(perm) {
  const domain = String(perm || '').split('.')[0];
  if (CORE_DOMAINS.has(domain)) return null;
  return DOMAIN_SERVICE[domain] || null;
}

// Normaliza un valor almacenado (JSON string, CSV o null) a un array de claves
// válidas. null/undefined => null (= "todos"). Cualquier otra cosa => array.
export function parseServiceList(raw) {
  if (raw == null) return null;
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else {
    const s = String(raw).trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      arr = Array.isArray(parsed) ? parsed : [s];
    } catch {
      arr = s.split(',');
    }
  }
  const valid = arr.map((x) => String(x).trim()).filter((x) => SERVICE_KEYS.includes(x));
  return valid;
}

// Serializa una lista de servicios para persistir (null => null = "todos").
export function serializeServiceList(list) {
  if (list == null) return null;
  const valid = (Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter((x) => SERVICE_KEYS.includes(x));
  return JSON.stringify(valid);
}
