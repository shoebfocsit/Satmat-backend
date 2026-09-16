import * as bcrypt from 'bcryptjs';

async function main() {
  // Hash from DB (we need to fetch it - let's just test with known good hash from seed)
  // Actually let's just test if 'shashank123' hashes correctly
  const hash = await bcrypt.hash('shashank123', 10);
  console.log('New hash for shashank123:', hash.substring(0, 7));

  // Now let's verify the DB hash - but we don't have it in this script
  // Instead let's just check if the script's hash works
  const match = await bcrypt.compare('shashank123', hash);
  console.log('Self-compare:', match);
}
main();
