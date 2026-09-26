"""x264 switches that change quality per byte without changing the work much: BD-rate on VMAF NEG against Pare's
shipped setting over the corpus (native x264, one thread, CRF 16-24), and CPU time.

    python3 research/tuning_sweep.py [config ...]
"""
import sys
from concurrent.futures import ThreadPoolExecutor

from evaluate import CLIPS, bd_rate
from speed_sweep import CRFS, encode_and_score

SHIPPED = ['--preset', 'faster', '--weightp', '2', '--me', 'dia', '--partitions', 'i8x8,i4x4', '--rc-lookahead', '40']
CONFIGS = {
    'shipped': [],
    'aq-strength 0.8': ['--aq-strength', '0.8'],
    'aq-strength 1.2': ['--aq-strength', '1.2'],
    'aq-mode 2': ['--aq-mode', '2'],
    'deblock -1:-1': ['--deblock', '-1:-1'],
    'deblock 1:1': ['--deblock', '1:1'],
    'psy-rd 1.0:0.15': ['--psy-rd', '1.0:0.15'],
    'psy-rd 0.7:0': ['--psy-rd', '0.7:0'],
    'no psy': ['--no-psy'],
    'qcomp 0.7': ['--qcomp', '0.7'],
    'qcomp 0.5': ['--qcomp', '0.5'],
    'no fast-pskip': ['--no-fast-pskip'],
    'direct auto': ['--direct', 'auto'],
}


def sweep(extra):
    jobs = [(clip, [*SHIPPED, *extra, '--crf', str(crf)]) for clip in CLIPS for crf in CRFS]
    with ThreadPoolExecutor(6) as pool:
        return list(pool.map(lambda j: encode_and_score(*j), jobs))


def main():
    names = sys.argv[1:] or list(CONFIGS)
    base = sweep(CONFIGS['shipped'])
    base_cpu = sum(r['cpu'] for r in base)
    by_clip = lambda rows, c: sorted([r for r in rows if r['clip'] == c], key=lambda r: r['bytes'])
    print(f'{"config":16s} {"CPU":>6s}  BD-rate VMAF NEG per clip ({", ".join(CLIPS)}) and mean', flush=True)
    for name in names:
        rows = sweep(CONFIGS[name])
        bd = [bd_rate(by_clip(base, c), by_clip(rows, c), 'vmaf_neg') for c in CLIPS]
        cpu = sum(r['cpu'] for r in rows) / base_cpu
        print(f'{name:16s} {cpu:6.2f}  ' + ' '.join(f'{b:+6.1f}' for b in bd) + f'  | {sum(bd) / len(bd):+6.1f}%',
              flush=True)


if __name__ == '__main__':
    main()
