"""Rate-quality evaluation for x264 configurations on the Pare test corpus.

Each (clip, config, crf) point is encoded with the native x264 build (single-threaded, so results match what one
Pare worker produces) and scored against the decoded source with VMAF, VMAF NEG, PSNR-Y and SSIM.
Results are cached in results.jsonl keyed by (clip, x264 binary, args).
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

ROOT = os.path.expanduser('~/pare-research')
FFMPEG = f'{ROOT}/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg'
X264 = {'asm': f'{ROOT}/build-asm/x264', 'noasm': f'{ROOT}/build-noasm/x264'}
REF = f'{ROOT}/corpus/ref'
CLIPS = ['town', 'park', 'tree', 'ducks', 'bbb', 'screen']
CACHE = f'{ROOT}/bench/results.jsonl'


def _key(clip, build, args):
    return hashlib.sha1(json.dumps([clip, build, args]).encode()).hexdigest()


def _load_cache():
    cache = {}
    if os.path.exists(CACHE):
        for line in open(CACHE):
            row = json.loads(line)
            cache[row['key']] = row
    return cache


_cache = _load_cache()


def score(out, ref, tmp):
    log = f'{tmp}/vmaf.json'
    # Align by frame index in a shared timebase: MKV stores millisecond timestamps, which would pair
    # 30 fps frames off by one, and the two inputs have different timebases.
    vmaf = (f"[0:v]settb=1,setpts=N[d];[1:v]settb=1,setpts=N[r];[d][r]libvmaf=model='version=vmaf_v0.6.1\\:name=vmaf|version=vmaf_v0.6.1neg\\:name=vmaf_neg'"
            f":feature='name=psnr|name=float_ssim':n_threads=3:log_fmt=json:log_path={log}")
    subprocess.run([FFMPEG, '-loglevel', 'error', '-i', out, '-i', ref, '-lavfi', vmaf, '-f', 'null', '-'], check=True)
    data = json.load(open(log))
    pooled = data['pooled_metrics']
    return {
        'frames': len(data['frames']),
        'vmaf': pooled['vmaf']['mean'], 'vmaf_neg': pooled['vmaf_neg']['mean'], 'vmaf_min': pooled['vmaf']['min'],
        'psnr_y': pooled['psnr_y']['mean'], 'ssim': pooled['float_ssim']['mean'],
    }


def rescore(workers=4):
    """Recomputes metrics for every cached row from its saved encode."""
    rows = list(_cache.values())

    def one(row):
        with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
            row.update(score(f'{ROOT}/bench/out/{row["key"]}.mkv', f'{REF}/{row["clip"]}.y4m', tmp))
        return row

    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(one, rows))
    with open(CACHE, 'w') as f:
        for row in rows:
            f.write(json.dumps(row) + '\n')


def encode_and_score(clip, args, build='asm', filters=None):
    """Encodes `clip` with x264 `args` (list of CLI flags) and returns size, time and metrics."""
    key = _key(clip, build, [args, filters])
    if key in _cache:
        return _cache[key]
    ref = f'{REF}/{clip}.y4m'
    os.makedirs(f'{ROOT}/bench/out', exist_ok=True)
    with tempfile.TemporaryDirectory(dir='/tmp') as tmp:
        src = ref
        if filters:
            # Pre-filtering happens before the encoder; quality is still measured against the untouched reference.
            src = f'{tmp}/filtered.y4m'
            subprocess.run([FFMPEG, '-loglevel', 'error', '-i', ref, '-vf', filters, '-strict', '-1', src], check=True)
        out = f'{ROOT}/bench/out/{key}.mkv'
        t = time.perf_counter()
        subprocess.run([X264[build], '--threads', '1', '--quiet', *args, '-o', out, src],
                       check=True, stderr=subprocess.DEVNULL)
        seconds = time.perf_counter() - t
        size = os.path.getsize(out)
        metrics = score(out, ref, tmp)
    row = {
        'key': key, 'clip': clip, 'build': build, 'args': args, 'filters': filters,
        'bytes': size, 'seconds': seconds,
        **metrics,
    }
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    _cache[key] = row
    return row


def sweep(config_args, crfs, clips=CLIPS, build='asm', filters=None, workers=7):
    jobs = [(clip, [*config_args, '--crf', str(crf)]) for clip in clips for crf in crfs]
    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(lambda j: encode_and_score(j[0], j[1], build, filters), jobs))


def bd_rate(anchor, test, metric='vmaf'):
    """Bjøntegaard delta rate: average % bitrate change of `test` vs `anchor` at equal `metric`. Negative = better.

    Uses monotone piecewise-cubic (PCHIP) interpolation of log-rate over quality, integrated over the overlapping
    quality range. The classic cubic polyfit breaks down on saturating metrics like VMAF near 100.
    """
    from scipy.integrate import quad
    from scipy.interpolate import PchipInterpolator

    def curve(rows):
        pts = sorted(((r[metric], np.log(r['bytes'])) for r in rows))
        q, r = zip(*pts)
        q, keep = np.array(q), [0]
        for i in range(1, len(q)):
            if q[i] > q[keep[-1]] + 1e-9:  # drop non-increasing quality points
                keep.append(i)
        return q[keep], np.array(r)[keep]

    qa, ra = curve(anchor)
    qt, rt = curve(test)
    if len(qa) < 2 or len(qt) < 2:
        return float('nan')
    lo, hi = max(qa.min(), qt.min()), min(qa.max(), qt.max())
    if hi <= lo:
        return float('nan')
    fa, ft = PchipInterpolator(qa, ra), PchipInterpolator(qt, rt)
    avg_a = quad(fa, lo, hi, limit=200)[0] / (hi - lo)
    avg_t = quad(ft, lo, hi, limit=200)[0] / (hi - lo)
    return (np.exp(avg_t - avg_a) - 1) * 100


def quality_at_size(points, target_bytes, metric='vmaf'):
    """Interpolates `metric` at `target_bytes` along a clip's rate-quality points (log-rate, linear quality)."""
    pts = sorted(points, key=lambda r: r['bytes'])
    x = np.log([p['bytes'] for p in pts])
    y = np.array([p[metric] for p in pts])
    return float(np.interp(np.log(target_bytes), x, y))


if __name__ == '__main__':
    if sys.argv[1] == 'rescore':
        rescore()
        sys.exit()
    args = json.loads(sys.argv[1])
    crfs = json.loads(sys.argv[2]) if len(sys.argv) > 2 else [16, 18, 20, 22, 24]
    for row in sweep(args, crfs):
        print(row['clip'], row['args'][-1], row['bytes'], f"{row['seconds']:.1f}s", f"vmaf={row['vmaf']:.2f}",
              f"neg={row['vmaf_neg']:.2f}", f"ssim={row['ssim']:.4f}")
