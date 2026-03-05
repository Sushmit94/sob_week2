'use strict';

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

// ─── vBytes estimation per script type ──────────────────────────────────────
// Based on Bitcoin Core's estimation for common script types.
// All numbers follow the witness discount formula:
//   vbytes = (weight_non_witness * 4 + weight_witness) / 4
//
// TX overhead: version(4) + marker(0.5) + flag(0.5) + input_count(varint) +
//              output_count(varint) + locktime(4) = ~10.5 vB for segwit txs,
//              10 vB for non-segwit (no marker/flag).

const INPUT_VBYTES = {
  'p2wpkh': 68,    // outpoint(36) + scriptSig(1) + nSeq(4) + witness(27.25) ≈ 68
  'p2tr': 57.5,  // outpoint(36) + scriptSig(1) + nSeq(4) + witness(16.5)  ≈ 57.5
  'p2pkh': 148,   // outpoint(36) + scriptSig(108) + nSeq(4)                = 148
  'p2sh-p2wpkh': 91,    // outpoint(36) + scriptSig(24) + nSeq(4) + witness(27)   ≈ 91
  'p2sh': 297,   // generic; varies. conservative default
  'p2wsh': 104,   // outpoint(36) + scriptSig(1) + nSeq(4) + witness(63)    ≈ 104
};

const OUTPUT_VBYTES = {
  'p2wpkh': 31,    // value(8) + scriptPubKey(1+1+1+20) = 31
  'p2tr': 43,    // value(8) + scriptPubKey(1+1+1+32) = 43
  'p2pkh': 34,    // value(8) + scriptPubKey(1+3+20+2) = 34
  'p2sh-p2wpkh': 32,    // value(8) + scriptPubKey(1+1+1+20+1) = 32
  'p2sh': 32,
  'p2wsh': 43,    // value(8) + scriptPubKey(1+1+1+32) = 43
};

const DUST_THRESHOLD = 546;

// ─── Validation ─────────────────────────────────────────────────────────────

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') {
    throw { code: 'INVALID_FIXTURE', message: 'Fixture must be a JSON object' };
  }

  if (!fixture.network || typeof fixture.network !== 'string') {
    throw { code: 'INVALID_FIXTURE', message: 'Missing or invalid network field' };
  }

  if (!Array.isArray(fixture.utxos) || fixture.utxos.length === 0) {
    throw { code: 'INVALID_FIXTURE', message: 'utxos must be a non-empty array' };
  }

  for (let i = 0; i < fixture.utxos.length; i++) {
    const u = fixture.utxos[i];
    if (!u.txid || typeof u.txid !== 'string' || u.txid.length !== 64) {
      throw { code: 'INVALID_FIXTURE', message: `utxo[${i}]: invalid txid` };
    }
    if (typeof u.vout !== 'number' || u.vout < 0) {
      throw { code: 'INVALID_FIXTURE', message: `utxo[${i}]: invalid vout` };
    }
    if (typeof u.value_sats !== 'number' || u.value_sats <= 0) {
      throw { code: 'INVALID_FIXTURE', message: `utxo[${i}]: invalid value_sats` };
    }
    if (!u.script_pubkey_hex || typeof u.script_pubkey_hex !== 'string') {
      throw { code: 'INVALID_FIXTURE', message: `utxo[${i}]: missing script_pubkey_hex` };
    }
    if (!u.script_type || typeof u.script_type !== 'string') {
      throw { code: 'INVALID_FIXTURE', message: `utxo[${i}]: missing script_type` };
    }
  }

  if (!Array.isArray(fixture.payments) || fixture.payments.length === 0) {
    throw { code: 'INVALID_FIXTURE', message: 'payments must be a non-empty array' };
  }

  for (let i = 0; i < fixture.payments.length; i++) {
    const p = fixture.payments[i];
    if (!p.script_pubkey_hex || typeof p.script_pubkey_hex !== 'string') {
      throw { code: 'INVALID_FIXTURE', message: `payment[${i}]: missing script_pubkey_hex` };
    }
    if (typeof p.value_sats !== 'number' || p.value_sats <= 0) {
      throw { code: 'INVALID_FIXTURE', message: `payment[${i}]: invalid value_sats` };
    }
  }

  if (!fixture.change || typeof fixture.change !== 'object') {
    throw { code: 'INVALID_FIXTURE', message: 'Missing change template' };
  }
  if (!fixture.change.script_pubkey_hex) {
    throw { code: 'INVALID_FIXTURE', message: 'change: missing script_pubkey_hex' };
  }

  if (typeof fixture.fee_rate_sat_vb !== 'number' || fixture.fee_rate_sat_vb <= 0) {
    throw { code: 'INVALID_FIXTURE', message: 'fee_rate_sat_vb must be a positive number' };
  }
}

// ─── RBF / Locktime logic ───────────────────────────────────────────────────

function computeSequenceAndLocktime(fixture) {
  const rbf = fixture.rbf === true;
  const hasLocktime = typeof fixture.locktime === 'number';
  const hasCurrentHeight = typeof fixture.current_height === 'number';

  let nSequence, nLockTime;

  if (rbf) {
    nSequence = 0xFFFFFFFD;
    if (hasLocktime) {
      nLockTime = fixture.locktime;
    } else if (hasCurrentHeight) {
      nLockTime = fixture.current_height; // anti-fee-sniping
    } else {
      nLockTime = 0;
    }
  } else if (hasLocktime && fixture.locktime !== 0) {
    nSequence = 0xFFFFFFFE;
    nLockTime = fixture.locktime;
  } else {
    nSequence = 0xFFFFFFFF;
    nLockTime = 0;
  }

  return { nSequence, nLockTime };
}

function classifyLocktime(nLockTime) {
  if (nLockTime === 0) return 'none';
  if (nLockTime < 500000000) return 'block_height';
  return 'unix_timestamp';
}

// ─── vBytes estimation ──────────────────────────────────────────────────────

function estimateVbytes(inputs, paymentOutputs, hasChange, changeScriptType) {
  // Determine if transaction has any witness inputs
  const witnessTypes = new Set(['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2wsh']);
  const hasWitness = inputs.some(inp => witnessTypes.has(inp.script_type));

  // TX overhead
  // Non-witness: version(4) + input_count(varint) + output_count(varint) + locktime(4)
  // Witness: adds marker(1) + flag(1) but these are in witness area, so 0.5 vB each = +0.5 total
  let overhead = 10; // version(4) + input_count_varint(1) + output_count_varint(1) + locktime(4)
  if (hasWitness) {
    overhead += 0.5; // marker+flag in witness = 2 bytes / 4 = 0.5 vB
  }

  // Varint adjustment for many inputs/outputs
  const numInputs = inputs.length;
  const numOutputs = paymentOutputs.length + (hasChange ? 1 : 0);
  if (numInputs >= 253) overhead += 2; // varint uses 3 bytes
  if (numOutputs >= 253) overhead += 2;

  // Input vbytes
  let inputVb = 0;
  for (const inp of inputs) {
    const ivb = INPUT_VBYTES[inp.script_type];
    if (ivb === undefined) {
      throw { code: 'UNSUPPORTED_SCRIPT', message: `Unsupported input script type: ${inp.script_type}` };
    }
    inputVb += ivb;
  }

  // Output vbytes
  let outputVb = 0;
  for (const out of paymentOutputs) {
    const scriptType = out.script_type || guessScriptType(out.script_pubkey_hex);
    const ovb = OUTPUT_VBYTES[scriptType];
    if (ovb === undefined) {
      throw { code: 'UNSUPPORTED_SCRIPT', message: `Unsupported output script type: ${scriptType}` };
    }
    outputVb += ovb;
  }

  // Change output
  if (hasChange) {
    const covb = OUTPUT_VBYTES[changeScriptType];
    if (covb === undefined) {
      throw { code: 'UNSUPPORTED_SCRIPT', message: `Unsupported change script type: ${changeScriptType}` };
    }
    outputVb += covb;
  }

  return Math.ceil(overhead + inputVb + outputVb);
}

function guessScriptType(scriptPubKeyHex) {
  if (!scriptPubKeyHex) return 'p2wpkh';
  const len = scriptPubKeyHex.length / 2; // byte length
  if (scriptPubKeyHex.startsWith('0014') && len === 22) return 'p2wpkh';
  if (scriptPubKeyHex.startsWith('5120') && len === 34) return 'p2tr';
  if (scriptPubKeyHex.startsWith('76a914') && scriptPubKeyHex.endsWith('88ac')) return 'p2pkh';
  if (scriptPubKeyHex.startsWith('a914') && scriptPubKeyHex.endsWith('87')) return 'p2sh';
  if (scriptPubKeyHex.startsWith('0020') && len === 34) return 'p2wsh';
  return 'p2wpkh'; // fallback
}

// ─── Coin selection strategies ──────────────────────────────────────────────

// Strategy 1: Greedy (largest first)
function selectCoins(utxos, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs) {
  const sorted = [...utxos].sort((a, b) => b.value_sats - a.value_sats);
  return _pickUntilFunded(sorted, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs);
}

// Strategy 2: Random shuffle
function selectCoinsRandom(utxos, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs) {
  const shuffled = [...utxos];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return _pickUntilFunded(shuffled, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs);
}

// Strategy 3: Branch-and-Bound (tries to find exact match to avoid change)
function selectCoinsBnB(utxos, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs) {
  const sorted = [...utxos].sort((a, b) => b.value_sats - a.value_sats);
  const limit = maxInputs || sorted.length;

  // Target range: fee-no-change ≤ totalInput - target ≤ fee-with-change + dust
  // We try to find a subset where leftover is exactly the no-change fee (no change output)
  const MAX_TRIES = 100000;
  let tries = 0;
  let bestSelection = null;
  let bestWaste = Infinity;

  function search(index, selected, totalVal) {
    if (tries++ > MAX_TRIES) return;
    if (selected.length > limit) return;

    if (selected.length > 0) {
      const vbNoChange = estimateVbytes(selected, paymentOutputs, false, changeScriptType);
      const feeNoChange = Math.ceil(vbNoChange * feeRate);
      const excess = totalVal - targetAmount - feeNoChange;

      if (excess >= 0 && excess < DUST_THRESHOLD) {
        // Exact match (leftover is sub-dust, so no change needed)
        const waste = excess; // waste = overpaid fee
        if (waste < bestWaste) {
          bestWaste = waste;
          bestSelection = [...selected];
        }
        return; // Don't go deeper, we found a valid match
      }

      // If we overshoot even without including more, prune
      if (excess >= DUST_THRESHOLD) {
        // Could still be valid with-change, but BnB is looking for changeless
        // Check with change too
        const vbWithChange = estimateVbytes(selected, paymentOutputs, true, changeScriptType);
        const feeWithChange = Math.ceil(vbWithChange * feeRate);
        const changeAmount = totalVal - targetAmount - feeWithChange;
        if (changeAmount >= DUST_THRESHOLD) {
          const waste = changeAmount; // "waste" = change (not ideal for BnB)
          if (waste < bestWaste) {
            bestWaste = waste;
            bestSelection = [...selected];
          }
        }
      }
    }

    for (let i = index; i < sorted.length; i++) {
      selected.push(sorted[i]);
      search(i + 1, selected, totalVal + sorted[i].value_sats);
      selected.pop();
      if (tries > MAX_TRIES) return;
    }
  }

  search(0, [], 0);

  if (bestSelection) return bestSelection;

  // Fallback to greedy if BnB fails
  return selectCoins(utxos, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs);
}

// Shared helper: pick UTXOs from ordered list until funded
function _pickUntilFunded(ordered, targetAmount, feeRate, paymentOutputs, changeScriptType, maxInputs) {
  const limit = maxInputs || ordered.length;
  const selected = [];
  let totalSelected = 0;

  for (const utxo of ordered) {
    if (selected.length >= limit) break;
    selected.push(utxo);
    totalSelected += utxo.value_sats;

    const vbWithChange = estimateVbytes(selected, paymentOutputs, true, changeScriptType);
    const feeWithChange = Math.ceil(vbWithChange * feeRate);
    if (totalSelected >= targetAmount + feeWithChange) return selected;

    const vbNoChange = estimateVbytes(selected, paymentOutputs, false, changeScriptType);
    const feeNoChange = Math.ceil(vbNoChange * feeRate);
    if (totalSelected >= targetAmount + feeNoChange) return selected;
  }

  const vbNoChange = estimateVbytes(selected, paymentOutputs, false, changeScriptType);
  const feeNoChange = Math.ceil(vbNoChange * feeRate);
  if (totalSelected >= targetAmount + feeNoChange) return selected;

  throw { code: 'INSUFFICIENT_FUNDS', message: 'Not enough funds in available UTXOs to cover payments and fees' };
}

const STRATEGY_FNS = {
  greedy: selectCoins,
  random: selectCoinsRandom,
  bnb: selectCoinsBnB,
};

// Compare all strategies and score them
function compareStrategies(fixture) {
  const feeRate = fixture.fee_rate_sat_vb;
  const changeScriptType = fixture.change.script_type || guessScriptType(fixture.change.script_pubkey_hex);
  const maxInputs = fixture.policy && fixture.policy.max_inputs ? fixture.policy.max_inputs : null;
  const totalPayment = fixture.payments.reduce((sum, p) => sum + p.value_sats, 0);

  const results = [];
  for (const [name, fn] of Object.entries(STRATEGY_FNS)) {
    try {
      const selected = fn(fixture.utxos, totalPayment, feeRate, fixture.payments, changeScriptType, maxInputs);
      const totalInput = selected.reduce((s, u) => s + u.value_sats, 0);

      const vbWithChange = estimateVbytes(selected, fixture.payments, true, changeScriptType);
      const feeWithChange = Math.ceil(vbWithChange * feeRate);
      const changeAmount = totalInput - totalPayment - feeWithChange;

      let fee, vbytes, hasChange;
      if (changeAmount >= DUST_THRESHOLD) {
        hasChange = true;
        fee = feeWithChange;
        vbytes = vbWithChange;
      } else {
        hasChange = false;
        vbytes = estimateVbytes(selected, fixture.payments, false, changeScriptType);
        fee = totalInput - totalPayment;
      }

      const waste = fee + (hasChange ? changeAmount : 0);

      results.push({
        strategy: name,
        input_count: selected.length,
        fee_sats: fee,
        vbytes,
        has_change: hasChange,
        waste_score: waste,
      });
    } catch (_) {
      results.push({ strategy: name, error: 'INSUFFICIENT_FUNDS' });
    }
  }

  // Sort by waste (lower = better)
  results.sort((a, b) => (a.waste_score || Infinity) - (b.waste_score || Infinity));
  return results;
}

// ─── Watch-only descriptors ─────────────────────────────────────────────────

function generateDescriptors(selectedInputs, outputs) {
  const seen = new Set();
  const descriptors = [];

  const addDescriptor = (scriptHex, scriptType, address, role) => {
    if (seen.has(scriptHex)) return;
    seen.add(scriptHex);

    let descriptor;
    if (address) {
      descriptor = `addr(${address})`;
    } else {
      descriptor = `raw(${scriptHex})`;
    }

    descriptors.push({
      role,
      script_type: scriptType,
      script_hex: scriptHex,
      descriptor,
    });
  };

  for (const inp of selectedInputs) {
    addDescriptor(inp.script_pubkey_hex, inp.script_type, inp.address, 'input');
  }
  for (const out of outputs) {
    addDescriptor(out.script_pubkey_hex, out.script_type, out.address, out.is_change ? 'change' : 'payment');
  }

  return descriptors;
}

// ─── Privacy Meter ──────────────────────────────────────────────────────────

function analyzePrivacy(selectedInputs, outputs, changeIndex) {
  let score = 100;
  const riskFactors = [];

  // 1. Input script reuse
  const inputScripts = selectedInputs.map(i => i.script_pubkey_hex);
  const uniqueInputScripts = new Set(inputScripts);
  if (uniqueInputScripts.size < inputScripts.length) {
    score -= 25;
    riskFactors.push({ code: 'INPUT_REUSE', description: 'Multiple inputs share the same scriptPubKey (address reuse)', penalty: 25 });
  }

  // 2. Change output script type mismatch
  if (changeIndex !== null && changeIndex !== undefined) {
    const changeOut = outputs[changeIndex];
    const paymentOuts = outputs.filter(o => !o.is_change);
    const paymentTypes = new Set(paymentOuts.map(o => o.script_type));
    if (changeOut && !paymentTypes.has(changeOut.script_type)) {
      score -= 20;
      riskFactors.push({ code: 'CHANGE_TYPE_MISMATCH', description: `Change output type (${changeOut.script_type}) differs from payment types — makes change identifiable`, penalty: 20 });
    }
  }

  // 3. Round amounts in payments
  const paymentOuts = outputs.filter(o => !o.is_change);
  const hasRoundAmounts = paymentOuts.some(o => o.value_sats % 10000 === 0 && o.value_sats > 0);
  if (hasRoundAmounts) {
    score -= 15;
    riskFactors.push({ code: 'ROUND_PAYMENT', description: 'Payment outputs have round amounts (multiples of 10,000 sats) — easy to distinguish from change', penalty: 15 });
  }

  // 4. Single output (no change)
  if (outputs.length === 1) {
    score -= 10;
    riskFactors.push({ code: 'SINGLE_OUTPUT', description: 'Transaction has only one output — trivially deanonymizable', penalty: 10 });
  }

  // 5. Many inputs (address linkage)
  if (selectedInputs.length > 3) {
    const penalty = Math.min(15, (selectedInputs.length - 3) * 5);
    score -= penalty;
    riskFactors.push({ code: 'MANY_INPUTS', description: `${selectedInputs.length} inputs linked as same wallet (common-input-ownership heuristic)`, penalty });
  }

  return {
    score: Math.max(0, score),
    max_score: 100,
    risk_factors: riskFactors,
  };
}

// ─── Sign & Finalize with test keys ─────────────────────────────────────────

function signAndFinalize(psbt, selectedInputs) {
  for (let i = 0; i < selectedInputs.length; i++) {
    const inp = selectedInputs[i];
    // Generate deterministic test key from a seed derived from index
    const seedHex = ('00'.repeat(32) + i.toString(16)).slice(-64);
    // Ensure we get a valid private key (must be 1..n-1)
    const seedBuf = Buffer.from(seedHex, 'hex');
    seedBuf[0] = 0x01; // Ensure non-zero

    const keyPair = ECPair.fromPrivateKey(seedBuf);

    try {
      psbt.signInput(i, keyPair);
    } catch (_) {
      // Some input types (p2tr) need tweaked keys; skip on failure
    }
  }

  try {
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return {
      signed_psbt_base64: psbt.toBase64(),
      tx_hex: tx.toHex(),
    };
  } catch (e) {
    return {
      signed_psbt_base64: psbt.toBase64(),
      tx_hex: null,
      sign_error: e.message || 'Finalization failed (test keys do not match input scripts)',
    };
  }
}

// ─── Build transaction ──────────────────────────────────────────────────────

function buildTransaction(fixture) {
  validateFixture(fixture);

  const feeRate = fixture.fee_rate_sat_vb;
  const changeScriptType = fixture.change.script_type || guessScriptType(fixture.change.script_pubkey_hex);
  const maxInputs = fixture.policy && fixture.policy.max_inputs ? fixture.policy.max_inputs : null;

  // Total payment amount
  const totalPayment = fixture.payments.reduce((sum, p) => sum + p.value_sats, 0);

  // Determine coin selection strategy
  const strategyName = fixture.strategy || 'greedy';
  const isCompare = strategyName === 'compare';
  const selectFn = isCompare ? selectCoins : (STRATEGY_FNS[strategyName] || selectCoins);

  // Select coins
  const selectedInputs = selectFn(
    fixture.utxos, totalPayment, feeRate,
    fixture.payments, changeScriptType, maxInputs
  );

  const totalInput = selectedInputs.reduce((sum, u) => sum + u.value_sats, 0);

  // ─── Fee/change calculation (iterative) ─────────────────────────────────
  // Try with change first
  const vbWithChange = estimateVbytes(selectedInputs, fixture.payments, true, changeScriptType);
  const feeWithChange = Math.ceil(vbWithChange * feeRate);
  const changeAmount = totalInput - totalPayment - feeWithChange;

  let hasChange, finalFee, finalVbytes, finalChangeAmount;

  if (changeAmount >= DUST_THRESHOLD) {
    // Change is viable
    hasChange = true;
    finalFee = feeWithChange;
    finalVbytes = vbWithChange;
    finalChangeAmount = changeAmount;
  } else {
    // No change — leftover becomes fee
    hasChange = false;
    finalVbytes = estimateVbytes(selectedInputs, fixture.payments, false, changeScriptType);
    finalFee = totalInput - totalPayment;
    finalChangeAmount = 0;
  }

  // ─── RBF / locktime ─────────────────────────────────────────────────────
  const { nSequence, nLockTime } = computeSequenceAndLocktime(fixture);
  const rbfSignaling = nSequence <= 0xFFFFFFFD;
  const locktimeType = classifyLocktime(nLockTime);

  // ─── Build PSBT ─────────────────────────────────────────────────────────
  const network = fixture.network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

  const psbt = new bitcoin.Psbt({ network });
  psbt.setVersion(2);
  psbt.setLocktime(nLockTime);

  // Add inputs
  for (const inp of selectedInputs) {
    const txidBuf = Buffer.from(inp.txid, 'hex').reverse(); // txid is displayed in reverse byte order
    const scriptBuf = Buffer.from(inp.script_pubkey_hex, 'hex');

    const inputData = {
      hash: txidBuf,
      index: inp.vout,
      sequence: nSequence,
    };

    // Add witness_utxo for segwit inputs
    const isSegwit = ['p2wpkh', 'p2tr', 'p2sh-p2wpkh', 'p2wsh'].includes(inp.script_type);
    if (isSegwit) {
      inputData.witnessUtxo = {
        script: scriptBuf,
        value: inp.value_sats,
      };
    }

    // For p2sh-p2wpkh, add redeemScript (witness program)
    if (inp.script_type === 'p2sh-p2wpkh') {
      // The redeemScript for p2sh-p2wpkh is OP_0 <20-byte-hash>
      // We need to derive it from the p2sh script. For fixture purposes,
      // we provide a generic witness program. We'll use the hash from the p2sh.
      // The p2sh scriptPubKey is: OP_HASH160 <20-byte-hash> OP_EQUAL
      // Extract the 20-byte hash
      const p2shHash = scriptBuf.slice(2, 22);
      // The redeemScript is OP_0 PUSH20 <20-byte-hash> - but this is the witness program
      // For p2sh-p2wpkh: redeemScript = 0x0014 + <20-byte-pubkey-hash>
      // We don't have the actual pubkey hash, but we'll construct a plausible redeemScript
      // Using the input's scriptPubKey structure
      const redeemScript = Buffer.concat([Buffer.from('0014', 'hex'), p2shHash]);
      inputData.redeemScript = redeemScript;
    }

    // For non-segwit (p2pkh), we should add non_witness_utxo (full tx)
    // Since we don't have the full previous tx, add witness_utxo as a fallback
    // Many PSBT implementations accept witness_utxo for all input types
    if (!isSegwit) {
      inputData.witnessUtxo = {
        script: scriptBuf,
        value: inp.value_sats,
      };
    }

    psbt.addInput(inputData);
  }

  // Add payment outputs
  const outputs = [];
  for (let i = 0; i < fixture.payments.length; i++) {
    const pay = fixture.payments[i];
    const scriptBuf = Buffer.from(pay.script_pubkey_hex, 'hex');
    psbt.addOutput({
      script: scriptBuf,
      value: pay.value_sats,
    });
    outputs.push({
      n: i,
      value_sats: pay.value_sats,
      script_pubkey_hex: pay.script_pubkey_hex,
      script_type: pay.script_type || guessScriptType(pay.script_pubkey_hex),
      address: pay.address || '',
      is_change: false,
    });
  }

  // Add change output
  let changeIndex = null;
  if (hasChange) {
    const changeScript = Buffer.from(fixture.change.script_pubkey_hex, 'hex');
    psbt.addOutput({
      script: changeScript,
      value: finalChangeAmount,
    });
    changeIndex = outputs.length;
    outputs.push({
      n: changeIndex,
      value_sats: finalChangeAmount,
      script_pubkey_hex: fixture.change.script_pubkey_hex,
      script_type: changeScriptType,
      address: fixture.change.address || '',
      is_change: true,
    });
  }

  // Compute actual fee rate
  const actualFeeRate = finalFee / finalVbytes;

  // ─── Warnings ───────────────────────────────────────────────────────────
  const warnings = [];

  if (finalFee > 1000000 || actualFeeRate > 200) {
    warnings.push({ code: 'HIGH_FEE' });
  }

  if (hasChange && finalChangeAmount < DUST_THRESHOLD) {
    warnings.push({ code: 'DUST_CHANGE' });
  }

  if (!hasChange) {
    warnings.push({ code: 'SEND_ALL' });
  }

  if (rbfSignaling) {
    warnings.push({ code: 'RBF_SIGNALING' });
  }

  // ─── Serialize PSBT ─────────────────────────────────────────────────────
  const psbtBase64 = psbt.toBase64();

  // ─── Descriptors ────────────────────────────────────────────────────────
  const descriptors = generateDescriptors(selectedInputs, outputs);

  // ─── Privacy Meter ──────────────────────────────────────────────────────
  const privacy = analyzePrivacy(selectedInputs, outputs, changeIndex);

  // ─── Strategy Comparison ────────────────────────────────────────────────
  let strategyComparison = undefined;
  if (isCompare) {
    strategyComparison = compareStrategies(fixture);
  }

  // ─── Sign & Finalize (test keys) ────────────────────────────────────────
  let signResult = undefined;
  if (fixture.test_keys === true) {
    // Clone the PSBT for signing (original stays unsigned)
    const psbtForSign = bitcoin.Psbt.fromBase64(psbtBase64, { network });
    signResult = signAndFinalize(psbtForSign, selectedInputs);
  }

  // ─── Build report ───────────────────────────────────────────────────────
  const report = {
    ok: true,
    network: fixture.network,
    strategy: isCompare ? 'greedy' : (strategyName || 'greedy'),
    selected_inputs: selectedInputs.map(u => ({
      txid: u.txid,
      vout: u.vout,
      value_sats: u.value_sats,
      script_pubkey_hex: u.script_pubkey_hex,
      script_type: u.script_type,
      address: u.address || '',
    })),
    outputs,
    change_index: changeIndex,
    fee_sats: finalFee,
    fee_rate_sat_vb: Math.round(actualFeeRate * 100) / 100,
    vbytes: finalVbytes,
    rbf_signaling: rbfSignaling,
    locktime: nLockTime,
    locktime_type: locktimeType,
    psbt_base64: psbtBase64,
    warnings,
    descriptors,
    privacy,
  };

  if (strategyComparison) report.strategy_comparison = strategyComparison;
  if (signResult) {
    report.signed_psbt_base64 = signResult.signed_psbt_base64;
    report.tx_hex = signResult.tx_hex;
    if (signResult.sign_error) report.sign_error = signResult.sign_error;
  }

  return report;
}

module.exports = {
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
};
