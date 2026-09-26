"""Looks for SVT-AV1 switches that save time at preset 8 for nearly the same quality per byte, like speed_sweep.py
does for x264. Native SvtAv1EncApp on one thread over the corpus at CRF 22-40, VMAF NEG against the source, BD-rate
against plain preset 8, and CPU seconds per encode.

    python3 research/av1_sweep.py [config ...]
"""
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.expanduser('~/pare-research/av1'))
from svt_eval import svt  # noqa: E402
from evaluate import bd_rate  # noqa: E402

CLIPS = ['town', 'park', 'tree', 'ducks', 'bbb', 'screen']
CRFS = [22, 28, 34, 40]
CONFIGS = {
    'preset 8': [],
    'no restoration': ['--enable-restoration', '0'],
    'fast-decode 1': ['--fast-decode', '1'],
    'no mfmv': ['--enable-mfmv', '0'],
    'no dynamic gop': ['--enable-dg', '0'],
    'no keyframe tf': ['--enable-kf-tf', '0'],
    '4 hierarchy levels': ['--hierarchical-levels', '4'],
    'fast-decode 2': ['--fast-decode', '2'],
    'fast-decode 1, no mfmv': ['--fast-decode', '1', '--enable-mfmv', '0'],
    # Switches that change quality per byte rather than speed.
    'quant matrices': ['--enable-qm', '1'],
    'quant matrices 0-15': ['--enable-qm', '1', '--qm-min', '0'],
    'sharpness 1': ['--sharpness', '1'],
    'sharpness -1': ['--sharpness', '-1'],
    'ac-bias 1': ['--ac-bias', '1.0'],
    'qp-scale compress 1': ['--qp-scale-compress-strength', '1'],
    'tune SSIM': ['--tune', '2'],
}


def sweep(extra):
    jobs = [(c, 8, q, tuple(extra)) for c in CLIPS for q in CRFS]
    with ThreadPoolExecutor(5) as pool:
        return list(pool.map(lambda j: svt(*j), jobs))


def main():
    names = sys.argv[1:] or list(CONFIGS)
    base = sweep(CONFIGS['preset 8'])
    base_cpu = sum(r['cpu'] for r in base)
    by_clip = lambda rows, c: sorted([r for r in rows if r['clip'] == c], key=lambda r: r['bytes'])
    print(f'{"config":20s} {"CPU":>6s}  BD-rate VMAF NEG per clip ({", ".join(CLIPS)}) and mean', flush=True)
    for name in names:
        rows = sweep(CONFIGS[name])
        bd = [bd_rate(by_clip(base, c), by_clip(rows, c), 'vmaf_neg') for c in CLIPS]
        cpu = sum(r['cpu'] for r in rows) / base_cpu
        print(f'{name:20s} {cpu:6.2f}  ' + ' '.join(f'{b:+6.1f}' for b in bd) + f'  | {sum(bd) / len(bd):+6.1f}%',
              flush=True)


if __name__ == '__main__':
    main()
