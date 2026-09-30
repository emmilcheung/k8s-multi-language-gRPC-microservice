import { loadConfig } from './config.ts';

function boot(): void {
  try {
    loadConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Invalid configuration');
    process.exit(1);
  }
}

boot();
