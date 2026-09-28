const express = require('express');
const { createRouter } = require('./src/routes/api');

function createApp(options = {}) {
  const app = express();
  app.disable('x-powered-by');
  const config = options.config || process.env;
  const origins = (config.CORS_ORIGINS || 'http://localhost:8081,http://localhost:19006').split(',').map(x => x.trim());
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    if (origins.includes(req.headers.origin)) res.set('Access-Control-Allow-Origin', req.headers.origin);
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', createRouter(options));
  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({ error: status === 400 ? 'Solicitud inválida.' : 'No se pudo completar la solicitud.' });
  });
  return app;
}
if (require.main === module) {
  createApp().listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log('CarMeet API escuchando en el puerto ' + (process.env.PORT || 3000));
  });
}
module.exports = { createApp };
