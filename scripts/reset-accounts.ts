import { initManager, getAccounts, resetAllCooldowns, saveAccounts } from "../src/auth/manager";

async function main() {
  await initManager();
  const accounts = getAccounts();
  console.log(`🚀 Resetting ${accounts.length} accounts...`);

  for (const acc of accounts) {
    acc.healthScore = 100;
    acc.consecutiveFailures = 0;
    acc.cooldowns = {};
    acc.modelScores = {};
    acc.history = [];
    acc.quota = [];
    delete acc.challenge;
    console.log(`  - Reset ${acc.email}`);
  }

  await resetAllCooldowns();
  await saveAccounts(accounts);
  console.log("✅ All accounts and cooldowns have been reset.");
}

main().catch(console.error);
