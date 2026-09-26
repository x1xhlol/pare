"""How much quality a smarter split of the bits across chunks could buy, at the same file size.

Pare gives every chunk about the same rate factor. A Netflix-style dynamic optimizer instead measures each chunk's
size and quality at several rate factors and spends the budget where it buys the most: noisy scenes cost many bytes
per VMAF point, calm ones gain little that anyone could see. This encodes the phone-clip test's eight chunks (town,
park, tree, ducks; two 125-frame chunks each, as Pare cuts the 20-second clip for eight encoders) natively with Pare's
x264 settings at rate factors 16-34, scores every frame with VMAF NEG, and compares allocations at equal total size:

  same     one rate factor for every chunk (fractional, interpolated), what Pare does now
  mean     the highest frame-weighted mean VMAF NEG (equal slopes of VMAF against log size)
  worst    the highest VMAF NEG for the worst chunk
  both     the highest mean with no chunk below the "same" allocation's worst plus a margin

    python3 research/allocation.py [budget share of the source's video, default 0.47]
"""
import json, math, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from evaluate import FFMPEG, X264  # noqa: E402

ROOT = os.path.expanduser('~/pare-research')
REF = f'{ROOT}/corpus/ref'
CACHE = f'{ROOT}/bench/allocation.jsonl'
SCENES = ['town', 'park', 'tree', 'ducks']
LENGTH = 125
CRFS = list(range(16, 36, 2))
PARE = ['--preset', 'faster', '--weightp', '2', '--me', 'dia', '--partitions', 'i8x8,i4x4', '--rc-lookahead', '40']
CHUNKS = [(s, start) for s in SCENES for start in (0, LENGTH)]

cache = {}
if os.path.exists(CACHE):
    for line in open(CACHE):
        r = json.loads(line)
        cache[(r['scene'], r['start'], r['crf'])] = r


def run(job):
    scene, start, crf = job
    if job in cache:
        return cache[job]
    ref = f'{REF}/{scene}.y4m'
    with tempfile.TemporaryDirectory() as tmp:
        out = f'{tmp}/c.264'
        subprocess.run([X264['asm'], '--threads', '2', '--quiet', *PARE, '--crf', str(crf), '--seek', str(start),
                        '--frames', str(LENGTH), '-o', out, ref], check=True, capture_output=True)
        log = f'{tmp}/vmaf.json'
        lavfi = (f"[0:v]settb=1,setpts=N[d];[1:v]trim=start_frame={start}:end_frame={start + LENGTH},settb=1,setpts=N[r];"
                 f"[d][r]libvmaf=model='version=vmaf_v0.6.1neg\\:name=neg':n_threads=2:log_fmt=json:log_path={log}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-f', 'h264', '-i', out, '-i', ref, '-lavfi', lavfi, '-f', 'null', '-'],
                       check=True)
        frames = [f['metrics']['neg'] for f in json.load(open(log))['frames']]
        row = {'scene': scene, 'start': start, 'crf': crf, 'bytes': os.path.getsize(out), 'frames': frames}
    with open(CACHE, 'a') as f:
        f.write(json.dumps(row) + '\n')
    cache[job] = row
    return row


def curve(scene, start):
    """(crf, bytes, mean VMAF NEG, per-frame scores) for one chunk, by rate factor."""
    return [(c, cache[(scene, start, c)]['bytes'], sum(cache[(scene, start, c)]['frames']) / LENGTH,
             cache[(scene, start, c)]['frames']) for c in CRFS]


def at(points, crf):
    """Bytes and mean VMAF at a fractional rate factor: log bytes and VMAF linear between tests."""
    for (c0, b0, v0, _), (c1, b1, v1, _) in zip(points, points[1:]):
        if c0 <= crf <= c1:
            t = (crf - c0) / (c1 - c0)
            return b0 * (b1 / b0) ** t, v0 + t * (v1 - v0)
    raise ValueError(crf)


def frames_at(points, crf):
    """Per-frame scores at a rate factor: the nearer test's (for the worst-frame figure)."""
    return min(points, key=lambda p: abs(p[0] - crf))[3]


def allocate(curves, budget, objective, floor=None):
    """Rate factors per chunk, on a 0.1 grid, maximising the objective within the budget (greedy on marginal gain)."""
    grid = [round(CRFS[0] + 0.1 * i, 1) for i in range(int((CRFS[-1] - CRFS[0]) * 10) + 1)]
    crfs = [CRFS[-1]] * len(curves)
    def total(cs):
        return sum(at(p, c)[0] for p, c in zip(curves, cs))
    # Worst-chunk objective: raise the lowest chunk while the budget allows.
    while True:
        best, gain = None, 0
        for i, p in enumerate(curves):
            if crfs[i] <= CRFS[0]:
                continue
            trial = crfs[:]
            trial[i] = round(crfs[i] - 0.1, 1)
            extra = total(trial) - total(crfs)
            if total(trial) > budget:
                continue
            v_old, v_new = at(p, crfs[i])[1], at(p, trial[i])[1]
            if objective == 'worst':
                vs = [at(q, c)[1] for q, c in zip(curves, crfs)]
                score = 1e9 if i == vs.index(min(vs)) else -1
            else:
                below = floor is not None and v_old < floor
                score = (1e9 if below else 0) + (v_new - v_old) / max(extra, 1)
            if score > gain:
                best, gain = i, score
        if best is None:
            break
        crfs[best] = round(crfs[best] - 0.1, 1)
    return crfs


def report(curves, crfs, label):
    size = sum(at(p, c)[0] for p, c in zip(curves, crfs))
    means = [at(p, c)[1] for p, c in zip(curves, crfs)]
    frames = [v for p, c in zip(curves, crfs) for v in frames_at(p, c)]
    frames.sort()
    print(f"{label:6s} {size / 1e6:6.2f} MB  mean {sum(means) / len(means):6.2f}  worst chunk {min(means):6.2f}  "
          f"worst 1% of frames {frames[len(frames) // 100]:6.2f}  rate factors {' '.join(f'{c:4.1f}' for c in crfs)}")


def main():
    share = float(sys.argv[1]) if len(sys.argv) > 1 else 0.47
    jobs = [(s, st, c) for s, st in CHUNKS for c in CRFS]
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(run, jobs))
    curves = [curve(s, st) for s, st in CHUNKS]
    source = os.path.getsize(f'{ROOT}/corpus/mix.mp4')
    budget = share * source
    same_crf = next(c / 10 for c in range(CRFS[0] * 10, CRFS[-1] * 10 + 1)
                    if sum(at(p, c / 10)[0] for p in curves) <= budget)
    same = [same_crf] * len(curves)
    print(f"budget {budget / 1e6:.2f} MB ({share:.0%} of mix.mp4); chunks {', '.join(f'{s}@{st}' for s, st in CHUNKS)}")
    report(curves, same, 'same')
    report(curves, allocate(curves, budget, 'mean'), 'mean')
    report(curves, allocate(curves, budget, 'worst'), 'worst')
    worst_same = min(at(p, c)[1] for p, c in zip(curves, same))
    report(curves, allocate(curves, budget, 'mean', floor=worst_same + 3), 'both')


if __name__ == '__main__':
    main()
