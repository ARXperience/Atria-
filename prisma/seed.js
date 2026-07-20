// Seed: empresa demo, sede, habitaciones, tarifas, usuarios y parámetros
// legales 2026 (valores de ejemplo — actualizar con fuentes oficiales).
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_PLANS } from '../src/services/saas.js';

const prisma = new PrismaClient();

async function ensurePlansAndSuperadmin(companyId) {
  if ((await prisma.plan.count()) === 0) {
    for (const p of DEFAULT_PLANS) await prisma.plan.create({ data: p });
  }
  await prisma.company.update({ where: { id: companyId }, data: { planCode: 'pro', subStatus: 'active', currentPeriodEnd: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)) } }).catch(() => {});
  const exists = await prisma.user.findUnique({ where: { email: 'superadmin@atria.co' } });
  if (!exists) {
    const pass = await bcrypt.hash(process.env.SEED_PASSWORD || 'atria2026', 10);
    await prisma.user.create({ data: { companyId, name: 'Super Admin SaaS', email: 'superadmin@atria.co', passwordHash: pass, role: 'OWNER', isSuperAdmin: true } });
  }
}

// Parámetros de nómina colombiana (valores de ejemplo — validar con fuentes
// oficiales). Se aplican también sobre instalaciones existentes (idempotente).
const PAYROLL_PARAMS = [
  ['SALUD_EMPLEADO', 0.04, '%', 'Aporte salud empleado'],
  ['PENSION_EMPLEADO', 0.04, '%', 'Aporte pensión empleado'],
  ['FSP_UMBRAL_SMMLV', 4, 'SMMLV', 'Umbral Fondo de Solidaridad Pensional'],
  ['SALUD_EMPLEADOR', 0.085, '%', 'Aporte salud empleador (ver exoneración Ley 1607)'],
  ['PENSION_EMPLEADOR', 0.12, '%', 'Aporte pensión empleador'],
  ['CCF', 0.04, '%', 'Caja de compensación familiar'],
  ['SENA', 0.02, '%', 'Aporte SENA (ver exoneración)'],
  ['ICBF', 0.03, '%', 'Aporte ICBF (ver exoneración)'],
  ['ARL_CLASE_1', 0.00522, '%', 'ARL riesgo I'],
  ['ARL_CLASE_2', 0.01044, '%', 'ARL riesgo II'],
  ['ARL_CLASE_3', 0.02436, '%', 'ARL riesgo III'],
  ['ARL_CLASE_4', 0.0435, '%', 'ARL riesgo IV'],
  ['ARL_CLASE_5', 0.0696, '%', 'ARL riesgo V'],
  ['HORAS_MES', 220, 'horas', 'Horas mes jornada máxima (parametrizable según Ley 2101)'],
  ['HORA_EXTRA_NOCTURNA', 0.75, '%', 'Recargo hora extra nocturna'],
  ['RECARGO_DOMINICAL', 0.8, '%', 'Recargo dominical/festivo (Ley 2466 de 2025, ejemplo)'],
  ['PRIMA_PCT', 0.0833, '%', 'Provisión prima de servicios'],
  ['CESANTIAS_PCT', 0.0833, '%', 'Provisión cesantías'],
  ['INT_CESANTIAS_PCT', 0.01, '%', 'Provisión intereses de cesantías'],
  ['VACACIONES_PCT', 0.0417, '%', 'Provisión vacaciones'],
];

async function ensurePayrollParams(companyId) {
  const year = new Date().getUTCFullYear();
  for (const [key, value, unit, source] of PAYROLL_PARAMS) {
    const exists = await prisma.legalParameter.findFirst({ where: { companyId, key } });
    if (!exists) {
      await prisma.legalParameter.create({
        data: { companyId, key, value, unit, validFrom: new Date(Date.UTC(year, 0, 1)), source, updatedBy: 'seed' },
      });
    }
  }
}

async function ensureDemoEmployees(companyId, propertyId) {
  const count = await prisma.employee.count({ where: { companyId } });
  if (count > 0) return;
  const demo = [
    ['Laura Rodríguez', '52111222', 'Recepcionista', 'recepción', 1800000, 1],
    ['Carlos Muñoz', '79333444', 'Camarero de pisos', 'housekeeping', 1623500, 2],
  ];
  for (const [fullName, doc, position, area, salary, riskClass] of demo) {
    await prisma.employee.create({
      data: {
        companyId, propertyId, fullName, documentNumber: doc, position, area,
        salary, riskClass, hireDate: new Date(Date.UTC(new Date().getUTCFullYear(), 0, 15)),
        eps: 'EPS Sura', afp: 'Porvenir', arl: 'ARL Sura', ccf: 'Compensar', cesantiasFund: 'Porvenir',
      },
    });
  }
  console.log('   Empleados demo creados (Laura Rodríguez, Carlos Muñoz).');
}

async function main() {
  const existing = await prisma.company.findFirst();
  if (existing) {
    await ensurePayrollParams(existing.id);
    await ensurePlansAndSuperadmin(existing.id);
    const property = await prisma.property.findFirst({ where: { companyId: existing.id } });
    if (property) await ensureDemoEmployees(existing.id, property.id);
    console.log('Seed incremental aplicado (parámetros de nómina, planes SaaS y empleados demo).');
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

  // Salones para eventos (§33)
  for (const [name, capacity, half, full, hourly, amenities] of [
    ['Salón Bolívar', 120, 900000, 1600000, 250000, 'Proyector 4K, sonido, tarima, WiFi dedicado'],
    ['Sala Chapinero', 40, 400000, 700000, 120000, 'Pantalla, videoconferencia, pizarra'],
  ]) {
    await prisma.venue.create({ data: { propertyId: property.id, name, capacity, halfDayRate: half, fullDayRate: full, hourlyRate: hourly, amenities } });
  }

  // Segunda sede (§8 multi-sede): permite consolidar el portafolio.
  const property2 = await prisma.property.create({
    data: {
      companyId: company.id,
      name: 'Atria Hotel Medellín',
      address: 'Cra 43A # 7-50, El Poblado',
      city: 'Medellín',
      rnt: 'RNT-654321',
      rntExpiresAt: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 30)),
      taxRate: 0.19,
    },
  });
  for (const [name, code, capacity, baseRate, desc, count, floorBase] of [
    ['Estándar', 'STD', 2, 210000, 'Cama queen, WiFi, aire', 3, 1],
    ['Superior', 'SUP', 3, 300000, 'Balcón con vista al Poblado', 2, 2],
    ['Suite', 'STE', 4, 450000, 'Sala, jacuzzi y terraza', 1, 3],
  ]) {
    const rt = await prisma.roomType.create({ data: { propertyId: property2.id, name, code, capacity, baseRate, description: desc } });
    await prisma.ratePlan.create({ data: { propertyId: property2.id, roomTypeId: rt.id, name: 'Flexible', code: `${code}-FLEX`, price: baseRate, refundable: true, depositPct: 0.5 } });
    await prisma.ratePlan.create({ data: { propertyId: property2.id, roomTypeId: rt.id, name: 'No reembolsable', code: `${code}-NR`, price: Math.round(baseRate * 0.88), refundable: false, depositPct: 1.0 } });
    for (let i = 1; i <= count; i++) {
      await prisma.room.create({ data: { propertyId: property2.id, roomTypeId: rt.id, number: `${floorBase}0${i}`, floor: String(floorBase) } });
    }
  }

  // Usuarios por rol. La contraseña se toma de SEED_PASSWORD; el valor por
  // defecto 'atria2026' es SOLO para la demo local. En producción, define
  // SEED_PASSWORD (o cambia las contraseñas tras el primer arranque).
  const demoPassword = process.env.SEED_PASSWORD || 'atria2026';
  const pass = await bcrypt.hash(demoPassword, 10);
  const users = [
    ['Dueño Demo', 'owner@atria.co', 'OWNER'],
    ['Gerente Demo', 'gerente@atria.co', 'MANAGER'],
    ['Recepción Demo', 'recepcion@atria.co', 'FRONTDESK'],
    ['Ventas Demo', 'ventas@atria.co', 'SALES'],
    ['Housekeeping Demo', 'housekeeping@atria.co', 'HOUSEKEEPING'],
    ['Contabilidad Demo', 'contabilidad@atria.co', 'ACCOUNTING'],
    ['RR.HH. Demo', 'rrhh@atria.co', 'HR'],
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

  await ensurePayrollParams(company.id);
  await ensurePlansAndSuperadmin(company.id);
  await ensureDemoEmployees(company.id, property.id);

  console.log('✅ Seed completado.');
  console.log(`   Empresa: ${company.name}`);
  console.log(`   Sedes:   ${property.name} · ${property2.name}`);
  console.log(`   Usuarios (contraseña: ${process.env.SEED_PASSWORD ? 'definida en SEED_PASSWORD' : 'atria2026 — solo demo'}):`);
  for (const [, email, role] of users) console.log(`     - ${email} (${role})`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
