/*
 * files_quick_open_worker.js - the worker-side half of the Files quick open
 * feature. Embedded at the head of upstream's file-index worker bundle
 * (.vite/build/file-index-worker/fileIndexWorker.js) by
 * patches/community/add_feature_files_quick_open_worker.nim, which also rewrites
 * the ONE call site `this.index.search(query, limit)` inside
 * FileIndexHost.search to `__cdbQoSearch(this.index, query, limit)`.
 *
 * WHY: upstream's scorer walks the query character by character with indexOf,
 * so whitespace in the query has to occur literally in the path - "user
 * service" returns nothing while "user-service" finds user-service.spec.ts.
 * VS Code (src/vs/base/common/fuzzyScorer.ts) splits the query on spaces into
 * pieces, requires EVERY piece to match (doScoreItemFuzzyMultiple returns
 * NO_ITEM_SCORE otherwise), sums the piece scores and merges the match ranges.
 * This helper ports exactly that on top of upstream's unchanged scorer - the
 * MEMBERSHIP from upstream's own per-piece scans, the ORDER from a VS Code-style
 * label-first score (__cdbQoScorePath below), because upstream only hands us an
 * ordinal rank per piece and a sum of ordinals ranks directories above files.
 *
 * CONTRACT of `index` (upstream's scorer instance, class T in the worker):
 *   index.readyCount           number of indexed paths (0 while building)
 *   index.search(query, limit) -> [{ path, score: rank/n, positions: number[] }]
 *                                 best first, at most `limit`
 *
 * GATE: process.env.CDB_FILES_QUICK_OPEN === "1". The main process mirrors the
 * `filesQuickOpen` pref into that variable (js/files_quick_open_main.js) and
 * Electron's utilityProcess.fork() passes main's env through unchanged, so a
 * worker forked after the pref changed sees the new value. Off / unset means the
 * query reaches upstream's scorer verbatim - a full retreat to stock behaviour.
 *
 * Utility-process module scope: a top-level function declaration here is
 * visible to the rest of the bundle because the patch splices this file into
 * the same module. Every name here carries the __cdbQo prefix so nothing in
 * upstream's own module scope can be shadowed.
 */
// Is `needle` a subsequence of `hay`? (Both already case-folded by the caller.)
function __cdbQoIsSubseq(hay, needle) {
  var from = 0;
  for (var i = 0; i < needle.length; i++) {
    var at = hay.indexOf(needle.charAt(i), from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}
// How well ONE query piece describes the file NAME. VS Code scores the label
// first and only falls back to the path/description when the label does not
// match (fuzzyScorer.ts doScoreItemFuzzySingle: LABEL_PREFIX_SCORE_THRESHOLD
// 1<<17 with a shortness boost > LABEL_SCORE_THRESHOLD 1<<16 > path).
// Smart case, like upstream's own scorer: an uppercase character in the piece
// makes the comparison case-sensitive; otherwise both sides are lowercased
// (a piece with no uppercase character IS its own lowercase form).
function __cdbQoScorePiece(base, piece) {
  var b = /[A-Z]/.test(piece) ? base : base.toLowerCase();
  var at = b.indexOf(piece);
  if (at === 0) return 1000;                          // name starts with the piece
  if (at > 0) return 700;                             // name contains it contiguously
  if (__cdbQoIsSubseq(b, piece)) return 400;          // name contains it as a subsequence
  return 100;                                         // matched only in the directory
}
// Total score for a candidate path. The AND-intersection already proved every
// piece matches SOMEWHERE in the path, so the job here is only to order them.
function __cdbQoScorePath(path, pieces) {
  var slash = path.lastIndexOf("/");
  var base = slash >= 0 ? path.slice(slash + 1) : path;
  var score = 0;
  for (var i = 0; i < pieces.length; i++) score += __cdbQoScorePiece(base, pieces[i]);
  score += Math.max(0, 64 - base.length);             // VS Code's shortness boost
  for (var c = 0; c < path.length; c++) if (path.charAt(c) === "/") score -= 2;   // depth penalty
  return score;
}
function __cdbQoSearch(index, query, limit) {
  "use strict";
  var raw = String(query == null ? "" : query);
  var on = false;
  try { on = typeof process !== "undefined" && process.env && process.env.CDB_FILES_QUICK_OPEN === "1"; } catch (e) { on = false; }
  if (!on) return index.search(raw, limit);

  var pieces = raw.split(/\s+/).filter(function (p) { return p.length > 0; });
  // Empty or single piece: upstream's own search, on the trimmed text (a trailing
  // space would otherwise have to match a literal space in the path).
  if (pieces.length === 0) return index.search(raw, limit);
  if (pieces.length === 1) return index.search(pieces[0], limit);
  // Bound the per-keystroke cost: at most 4 scans. Extra pieces are folded into
  // the last one (still a subsequence, just longer).
  var MAX_PIECES = 4;
  if (pieces.length > MAX_PIECES) {
    pieces = pieces.slice(0, MAX_PIECES - 1).concat([pieces.slice(MAX_PIECES - 1).join("")]);
  }
  if (typeof limit !== "number" || limit <= 0) return [];

  // Every piece scans the WHOLE ready set: intersecting two top-N lists would
  // drop a file that is a mediocre match for one piece and a great one for the
  // other, which is precisely the "user service" case.
  var total = (typeof index.readyCount === "number" && index.readyCount > 0) ? index.readyCount : 0;
  if (total === 0) return [];

  // Seed from the first piece: path -> { rank sum, positions }.
  var first = index.search(pieces[0], total);
  var acc = new Map();
  for (var i = 0; i < first.length; i++) {
    var r = first[i];
    acc.set(r.path, { path: r.path, rank: i, positions: Array.prototype.slice.call(r.positions || []) });
  }
  // AND with every further piece; sum ranks (lower = better), union positions.
  for (var k = 1; k < pieces.length && acc.size > 0; k++) {
    var hits = index.search(pieces[k], total);
    var byPath = new Map();
    for (var j = 0; j < hits.length; j++) byPath.set(hits[j].path, { rank: j, positions: hits[j].positions || [] });
    acc.forEach(function (entry, path) {
      var h = byPath.get(path);
      if (!h) { acc.delete(path); return; }
      entry.rank += h.rank;
      for (var q = 0; q < h.positions.length; q++) entry.positions.push(h.positions[q]);
    });
  }

  // ORDER the intersection by a real score, not by the summed ordinal rank.
  // Summing two ordinals is not a score: a short path that lands early in both
  // per-piece scans (a DIRECTORY) then outranks the deep file the query actually
  // describes - measured live on 1.40609.0, a two-word query put four sibling
  // directories above the file it named, and adding a third word pushed that
  // file out of the top four entirely.
  // VS Code scores the label (file name) first, so score the basename and keep
  // upstream's ordinal only as the TIE-BREAK - as a sort key, not as a term in
  // the score: the summed ordinal is unbounded (readyCount per piece) and any
  // scaled version of it would overpower the label tiers on a large index, which
  // is the very bug this replaces. The result SET is untouched; only the order.
  var merged = [];
  acc.forEach(function (entry) { entry.qoScore = __cdbQoScorePath(entry.path, pieces); merged.push(entry); });
  merged.sort(function (a, b) {
    return b.qoScore - a.qoScore || a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  var out = merged.slice(0, limit);
  var n = Math.max(out.length, 1);
  return out.map(function (entry, idx) {
    // Ascending + distinct, like VS Code's normalizeMatches.
    var pos = entry.positions.slice().sort(function (a, b) { return a - b; });
    var uniq = [];
    for (var u = 0; u < pos.length; u++) if (u === 0 || pos[u] !== pos[u - 1]) uniq.push(pos[u]);
    return { path: entry.path, score: idx / n, positions: uniq };
  });
}
