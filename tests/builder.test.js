'use strict';

const path = require('path');
const fs = require('fs');
const {
    buildTransaction,
    validateFixture,
    computeSequenceAndLocktime,
    classifyLocktime,
    estimateVbytes,
    selectCoins,
    guessScriptType,
    INPUT_VBYTES,
    OUTPUT_VBYTES,
    DUST_THRESHOLD,
} = require('../src/builder');

// Helper to load a fixture
function loadFixture(name) {
    const fp = path.join(__dirname, '..', 'fixtures', name);
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

// ─── Validation Tests ───────────────────────────────────────────────────────

describe('Fixture Validation', () => {
    test('rejects null fixture', () => {
        expect(() => buildTransaction(null)).toThrow();
    });

    test('rejects fixture with missing utxos', () => {
        expect(() => buildTransaction({
            network: 'mainnet',
            payments: [{ script_pubkey_hex: '0014abcd', value_sats: 1000 }],
            change: { script_pubkey_hex: '0014abcd' },
            fee_rate_sat_vb: 1,
        })).toThrow();
    });

    test('rejects fixture with empty payments', () => {
        expect(() => buildTransaction({
            network: 'mainnet',
            utxos: [{ txid: 'a'.repeat(64), vout: 0, value_sats: 10000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' }],
            payments: [],
            change: { script_pubkey_hex: '0014' + 'bb'.repeat(20) },
            fee_rate_sat_vb: 1,
        })).toThrow();
    });

    test('rejects negative fee rate', () => {
        expect(() => buildTransaction({
            network: 'mainnet',
            utxos: [{ txid: 'a'.repeat(64), vout: 0, value_sats: 10000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' }],
            payments: [{ script_pubkey_hex: '0014' + 'cc'.repeat(20), value_sats: 1000, script_type: 'p2wpkh' }],
            change: { script_pubkey_hex: '0014' + 'bb'.repeat(20), script_type: 'p2wpkh' },
            fee_rate_sat_vb: -5,
        })).toThrow();
    });
});

// ─── Coin Selection Tests ───────────────────────────────────────────────────

describe('Coin Selection', () => {
    test('basic p2wpkh change scenario', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        expect(result.ok).toBe(true);
        expect(result.selected_inputs.length).toBe(1);
        expect(result.change_index).toBe(1);
        // Balance check
        const inSum = result.selected_inputs.reduce((s, i) => s + i.value_sats, 0);
        const outSum = result.outputs.reduce((s, o) => s + o.value_sats, 0);
        expect(inSum).toBe(outSum + result.fee_sats);
    });

    test('send-all when change is dust', () => {
        const result = buildTransaction(loadFixture('send_all_dust_change.json'));
        expect(result.ok).toBe(true);
        expect(result.change_index).toBeNull();
        expect(result.warnings.some(w => w.code === 'SEND_ALL')).toBe(true);
        // No dust outputs
        result.outputs.forEach(o => {
            expect(o.value_sats).toBeGreaterThanOrEqual(546);
        });
    });

    test('multi-input required', () => {
        const result = buildTransaction(loadFixture('multi_input_required.json'));
        expect(result.ok).toBe(true);
        expect(result.selected_inputs.length).toBeGreaterThan(1);
    });

    test('multi-payment with change', () => {
        const result = buildTransaction(loadFixture('multi_payment_change.json'));
        expect(result.ok).toBe(true);
        const payments = result.outputs.filter(o => !o.is_change);
        expect(payments.length).toBeGreaterThanOrEqual(2);
    });

    test('policy max_inputs enforced', () => {
        const fixture = loadFixture('basic_change_p2wpkh.json');
        fixture.policy = { max_inputs: 1 };
        const result = buildTransaction(fixture);
        expect(result.selected_inputs.length).toBeLessThanOrEqual(1);
    });

    test('insufficient funds throws error', () => {
        expect(() => buildTransaction({
            network: 'mainnet',
            utxos: [{ txid: 'a'.repeat(64), vout: 0, value_sats: 100, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' }],
            payments: [{ script_pubkey_hex: '0014' + 'cc'.repeat(20), value_sats: 99999, script_type: 'p2wpkh' }],
            change: { script_pubkey_hex: '0014' + 'bb'.repeat(20), script_type: 'p2wpkh' },
            fee_rate_sat_vb: 1,
        })).toThrow();
    });
});

// ─── Fee/Change Tests ───────────────────────────────────────────────────────

describe('Fee and Change', () => {
    test('fee meets target rate', () => {
        const fixture = loadFixture('basic_change_p2wpkh.json');
        const result = buildTransaction(fixture);
        const minFee = Math.ceil(result.vbytes * fixture.fee_rate_sat_vb);
        expect(result.fee_sats).toBeGreaterThanOrEqual(minFee);
    });

    test('fee_rate_sat_vb accuracy within ±0.01', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        const actual = result.fee_sats / result.vbytes;
        expect(Math.abs(actual - result.fee_rate_sat_vb)).toBeLessThanOrEqual(0.01);
    });

    test('no dust outputs', () => {
        const result = buildTransaction(loadFixture('mixed_input_types.json'));
        result.outputs.forEach(o => {
            expect(o.value_sats).toBeGreaterThanOrEqual(DUST_THRESHOLD);
        });
    });
});

// ─── vBytes Tests ───────────────────────────────────────────────────────────

describe('vBytes Estimation', () => {
    test('p2pkh input is larger than p2wpkh', () => {
        expect(INPUT_VBYTES['p2pkh']).toBeGreaterThan(INPUT_VBYTES['p2wpkh']);
    });

    test('p2tr input is smallest segwit', () => {
        expect(INPUT_VBYTES['p2tr']).toBeLessThan(INPUT_VBYTES['p2wpkh']);
    });

    test('mixed input types produces valid transaction', () => {
        const result = buildTransaction(loadFixture('mixed_input_types.json'));
        expect(result.ok).toBe(true);
        expect(result.vbytes).toBeGreaterThan(0);
    });
});

// ─── RBF / Locktime Tests ───────────────────────────────────────────────────

describe('RBF and Locktime', () => {
    test('rbf:true sets rbf_signaling', () => {
        const result = buildTransaction(loadFixture('rbf_basic.json'));
        expect(result.rbf_signaling).toBe(true);
        expect(result.warnings.some(w => w.code === 'RBF_SIGNALING')).toBe(true);
    });

    test('rbf:false explicit does NOT set rbf_signaling', () => {
        const result = buildTransaction(loadFixture('rbf_false_explicit.json'));
        expect(result.rbf_signaling).toBe(false);
    });

    test('locktime without rbf sets nLockTime and rbf_signaling false', () => {
        const result = buildTransaction(loadFixture('locktime_no_rbf.json'));
        expect(result.locktime).toBe(900000);
        expect(result.locktime_type).toBe('block_height');
        expect(result.rbf_signaling).toBe(false);
    });

    test('anti-fee-sniping: rbf+current_height sets locktime', () => {
        const result = buildTransaction(loadFixture('anti_fee_sniping.json'));
        expect(result.locktime).toBe(860000);
        expect(result.locktime_type).toBe('block_height');
        expect(result.rbf_signaling).toBe(true);
    });

    test('locktime boundary: 499999999 = block_height', () => {
        const result = buildTransaction(loadFixture('locktime_boundary_block.json'));
        expect(result.locktime).toBe(499999999);
        expect(result.locktime_type).toBe('block_height');
    });

    test('locktime boundary: 500000000 = unix_timestamp', () => {
        const result = buildTransaction(loadFixture('locktime_boundary_timestamp.json'));
        expect(result.locktime).toBe(500000000);
        expect(result.locktime_type).toBe('unix_timestamp');
    });

    test('classifyLocktime utility', () => {
        expect(classifyLocktime(0)).toBe('none');
        expect(classifyLocktime(1)).toBe('block_height');
        expect(classifyLocktime(499999999)).toBe('block_height');
        expect(classifyLocktime(500000000)).toBe('unix_timestamp');
        expect(classifyLocktime(1700000000)).toBe('unix_timestamp');
    });
});

// ─── Warning Tests ──────────────────────────────────────────────────────────

describe('Warnings', () => {
    test('SEND_ALL when no change', () => {
        const result = buildTransaction(loadFixture('send_all_dust_change.json'));
        expect(result.warnings.some(w => w.code === 'SEND_ALL')).toBe(true);
    });

    test('RBF_SIGNALING when rbf is true', () => {
        const result = buildTransaction(loadFixture('rbf_basic.json'));
        expect(result.warnings.some(w => w.code === 'RBF_SIGNALING')).toBe(true);
    });
});

// ─── PSBT Tests ─────────────────────────────────────────────────────────────

describe('PSBT', () => {
    test('psbt_base64 decodes with valid magic bytes', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        const buf = Buffer.from(result.psbt_base64, 'base64');
        // PSBT magic: 0x70736274ff
        expect(buf[0]).toBe(0x70);
        expect(buf[1]).toBe(0x73);
        expect(buf[2]).toBe(0x62);
        expect(buf[3]).toBe(0x74);
        expect(buf[4]).toBe(0xff);
    });

    test('PSBT is non-empty base64', () => {
        const result = buildTransaction(loadFixture('multi_payment_change.json'));
        expect(result.psbt_base64).toBeTruthy();
        expect(result.psbt_base64.length).toBeGreaterThan(10);
    });
});
