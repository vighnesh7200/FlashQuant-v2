// Mental-math tricks matched to the player's weak spots. Pure functions.

import { OPS, weakTypes, typeAgg, errAgg, problemInBucket, normalizeConfig } from './core.js';

const nextTen = (n) => Math.ceil(n / 10) * 10;

// A worked example of one technique for one operation, using the actual operands shown.
export function tipFor(op, x, y) {
  if (op === 'a') {
    const [big, small] = x >= y ? [x, y] : [y, x];
    if (big % 10 >= 5) {
      const r = nextTen(big);
      return `Round up, then correct. ${big} + ${small}: ${r} + ${small} = ${r + small}, then take off ${r - big} to get ${big + small}.`;
    }
    if (big % 10 === 0 || small % 10 === 0) {
      return `Keep the round number whole. ${big} + ${small}: add the tens first, then the units, to get ${big + small}.`;
    }
    const bt = big - (big % 10);
    const st = small - (small % 10);
    return `Tens first, then units. ${big} + ${small}: ${bt} + ${st} = ${bt + st}, then ${big % 10} + ${small % 10} = ${(big % 10) + (small % 10)}, so ${big + small}.`;
  }
  if (op === 's') {
    const m = x + y;
    const t = nextTen(x);
    if (t >= m || t === x) return `Count up instead of borrowing. ${m} − ${x}: how far is it from ${x} up to ${m}? It is ${y}.`;
    return `Count up instead of borrowing. ${m} − ${x}: go from ${x} up ${t - x} to ${t}, then up ${m - t} to ${m}. ${t - x} + ${m - t} = ${y}.`;
  }
  if (op === 'm') {
    const big = Math.max(x, y);
    const small = Math.min(x, y);
    if (big >= 10) {
      if (big % 10 === 0) return `Multiply by the tens digit, then add a zero. ${small} × ${big / 10} = ${(small * big) / 10}, so ${small} × ${big} = ${small * big}.`;
      const t = big - (big % 10);
      return `Split the bigger number. ${small} × ${big} = ${small} × ${t} + ${small} × ${big % 10} = ${small * t} + ${small * (big % 10)} = ${small * big}.`;
    }
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    return `Use a neighbour fact. ${lo} × ${hi}: ${lo} × ${hi - 1} = ${lo * (hi - 1)}, plus one more ${lo} is ${lo * hi}.`;
  }
  const q = y;
  const n = x * y;
  if (q >= 10 && q % 10 === 0) return `Divide in chunks. ${n} ÷ ${x}: ${x} × ${q / 10} = ${n / 10}, so the answer is ten times that: ${q}.`;
  if (q >= 10) {
    const t = q - (q % 10);
    return `Divide in chunks. ${n} ÷ ${x}: ${x} × ${t} = ${x * t}, which leaves ${n - x * t}. ${n - x * t} ÷ ${x} = ${q % 10}, so ${t} + ${q % 10} = ${q}.`;
  }
  return `Multiply back. ${n} ÷ ${x}: ask what ${x} times what makes ${n}. ${x} × ${q} = ${n}, so the answer is ${q}.`;
}

const GENERIC = 'Round up, then correct. For 38 + 47, do 40 + 47 = 87, then take off 2 to get 85. Play a few rounds and tricks will match your weak spots.';

// Picks something relevant: an accuracy tip if mistakes are the bigger problem, otherwise a technique for a weak type.
// rotation changes the suggestion each visit so you do not see the same tip every time.
export function trickFor(records, rotation = 0, rng = Math.random) {
  const weak = weakTypes(typeAgg(records));
  if (!weak.length) return { html: '<b>Trick:</b> ' + GENERIC };
  const errs = errAgg(records);
  const kinds = [0, 0, 0];
  Object.values(errs).forEach((e) => e.forEach((v, i) => (kinds[i] += v)));
  const totalErr = kinds[0] + kinds[1] + kinds[2];
  const n = weak.reduce((p, w) => p + w.n, 0);
  const w = weak.reduce((p, x) => p + x.w, 0);
  if (n && w / n > 0.1 && totalErr >= 5 && rotation % 2 === 1) {
    if (kinds[0] / totalErr > 0.4) return { html: '<b>Accuracy trick:</b> Many of your wrong answers are off by exactly 10, 20 and so on. That is a dropped carry or borrow. Settle the tens digit first, then deal with the units.' };
    if (kinds[1] / totalErr > 0.4) return { html: '<b>Accuracy trick:</b> Many of your wrong answers are off by just 1 or 2. Glance at the units digit once more before you commit.' };
    return { html: '<b>Accuracy trick:</b> Your wrong answers are usually far from the right one, which points to facts you have not memorised yet. Drill those facts slowly before you chase speed.' };
  }
  const pickW = weak[rotation % Math.min(3, weak.length)];
  const [op, bucket] = pickW.k.split('|');
  const cfg = normalizeConfig({ ops: [op], a: [11, 99, 11, 99], m: [2, 12, 2, 99] });
  const ex = problemInBucket(op, bucket, cfg, rng);
  const tip = ex ? tipFor(op, ex.x, ex.y) : GENERIC;
  return { html: `<b>Trick for ${OPS[op]}, ${bucket.toLowerCase()}:</b> ${tip}` };
}
