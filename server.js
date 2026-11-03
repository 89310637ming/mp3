require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const app = require('./app');
const { initializeDatabase } = require('./lib/database');

async function start() {
  if (!process.env.MONGODB_URI || process.env.MONGODB_URI.includes('<')) {
    throw new Error('Set MONGODB_URI in .env to your MongoDB Atlas connection string.');
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await initializeDatabase();
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => console.log(`Server running on port ${port}`));
  server.on('error', async () => {
    console.error('Unable to start the HTTP server. Check PORT and try again.');
    await mongoose.disconnect();
    process.exitCode = 1;
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      await mongoose.disconnect();
      clearTimeout(timeout);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  start().catch(async error => {
    console.error(error.message.startsWith('Set MONGODB_URI') ? error.message :
      'Unable to connect to the database. Check MONGODB_URI and Atlas network access.');
    await mongoose.disconnect();
    process.exitCode = 1;
  });
}
module.exports = { start };
