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
    selectCoinsRandom,
    selectCoinsBnB,
    compareStrategies,
    guessScriptType,
    generateDescriptors,
    analyzePrivacy,
    signAndFinalize,
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

// ═════════════════════════════════════════════════════════════════════════════
// STRETCH GOAL TESTS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Coin Selection Strategies ──────────────────────────────────────────────

describe('Coin Selection Strategies', () => {
    test('random strategy produces valid result', () => {
        const fixture = loadFixture('basic_change_p2wpkh.json');
        fixture.strategy = 'random';
        const result = buildTransaction(fixture);
        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('random');
        expect(result.selected_inputs.length).toBeGreaterThan(0);
        // Balance check
        const inSum = result.selected_inputs.reduce((s, i) => s + i.value_sats, 0);
        const outSum = result.outputs.reduce((s, o) => s + o.value_sats, 0);
        expect(inSum).toBe(outSum + result.fee_sats);
    });

    test('bnb strategy produces valid result', () => {
        const fixture = loadFixture('basic_change_p2wpkh.json');
        fixture.strategy = 'bnb';
        const result = buildTransaction(fixture);
        expect(result.ok).toBe(true);
        expect(result.strategy).toBe('bnb');
        expect(result.selected_inputs.length).toBeGreaterThan(0);
    });

    test('compare mode returns strategy_comparison array', () => {
        const fixture = loadFixture('basic_change_p2wpkh.json');
        fixture.strategy = 'compare';
        const result = buildTransaction(fixture);
        expect(result.ok).toBe(true);
        expect(result.strategy_comparison).toBeDefined();
        expect(Array.isArray(result.strategy_comparison)).toBe(true);
        expect(result.strategy_comparison.length).toBe(3);

        // Each entry has required fields
        result.strategy_comparison.forEach(entry => {
            expect(entry.strategy).toBeDefined();
            if (!entry.error) {
                expect(entry.input_count).toBeGreaterThan(0);
                expect(entry.fee_sats).toBeGreaterThan(0);
                expect(entry.vbytes).toBeGreaterThan(0);
                expect(typeof entry.has_change).toBe('boolean');
                expect(entry.waste_score).toBeGreaterThanOrEqual(0);
            }
        });
    });

    test('compare mode results are sorted by waste_score', () => {
        const fixture = loadFixture('multi_input_required.json');
        fixture.strategy = 'compare';
        const result = buildTransaction(fixture);
        const scores = result.strategy_comparison
            .filter(e => !e.error)
            .map(e => e.waste_score);
        for (let i = 1; i < scores.length; i++) {
            expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
        }
    });

    test('default strategy is greedy when not specified', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        expect(result.strategy).toBe('greedy');
        expect(result.strategy_comparison).toBeUndefined();
    });

    test('selectCoinsRandom direct call works', () => {
        const utxos = [
            { txid: 'a'.repeat(64), vout: 0, value_sats: 50000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' },
            { txid: 'b'.repeat(64), vout: 0, value_sats: 60000, script_pubkey_hex: '0014' + 'bb'.repeat(20), script_type: 'p2wpkh' },
        ];
        const payments = [{ script_pubkey_hex: '0014' + 'cc'.repeat(20), value_sats: 30000, script_type: 'p2wpkh' }];
        const selected = selectCoinsRandom(utxos, 30000, 1, payments, 'p2wpkh', null);
        expect(selected.length).toBeGreaterThan(0);
        const total = selected.reduce((s, u) => s + u.value_sats, 0);
        expect(total).toBeGreaterThanOrEqual(30000);
    });

    test('selectCoinsBnB direct call works', () => {
        const utxos = [
            { txid: 'a'.repeat(64), vout: 0, value_sats: 50000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' },
            { txid: 'b'.repeat(64), vout: 0, value_sats: 60000, script_pubkey_hex: '0014' + 'bb'.repeat(20), script_type: 'p2wpkh' },
        ];
        const payments = [{ script_pubkey_hex: '0014' + 'cc'.repeat(20), value_sats: 30000, script_type: 'p2wpkh' }];
        const selected = selectCoinsBnB(utxos, 30000, 1, payments, 'p2wpkh', null);
        expect(selected.length).toBeGreaterThan(0);
    });
});

// ─── PSBT Signing Tests ─────────────────────────────────────────────────────

describe('PSBT Signing with Test Keys', () => {
    test('test_keys:true produces sign result fields', () => {
        const fixture = loadFixture('basic_change_p2wpkh.json');
        fixture.test_keys = true;
        const result = buildTransaction(fixture);
        expect(result.ok).toBe(true);
        expect(result.signed_psbt_base64).toBeDefined();
        expect(result.signed_psbt_base64.length).toBeGreaterThan(0);
        // tx_hex may be null if keys don't match (test keys won't match real scripts)
        // but signed_psbt_base64 should be present
    });

    test('test_keys not set does NOT produce sign fields', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        expect(result.signed_psbt_base64).toBeUndefined();
        expect(result.tx_hex).toBeUndefined();
    });

    test('signing handles graceful failure', () => {
        const fixture = loadFixture('mixed_input_types.json');
        fixture.test_keys = true;
        const result = buildTransaction(fixture);
        expect(result.ok).toBe(true);
        expect(result.signed_psbt_base64).toBeDefined();
        // sign_error may or may not be present; either way should not crash
    });
});

// ─── Watch-Only Descriptor Tests ────────────────────────────────────────────

describe('Watch-Only Descriptors', () => {
    test('descriptors field is present in report', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        expect(result.descriptors).toBeDefined();
        expect(Array.isArray(result.descriptors)).toBe(true);
        expect(result.descriptors.length).toBeGreaterThan(0);
    });

    test('each descriptor has required fields', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        result.descriptors.forEach(d => {
            expect(d.role).toBeDefined();
            expect(['input', 'payment', 'change']).toContain(d.role);
            expect(d.script_type).toBeDefined();
            expect(d.script_hex).toBeDefined();
            expect(d.descriptor).toBeDefined();
            expect(d.descriptor).toMatch(/^(addr|raw)\(/);
        });
    });

    test('descriptors include inputs and outputs', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        const roles = result.descriptors.map(d => d.role);
        expect(roles).toContain('input');
        // Should have at least payment or change
        expect(roles.some(r => r === 'payment' || r === 'change')).toBe(true);
    });

    test('descriptors deduplicate by script hex', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        const hexes = result.descriptors.map(d => d.script_hex);
        const unique = new Set(hexes);
        expect(hexes.length).toBe(unique.size);
    });

    test('descriptor uses addr() when address is available', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        const withAddr = result.descriptors.filter(d => d.descriptor.startsWith('addr('));
        // basic_change_p2wpkh has addresses, so we expect addr() format
        expect(withAddr.length).toBeGreaterThan(0);
    });
});

// ─── Privacy Meter Tests ────────────────────────────────────────────────────

describe('Privacy Meter', () => {
    test('privacy field is present in report', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        expect(result.privacy).toBeDefined();
        expect(result.privacy.score).toBeDefined();
        expect(result.privacy.max_score).toBe(100);
        expect(Array.isArray(result.privacy.risk_factors)).toBe(true);
    });

    test('privacy score is between 0 and 100', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        expect(result.privacy.score).toBeGreaterThanOrEqual(0);
        expect(result.privacy.score).toBeLessThanOrEqual(100);
    });

    test('basic single-input same-type tx has high privacy score', () => {
        const result = buildTransaction(loadFixture('basic_change_p2wpkh.json'));
        // Single input, same type for change and payment = good privacy
        expect(result.privacy.score).toBeGreaterThanOrEqual(70);
    });

    test('round payment amounts are flagged', () => {
        const fixture = {
            network: 'mainnet',
            utxos: [{ txid: 'a'.repeat(64), vout: 0, value_sats: 200000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' }],
            payments: [{ script_pubkey_hex: '0014' + 'cc'.repeat(20), value_sats: 100000, script_type: 'p2wpkh' }],
            change: { script_pubkey_hex: '0014' + 'bb'.repeat(20), script_type: 'p2wpkh' },
            fee_rate_sat_vb: 1,
        };
        const result = buildTransaction(fixture);
        expect(result.privacy.risk_factors.some(f => f.code === 'ROUND_PAYMENT')).toBe(true);
    });

    test('input reuse is detected', () => {
        // Two inputs with the same scriptPubKey
        const inputs = [
            { txid: 'a'.repeat(64), vout: 0, value_sats: 50000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' },
            { txid: 'b'.repeat(64), vout: 1, value_sats: 50000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' },
        ];
        const outputs = [
            { n: 0, value_sats: 70000, script_pubkey_hex: '0014' + 'cc'.repeat(20), script_type: 'p2wpkh', is_change: false },
        ];
        const privacy = analyzePrivacy(inputs, outputs, null);
        expect(privacy.risk_factors.some(f => f.code === 'INPUT_REUSE')).toBe(true);
        expect(privacy.score).toBeLessThan(100);
    });

    test('change type mismatch is detected', () => {
        const inputs = [
            { txid: 'a'.repeat(64), vout: 0, value_sats: 100000, script_pubkey_hex: '0014' + 'aa'.repeat(20), script_type: 'p2wpkh' },
        ];
        const outputs = [
            { n: 0, value_sats: 70000, script_pubkey_hex: '0014' + 'cc'.repeat(20), script_type: 'p2wpkh', is_change: false },
            { n: 1, value_sats: 29000, script_pubkey_hex: '5120' + 'dd'.repeat(32), script_type: 'p2tr', is_change: true },
        ];
        const privacy = analyzePrivacy(inputs, outputs, 1);
        expect(privacy.risk_factors.some(f => f.code === 'CHANGE_TYPE_MISMATCH')).toBe(true);
    });

    test('many inputs penalty applied', () => {
        const inputs = [];
        for (let i = 0; i < 5; i++) {
            inputs.push({
                txid: (i.toString(16)).repeat(64).slice(0, 64), vout: 0, value_sats: 10000,
                script_pubkey_hex: '0014' + (i.toString(16) + 'a').repeat(20).slice(0, 40), script_type: 'p2wpkh',
            });
        }
        const outputs = [
            { n: 0, value_sats: 40001, script_pubkey_hex: '0014' + 'cc'.repeat(20), script_type: 'p2wpkh', is_change: false },
        ];
        const privacy = analyzePrivacy(inputs, outputs, null);
        expect(privacy.risk_factors.some(f => f.code === 'MANY_INPUTS')).toBe(true);
    });
});
