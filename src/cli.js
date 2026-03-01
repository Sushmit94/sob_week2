'use strict';

const fs = require('fs');
const path = require('path');
const { buildTransaction } = require('./builder');

const fixturePath = process.argv[2];
const outputPath = process.argv[3];

if (!fixturePath || !outputPath) {
    const err = { ok: false, error: { code: 'INVALID_ARGS', message: 'Usage: node cli.js <fixture.json> <output.json>' } };
    process.stdout.write(JSON.stringify(err) + '\n');
    process.exit(1);
}

try {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    let fixture;
    try {
        fixture = JSON.parse(raw);
    } catch (e) {
        const err = { ok: false, error: { code: 'INVALID_JSON', message: `Failed to parse fixture JSON: ${e.message}` } };
        fs.writeFileSync(outputPath, JSON.stringify(err, null, 2));
        process.exit(1);
    }

    const report = buildTransaction(fixture);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    process.exit(0);
} catch (e) {
    const code = (e && e.code) || 'INTERNAL_ERROR';
    const message = (e && e.message) || String(e);
    const err = { ok: false, error: { code, message } };
    fs.writeFileSync(outputPath, JSON.stringify(err, null, 2));
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
}
