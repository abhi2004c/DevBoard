import express from 'express';
import cors from 'cors';
import routes from './routes.js';

export function createApp(origin) {
  const app = express();
  app.use(cors({ origin }));
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })); // raw body needed for webhook HMAC
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', routes);
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
