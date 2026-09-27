import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { AutoLpBot } from './bot.js';
import { DashboardServer } from './dashboard/server.js';
import { log } from './logger.js';

loadDotEnv();
const config = loadConfig();
const bot = new AutoLpBot(config);
const dashboard = new DashboardServer(config, bot, bot.ledger, bot.points);
const once = process.argv.includes('--once');
const dashboardOnly = process.argv.includes('--dashboard-only');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log('info', 'bot.stopping', { signal });
    bot.stop();
    await dashboard.stop();
    process.exit(0);
  });
}

try {
  if (dashboardOnly) {
    await dashboard.start();
  } else if (once) {
    await bot.initialize();
    await bot.runOnce();
  } else {
    await dashboard.start();
    await bot.start();
  }
} catch (error) {
  log('error', 'bot.fatal', { error: error.stack || error.message });
  process.exitCode = 1;
}
