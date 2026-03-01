'use strict';

const express = require('express');
const path = require('path');
const { buildTransaction } = require('./builder');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

// Build PSBT from fixture
app.post('/api/build', (req, res) => {
    try {
        const fixture = req.body;
        const report = buildTransaction(fixture);
        res.json(report);
    } catch (e) {
        const code = (e && e.code) || 'INTERNAL_ERROR';
        const message = (e && e.message) || String(e);
        res.status(400).json({ ok: false, error: { code, message } });
    }
});

const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
