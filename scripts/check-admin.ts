import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

import * as bcrypt from 'bcryptjs';

async function main() {
  const admin = await prisma.user.findUnique({ where: { phone: '+910000000000' } });
  if (!admin) { console.log('NONE'); return; }
  const match = await bcrypt.compare('shashank123', admin.passwordHash || '');
  console.log('Admin:', { phone: admin.phone, roles: admin.roles });
  console.log('FULL HASH:', admin.passwordHash);
  console.log('Hash prefix:', admin.passwordHash?.substring(0, 7));
}
main().catch(console.error).finally(async () => { await prisma.$disconnect(); });
