// Seed: empresa demo, sede, habitaciones, tarifas, usuarios y parámetros
// legales 2026 (valores de ejemplo — actualizar con fuentes oficiales).
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.company.findFirst();
  if (existing) {
    console.log('Seed ya aplicado (empresa existente). Nada que hacer.');
    return;
  }

  const company = await prisma.company.create({
    data: {
      name: 'Hotel Atria Demo S.A.S.',
      nit: '901234567-8',
      legalRep: 'Representante Demo',
      address: 'Cra 7 # 12-34',
      city: 'Bogotá',
      email: 'demo@atria.co',
    },
  });

  const property = await prisma.property.create({
    data: {
      companyId: company.id,
      name: 'Atria Hotel Bogotá',
      address: 'Cra 7 # 12-34, Chapinero',
      city: 'Bogotá',
      rnt: 'RNT-123456',
      rntExpiresAt: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 31)),
      taxRate: 0.19,
    },
  });

  // Tipos de habitación
  const std = await prisma.roomType.create({
    data: { propertyId: property.id, name: 'Estándar', code: 'STD', capacity: 2, baseRate: 220000, description: 'Cama queen, baño privado, TV, WiFi' },
  });
  const sup = await prisma.roomType.create({
    data: { propertyId: property.id, name: 'Superior', code: 'SUP', capacity: 3, baseRate: 320000, description: 'Cama king + sofá cama, vista ciudad' },
  });
  const ste = await prisma.roomType.create({
    data: { propertyId: property.id, name: 'Suite', code: 'STE', capacity: 4, baseRate: 480000, description: 'Sala independiente, jacuzzi, minibar premium' },
  });

  // Habitaciones (10)
  const roomsSpec = [
    ['101', std], ['102', std], ['103', std], ['104', std],
    ['201', sup], ['202', sup], ['203', sup],
    ['301', ste], ['302', ste], ['303', ste],
  ];
  for (const [number, rt] of roomsSpec) {
    await prisma.room.create({ data: { propertyId: property.id, roomTypeId: rt.id, number, floor: number[0] } });
  }

  // Planes tarifarios
  for (const [rt, flexPrice, nrPrice] of [[std, 220000, 190000], [sup, 320000, 280000], [ste, 480000, 430000]]) {
    await prisma.ratePlan.create({
      data: { propertyId: property.id, roomTypeId: rt.id, name: 'Flexible', code: `${rt.code}-FLEX`, price: flexPrice, refundable: true, depositPct: 0.5 },
    });
    await prisma.ratePlan.create({
      data: { propertyId: property.id, roomTypeId: rt.id, name: 'No reembolsable', code: `${rt.code}-NR`, price: nrPrice, refundable: false, depositPct: 1.0 },
    });
  }

  // Usuarios por rol (contraseña: atria2026)
  const pass = await bcrypt.hash('atria2026', 10);
  const users = [
    ['Dueño Demo', 'owner@atria.co', 'OWNER'],
    ['Gerente Demo', 'gerente@atria.co', 'MANAGER'],
    ['Recepción Demo', 'recepcion@atria.co', 'FRONTDESK'],
    ['Ventas Demo', 'ventas@atria.co', 'SALES'],
    ['Housekeeping Demo', 'housekeeping@atria.co', 'HOUSEKEEPING'],
    ['Contabilidad Demo', 'contabilidad@atria.co', 'ACCOUNTING'],
    ['Auditor Demo', 'auditor@atria.co', 'AUDITOR'],
  ];
  for (const [name, email, role] of users) {
    await prisma.user.create({ data: { companyId: company.id, name, email, passwordHash: pass, role } });
  }

  // Parámetros legales versionados (valores de ejemplo para 2026 — validar con
  // fuentes oficiales antes de usar en producción; sección 3 del doc funcional)
  const year = new Date().getUTCFullYear();
  const params = [
    ['SMMLV', 1623500, 'COP', 'Salario mínimo mensual legal vigente (ejemplo)'],
    ['AUX_TRANSPORTE', 200000, 'COP', 'Auxilio de transporte (ejemplo)'],
    ['UVT', 52374, 'COP', 'Unidad de Valor Tributario (ejemplo)'],
    ['IVA_GENERAL', 0.19, '%', 'Tarifa general IVA'],
    ['FONTUR_TARIFA', 0.0025, '%', 'Contribución parafiscal turismo (2.5 x mil, ejemplo)'],
    ['RECARGO_NOCTURNO', 0.35, '%', 'Recargo nocturno (ejemplo)'],
    ['HORA_EXTRA_DIURNA', 0.25, '%', 'Recargo hora extra diurna (ejemplo)'],
  ];
  for (const [key, value, unit, source] of params) {
    await prisma.legalParameter.create({
      data: { companyId: company.id, key, value, unit, validFrom: new Date(Date.UTC(year, 0, 1)), source, updatedBy: 'seed' },
    });
  }

  console.log('✅ Seed completado.');
  console.log(`   Empresa: ${company.name}`);
  console.log(`   Sede:    ${property.name} (${property.id})`);
  console.log('   Usuarios (contraseña: atria2026):');
  for (const [, email, role] of users) console.log(`     - ${email} (${role})`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
