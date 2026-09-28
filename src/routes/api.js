const express = require('express');
const { timingSafeEqual } = require('node:crypto');

function createRouter({ config = process.env, fetchImpl = fetch, envPath } = {}) {
    const router = express.Router();
    const modules = Promise.all([import('../services/meli-oauth.mjs'), import('../services/catalog.mjs')])
        .then(([oauth, catalog]) => ({ oauth, validRequest: catalog.validRequest, catalog: catalog.createCatalog({ envPath, fetchImpl }) }));

    function admin(req, res, next) {
        const expected = config.API_ADMIN_TOKEN;
        const actual = req.headers.authorization?.replace(/^Bearer /, '') || '';
        if (!expected) return res.status(503).json({ error: 'Falta configurar la administración de la API.' });
        if (Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
            return res.status(401).json({ error: 'No autorizado.' });
        }
        next();
    }

    async function user(req, res, next) {
        if (!config.SUPABASE_URL || !config.SUPABASE_PUBLISHABLE_KEY) return res.status(503).json({ error: 'Falta configurar Supabase en la API.' });
        const authorization = req.headers.authorization;
        if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: 'Sesión no válida.' });
        try {
            const response = await fetchImpl(`${config.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
                headers: { Authorization: authorization, apikey: config.SUPABASE_PUBLISHABLE_KEY },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) return res.status(response.status >= 500 ? 503 : 401).json({ error: 'No se pudo validar la sesión.' });
            next();
        } catch {
            res.status(503).json({ error: 'No se pudo validar la sesión.' });
        }
    }

    router.get('/health', (_req, res) => res.json({ status: 'ok' }));
    router.post('/meli/authorize', admin, async (_req, res) => {
        const { oauth } = await modules;
        try { res.json(await oauth.startAuthorization(envPath)); }
        catch { res.status(503).json({ error: 'No se pudo iniciar la autorización de Mercado Libre.' }); }
    });
    router.post('/meli/exchange', admin, async (req, res) => {
        if (typeof req.body?.callback !== 'string') return res.status(400).json({ error: 'Se requiere la URL completa en callback.' });
        const { oauth } = await modules;
        try { res.json(await oauth.exchangeCode(envPath, req.body.callback, fetchImpl)); }
        catch { res.status(400).json({ error: 'Autorización inválida o vencida. Iniciá una nueva y verificá la URL de retorno.' }); }
    });
    router.get('/meli/callback', async (req, res) => {
        const { oauth } = await modules;
        try {
            const { values } = await oauth.readConfig(envPath);
            const callback = new URL(values.MELI_REDIRECT_URI || values.MELI_URL);
            callback.search = new URL(req.originalUrl, 'http://localhost').search;
            res.json(await oauth.exchangeCode(envPath, callback.href, fetchImpl));
        } catch { res.status(400).json({ error: 'Autorización inválida o vencida.' }); }
    });
    router.post('/meli/refresh', admin, async (_req, res) => {
        const { catalog } = await modules;
        try { res.json(await catalog.refresh()); }
        catch { res.status(503).json({ error: 'No se pudo renovar el token. Revisá la autorización de Mercado Libre.' }); }
    });
    router.get('/meli/status', admin, async (_req, res) => {
        const { oauth } = await modules;
        const { values } = await oauth.readConfig(envPath);
        res.json({ hasAccess: !!values.MELI_ACCESS_TOKEN, hasRefresh: !!values.MELI_REFRESH_TOKEN, expiresAt: values.MELI_EXPIRES_AT || null });
    });
    router.post('/meli/catalog', user, async (req, res) => {
        const { validRequest, catalog } = await modules;
        if (!validRequest(req.body)) return res.status(400).json({ error: 'Consulta de catálogo inválida.' });
        try { res.json(await catalog.query(req.body)); }
        catch { res.status(503).json({ error: 'El catálogo no está disponible. Revisá la autorización de Mercado Libre en la API.' }); }
    });

    router.get('/health', (req, res) => {
        const data = {
            uptime: process.uptime(),
            message: 'Ok',
            date: new Date()
        }

        res.status(200).send(data);
    });
    
    return router;
}
module.exports = { createRouter };
