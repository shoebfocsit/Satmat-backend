import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const newPassword = 'shashank123';
  const hash = await bcrypt.hash(newPassword, 10);

  const updated = await prisma.user.updateMany({
    where: { phone: '+910000000000' },
    data: {
      passwordHash: hash,
      roles: 'ADMIN',
      isActive: true,
    },
  });

  console.log(`Admin password reset: ${updated.count} user(s) updated.`);
  console.log('Login: 0000000000 / ' + newPassword);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => await prisma.$disconnect());
