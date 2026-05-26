import { buildApp } from './app';
import { config } from './config';

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Server running on http://${config.host}:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
