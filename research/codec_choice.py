"""Can the size plan's test windows tell which codec will look better at the target size?

For each corpus clip this encodes the plan's four 24-frame windows with x264 (Pare's settings, CRF 15 and 25) and
SVT-AV1 (CRF 16 and 40), predicts each codec's whole-clip size the way the plan does, and predicts its mean luma PSNR
and VMAF NEG at a target size from the windows. The choice (AV1 when its prediction beats x264's by a threshold) is
scored against VMAF NEG of whole-clip encodes at the same size (x264 from results.jsonl, AV1 at preset 8 from the
SVT-AV1 sweep), at the sizes x264 reaches at CRF 16 to 24.

    python3 research/codec_choice.py                  # all 24 frames scored, AV1 windows at the plan's preset 10
    RUN=2 AV1_PRESET=8 python3 research/codec_choice.py   # what Pare ships: 2 frames per window, preset 8

Results go to codec_choice[-runN][-pP].jsonl.
"""
import concurrent.futures as cf
import json
import math
import os
import re
import subprocess
import tempfile
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('PARE_RESEARCH', os.path.expanduser('~/pare-research'))
X264 = f'{ROOT}/build-asm/x264'
SVT = os.environ.get('SVT', f'{ROOT}/svt-av1/Bin/Release/SvtAv1EncApp')
FFMPEG = os.environ.get('FFMPEG', f'{ROOT}/ffmpeg-master-latest-linux64-gpl/bin/ffmpeg')
AV1_RESULTS = os.environ.get('AV1_RESULTS', f'{ROOT}/av1/results.jsonl')
CLIPS = ['bbb', 'ducks', 'park', 'screen', 'town', 'tree']
WINDOWS, FRAMES = 4, 24
# VMAF on RUN consecutive frames from the middle of each window instead of all of them, after one more frame that
# only primes VMAF's motion feature. Sampling every 8th frame instead lands on the top layers of SVT-AV1's
# hierarchical mini-GOP, its best frames, and flatters it.
RUN = int(os.environ.get('RUN', '0'))
X264_OPTS = ['--preset', 'faster', '--ref', '3', '--weightp', '2', '--rc-lookahead', '40']
X264_CRFS, AV1_CRFS = (15, 25), (16, 40)
# The plan encodes AV1 at preset 10; the real encode runs preset 8.
AV1_PRESET = os.environ.get('AV1_PRESET', '10')


def frame_count(path):
    with open(path, 'rb') as f:
        header = f.read(200).split(b'\n')[0].decode()
    w, h = int(re.search(r' W(\d+)', header).group(1)), int(re.search(r' H(\d+)', header).group(1))
    return (os.path.getsize(path) - len(header) - 1) // (w * h * 3 // 2 + 6)


def window_starts(n):
    return [max(0, min(n - FRAMES, round((i + 0.5) / WINDOWS * n - FRAMES / 2))) for i in range(WINDOWS)]


def vmaf_neg(out, clip, start):
    """Mean VMAF NEG of a window's encode against the same source frames (RUN of them, if set)."""
    first, last = (FRAMES // 3, FRAMES // 3 + RUN + 1) if RUN else (0, FRAMES)
    with tempfile.NamedTemporaryFile(suffix='.json') as log:
        graph = (f"[0:v]trim=start_frame={first}:end_frame={last},settb=1,setpts=N[d];"
                 f"[1:v]trim=start_frame={start + first}:end_frame={start + last},settb=1,setpts=N[r];"
                 f"[d][r]libvmaf=model='version=vmaf_v0.6.1neg':n_threads=1:log_fmt=json:log_path={log.name}")
        subprocess.run([FFMPEG, '-loglevel', 'error', '-i', out, '-i', f'{ROOT}/corpus/ref/{clip}.y4m', '-lavfi', graph,
                        '-f', 'null', '-'], check=True)
        frames = [f['metrics']['vmaf'] for f in json.load(open(log.name))['frames']]
        scored = frames[1:] if RUN else frames
        return sum(scored) / len(scored)


def encode_x264(clip, start, crf):
    with tempfile.NamedTemporaryFile(suffix='.264') as out:
        log = subprocess.run([X264, '--threads', '1', *X264_OPTS, '--crf', str(crf), '--psnr', '--seek', str(start),
                              '--frames', str(FRAMES), '-o', out.name, f'{ROOT}/corpus/ref/{clip}.y4m'],
                             capture_output=True, text=True, check=True).stderr
        size = os.path.getsize(out.name)
        vmaf = vmaf_neg(out.name, clip, start)
    key = re.search(r'frame I:(\d+)\s+Avg QP:\s*\S+\s+size:\s*(\d+)', log)
    psnr = float(re.search(r'PSNR Mean Y:([\d.]+)', log.split('frame B')[-1]).group(1))
    return {'bytes': size, 'key': int(key.group(2)), 'keys': int(key.group(1)), 'psnr': psnr, 'vmaf': vmaf}


def encode_av1(clip, start, crf):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([SVT, '-i', f'{ROOT}/corpus/ref/{clip}.y4m', '--skip', str(start), '-n', str(FRAMES),
                        '--preset', AV1_PRESET, '--crf', str(crf), '--lp', '1', '--enable-stat-report', '1',
                        '--stat-file', f'{tmp}/stat.txt', '-b', f'{tmp}/out.ivf'],
                       capture_output=True, check=True)
        size = os.path.getsize(f'{tmp}/out.ivf') - 32 - 12 * FRAMES
        stat = open(f'{tmp}/stat.txt').read()
        vmaf = vmaf_neg(f'{tmp}/out.ivf', clip, start)
    pictures = re.findall(r'Picture Number:\s*(\d+).*?PSNR-Y: ([\d.]+) dB.*?\]\s+(\d+) bytes', stat)
    key = next(int(b) for n, _, b in pictures if n == '0')
    psnr = sum(float(p) for _, p, _ in pictures) / len(pictures)
    return {'bytes': size, 'key': key, 'keys': 1, 'psnr': psnr, 'vmaf': vmaf}


def windows(pool, clip, n):
    """Both codecs at both test rate factors over the plan's windows: futures keyed by (codec, crf)."""
    jobs = {}
    for codec, crfs, fn in (('x264', X264_CRFS, encode_x264), ('av1', AV1_CRFS, encode_av1)):
        for crf in crfs:
            jobs[(codec, crf)] = [pool.submit(fn, clip, s, crf) for s in window_starts(n)]
    return jobs


def predict(results, n):
    """Whole-clip size the way the plan estimates it (keyframes priced apart), and mean PSNR and VMAF NEG over the
    windows."""
    keys = sum(r['key'] for r in results)
    rest = sum(r['bytes'] - r['key'] for r in results)
    per_key, per_frame = keys / len(results), rest / (len(results) * (FRAMES - 1))
    keyframes = 1 + n // 250
    mean = lambda k: sum(r[k] for r in results) / len(results)
    return per_key * keyframes + per_frame * (n - keyframes), mean('psnr'), mean('vmaf')


def metric_at(points, size, k):
    """Metric `k` (1 PSNR, 2 VMAF NEG) at `size`, linear in log size through the two test points (extrapolated)."""
    lo, hi = sorted(points)
    return lo[k] + (math.log(size) - math.log(lo[0])) / (math.log(hi[0]) - math.log(lo[0])) * (hi[k] - lo[k])


def truth():
    """VMAF NEG against size for whole-clip encodes: x264 with Pare's settings, AV1 at preset 8."""
    x, a = defaultdict(list), defaultdict(list)
    for line in open(f'{HERE}/results.jsonl'):
        r = json.loads(line)
        args = r['args']
        if r.get('filters') is None and args[:2] == ['--preset', 'faster'] and all(o in args for o in X264_OPTS[2:]):
            x[r['clip']].append((r['bytes'], r['vmaf_neg'], float(args[args.index('--crf') + 1])))
    for line in open(AV1_RESULTS):
        r = json.loads(line)
        if r['args'][:2] == ['--preset', '8'] and len(r['args']) == 6:
            a[r['clip']].append((r['bytes'], r['vmaf_neg'], float(r['args'][3])))
    return x, a


def vmaf_at(points, size):
    pts = sorted(points)
    for p, q in zip(pts, pts[1:]):
        if p[0] <= size <= q[0]:
            t = (math.log(size) - math.log(p[0])) / (math.log(q[0]) - math.log(p[0]))
            return p[1] + t * (q[1] - p[1])
    return None


def main():
    xt, at = truth()
    cases = []
    with cf.ThreadPoolExecutor(os.cpu_count()) as pool:
        pending = {clip: (frame_count(f'{ROOT}/corpus/ref/{clip}.y4m'), None) for clip in CLIPS}
        pending = {clip: (n, windows(pool, clip, n)) for clip, (n, _) in pending.items()}
        for clip, (n, jobs) in pending.items():
            points = {codec: [predict([f.result() for f in jobs[(codec, crf)]], n) for crf in crfs]
                      for codec, crfs in (('x264', X264_CRFS), ('av1', AV1_CRFS))}
            for size, _, crf in sorted(xt[clip], key=lambda p: p[2]):
                vx, va = vmaf_at(xt[clip], size), vmaf_at(at[clip], size)
                if vx is None or va is None:
                    continue
                cases.append({'clip': clip, 'x264_crf': crf, 'bytes': size, 'vmaf_neg': {'x264': vx, 'av1': va},
                              'psnr_predicted': {c: metric_at(points[c], size, 1) for c in points},
                              'vmaf_neg_predicted': {c: metric_at(points[c], size, 2) for c in points},
                              'windows': {c: [list(p) for p in points[c]] for c in points}})
    with open(f'{HERE}/codec_choice{f"-run{RUN}" if RUN else ""}{"" if AV1_PRESET == "10" else f"-p{AV1_PRESET}"}.jsonl', 'w') as f:
        for c in cases:
            f.write(json.dumps(c) + '\n')

    diff = lambda c, k: c[k]['av1'] - c[k]['x264']
    print(f'{"clip":8} {"x264 crf":>8} {"VMAF NEG, AV1 - x264":>21} {"predicted: PSNR":>16} {"VMAF NEG":>9}')
    for c in cases:
        print(f'{c["clip"]:8} {c["x264_crf"]:8.0f} {diff(c, "vmaf_neg"):+21.2f} {diff(c, "psnr_predicted"):+16.2f} '
              f'{diff(c, "vmaf_neg_predicted"):+9.2f}')
    for signal, thresholds in (('psnr_predicted', (-1.0, -0.75, -0.5, -0.25, 0.0, 0.25)),
                               ('vmaf_neg_predicted', (-1.0, -0.5, -0.25, 0.0, 0.25, 0.5, 1.0))):
        choose(cases, signal, thresholds)
    for name, pick in (('always x264', 'x264'), ('always AV1', 'av1')):
        lost = [max(c['vmaf_neg'].values()) - c['vmaf_neg'][pick] for c in cases]
        print(f'{name:>11}  {sum(l == 0 for l in lost):2}/{len(cases)}  {sum(lost) / len(lost):18.2f} {max(lost):8.2f}')


def choose(cases, signal, thresholds):
    print(f'\nAV1 when {signal} (AV1 - x264) is above the threshold')
    print('threshold  right  VMAF NEG lost to the better codec (mean, worst)   AV1 picked')
    for threshold in thresholds:
        right, lost, picked = 0, [], 0
        for c in cases:
            av1 = c[signal]['av1'] - c[signal]['x264'] > threshold
            got = c['vmaf_neg']['av1' if av1 else 'x264']
            best = max(c['vmaf_neg'].values())
            right += got == best
            lost.append(best - got)
            picked += av1
        print(f'{threshold:+9.2f}  {right:2}/{len(cases)}  {sum(lost) / len(lost):20.2f} {max(lost):8.2f}  {picked:18}')


if __name__ == '__main__':
    main()
