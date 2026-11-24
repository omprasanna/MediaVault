require('dotenv/config');
const cookieParser = require('cookie-parser');
const express = require('express');
const mongoose = require('mongoose');
const { connectDB, disconnectDB } = require('./config/db');
const { requireAuth } = require('./middleware/auth');
const { closeMediaQueue } = require('./queues/mediaQueue');
const authRouter = require('./routes/auth');
const cookiesRouter = require('./routes/cookies');
const inspectRouter = require('./routes/inspect');
const jobsRouter = require('./routes/jobs');
const proxyRouter = require('./routes/proxy');
const systemRouter = require('./routes/system');
const { AppError, errorHandler } = require('./utils/errors');

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'mediavault-api',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/inspect', requireAuth, inspectRouter);
app.use('/api/proxy', requireAuth, proxyRouter);
app.use('/api/jobs', requireAuth, jobsRouter);
app.use('/api/cookies', requireAuth, cookiesRouter);
app.use('/api/system', requireAuth, systemRouter);

app.use('/api', (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'The requested API endpoint does not exist.'));
});

app.use(errorHandler);

let server;

async function start() {
  await connectDB();
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`MediaVault API listening on http://0.0.0.0:${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down API server...`);
  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await closeMediaQueue();
    await disconnectDB();
  } catch (err) {
    console.error('Error during API shutdown:', err.message);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('Failed to start MediaVault API:', err);
  process.exit(1);
});
