'use strict';

// ─── DOM Elements ───────────────────────────────────────────────────────────
const fixtureInput = document.getElementById('fixtureInput');
const buildBtn = document.getElementById('buildBtn');
const fileInput = document.getElementById('fileInput');
const loadSampleBtn = document.getElementById('loadSampleBtn');
const resultsPanel = document.getElementById('resultsPanel');
const errorPanel = document.getElementById('errorPanel');
const statusBadge = document.getElementById('statusBadge');
const copyPsbtBtn = document.getElementById('copyPsbtBtn');

// ─── Sample fixture ─────────────────────────────────────────────────────────
const SAMPLE_FIXTURE = {
    network: "mainnet",
    utxos: [{
        txid: "1111111111111111111111111111111111111111111111111111111111111111",
        vout: 0, value_sats: 100000,
        script_pubkey_hex: "00141111111111111111111111111111111111111111",
        script_type: "p2wpkh",
        address: "bc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3h8ffkz"
    }],
    payments: [{
        address: "bc1qyysjzgfpyysjzgfpyysjzgfpyysjzgfpf7224r",
        script_pubkey_hex: "00142121212121212121212121212121212121212121",
        script_type: "p2wpkh",
        value_sats: 70000
    }],
    change: {
        address: "bc1qxycnzvf3xycnzvf3xycnzvf3xycnzvf36suk2s",
        script_pubkey_hex: "00143131313131313131313131313131313131313131",
        script_type: "p2wpkh"
    },
    fee_rate_sat_vb: 5,
    rbf: true,
    policy: { max_inputs: 5 }
};

// ─── Event Listeners ────────────────────────────────────────────────────────
loadSampleBtn.addEventListener('click', () => {
    fixtureInput.value = JSON.stringify(SAMPLE_FIXTURE, null, 2);
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { fixtureInput.value = ev.target.result; };
    reader.readAsText(file);
});

buildBtn.addEventListener('click', handleBuild);

copyPsbtBtn.addEventListener('click', () => {
    const text = document.getElementById('psbtOutput').textContent;
    navigator.clipboard.writeText(text).then(() => {
        copyPsbtBtn.textContent = '✅ Copied!';
        setTimeout(() => { copyPsbtBtn.textContent = '📋 Copy'; }, 1500);
    });
});

// ─── Build Handler ──────────────────────────────────────────────────────────
async function handleBuild() {
    const raw = fixtureInput.value.trim();
    if (!raw) return;

    let fixture;
    try {
        fixture = JSON.parse(raw);
    } catch (e) {
        showError('INVALID_JSON', 'Could not parse JSON: ' + e.message);
        return;
    }

    buildBtn.classList.add('btn-loading');
    buildBtn.textContent = 'Building...';
    setStatus('Building', '#f59e0b');

    try {
        const res = await fetch('/api/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fixture),
        });
        const data = await res.json();

        if (data.ok) {
            showResults(data);
            setStatus('Success', '#10b981');
        } else {
            showError(data.error.code, data.error.message);
            setStatus('Error', '#ef4444');
        }
    } catch (e) {
        showError('NETWORK_ERROR', e.message);
        setStatus('Error', '#ef4444');
    } finally {
        buildBtn.classList.remove('btn-loading');
        buildBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1a9 9 0 1 0 0 18A9 9 0 0 0 10 1zm3.7 9.7l-4 4a1 1 0 0 1-1.4 0l-2-2a1 1 0 1 1 1.4-1.4L9 12.58l3.3-3.3a1 1 0 0 1 1.4 1.42z"/></svg> Build PSBT`;
    }
}

// ─── Render Results ─────────────────────────────────────────────────────────
function showResults(data) {
    errorPanel.style.display = 'none';
    resultsPanel.style.display = 'block';
    resultsPanel.style.animation = 'none';
    resultsPanel.offsetHeight; // reflow
    resultsPanel.style.animation = '';

    // Warnings
    const wc = document.getElementById('warningContainer');
    wc.innerHTML = '';
    if (data.warnings && data.warnings.length) {
        data.warnings.forEach(w => {
            const div = document.createElement('div');
            const icon = { HIGH_FEE: '🔥', DUST_CHANGE: '💨', SEND_ALL: '📤', RBF_SIGNALING: '🔄' }[w.code] || '⚠️';
            const label = { HIGH_FEE: 'High Fee Detected', DUST_CHANGE: 'Dust Change Output', SEND_ALL: 'Send All — No Change', RBF_SIGNALING: 'RBF Replace-By-Fee Signaling' }[w.code] || w.code;
            div.className = `warning-item warning-${w.code || 'default'}`;
            div.innerHTML = `<span>${icon}</span><span>${label}</span>`;
            wc.appendChild(div);
        });
    }

    // Stats
    document.getElementById('feeSats').textContent = formatSats(data.fee_sats);
    document.getElementById('feeRate').textContent = `${data.fee_rate_sat_vb} sat/vB`;
    document.getElementById('vbytes').textContent = data.vbytes;
    document.getElementById('rbfStatus').textContent = data.rbf_signaling ? 'Enabled' : 'Disabled';
    document.getElementById('rbfStatus').style.color = data.rbf_signaling ? '#a78bfa' : 'var(--text-secondary)';
    document.getElementById('rbfDetail').textContent = data.rbf_signaling ? 'nSeq ≤ 0xFFFFFFFD' : 'nSeq = 0xFFFFFFFF';
    document.getElementById('locktimeValue').textContent = data.locktime === 0 ? 'None' : data.locktime.toLocaleString();
    document.getElementById('locktimeType').textContent = data.locktime_type === 'none' ? '—' : data.locktime_type.replace('_', ' ');

    // Inputs
    const inputsList = document.getElementById('inputsList');
    inputsList.innerHTML = '';
    document.getElementById('inputCount').textContent = data.selected_inputs.length;
    let inputsTotal = 0;
    data.selected_inputs.forEach(inp => {
        inputsTotal += inp.value_sats;
        inputsList.appendChild(createFlowItem({
            value: inp.value_sats,
            label: `${inp.txid.slice(0, 8)}…:${inp.vout}`,
            scriptType: inp.script_type,
        }));
    });
    document.getElementById('inputsTotal').textContent = formatSats(inputsTotal);

    // Outputs
    const outputsList = document.getElementById('outputsList');
    outputsList.innerHTML = '';
    document.getElementById('outputCount').textContent = data.outputs.length;
    let outputsTotal = 0;
    data.outputs.forEach(out => {
        outputsTotal += out.value_sats;
        outputsList.appendChild(createFlowItem({
            value: out.value_sats,
            label: out.address ? `${out.address.slice(0, 14)}…` : out.script_pubkey_hex.slice(0, 16) + '…',
            scriptType: out.script_type,
            isChange: out.is_change,
        }));
    });
    document.getElementById('outputsTotal').textContent = formatSats(outputsTotal);

    // PSBT
    document.getElementById('psbtOutput').textContent = data.psbt_base64;

    // Full Report
    document.getElementById('jsonReport').textContent = JSON.stringify(data, null, 2);
}

function showError(code, message) {
    resultsPanel.style.display = 'none';
    errorPanel.style.display = 'block';
    errorPanel.style.animation = 'none';
    errorPanel.offsetHeight;
    errorPanel.style.animation = '';
    document.getElementById('errorCode').textContent = code;
    document.getElementById('errorMessage').textContent = message;
}

function setStatus(text, color) {
    const dot = statusBadge.querySelector('.status-dot');
    dot.style.background = color;
    statusBadge.querySelector('span:last-child').textContent = text;
}

function formatSats(sats) {
    if (sats >= 100000000) return (sats / 100000000).toFixed(8) + ' BTC';
    return sats.toLocaleString() + ' sats';
}

function createFlowItem({ value, label, scriptType, isChange }) {
    const div = document.createElement('div');
    div.className = 'flow-item';
    div.innerHTML = `
    <div class="flow-item-header">
      <span class="flow-item-value">${formatSats(value)}</span>
      <span>
        <span class="script-badge">${scriptType || '?'}</span>
        ${isChange ? '<span class="change-badge">CHANGE</span>' : ''}
      </span>
    </div>
    <div class="flow-item-label">${label}</div>
  `;
    return div;
}
