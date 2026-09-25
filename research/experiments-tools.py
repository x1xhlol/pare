"""Which of medium's tools are worth adding to Pare's shipped x264 setting? BD-rate and native encode time of each,
added one at a time, against the shipped setting on the whole corpus."""
import sys

from evaluate import CLIPS, bd_rate, sweep

CRFS = [16, 18, 20, 22, 24]
SHIPPED = ['--preset', 'faster', '--rc-lookahead', '40', '--ref', '3', '--weightp', '2']
CONFIGS = {
    'subme5': ['--subme', '5'],
    'subme6': ['--subme', '6'],
    'subme7': ['--subme', '7'],
    'mixed-refs': ['--mixed-refs'],
    'partitions-all': ['--partitions', 'all'],
    'me-umh': ['--me', 'umh'],
    'b-adapt2': ['--b-adapt', '2'],
}


def seconds(rows):
    return sum(r['seconds'] for r in rows)


if __name__ == '__main__':
    base = sweep(SHIPPED, CRFS)
    by_clip = lambda rs, c: [r for r in rs if r['clip'] == c]
    for name in sys.argv[1:] or list(CONFIGS):
        rows = sweep([*SHIPPED, *CONFIGS[name]], CRFS)
        neg = [bd_rate(by_clip(base, c), by_clip(rows, c), 'vmaf_neg') for c in CLIPS]
        ssim = [bd_rate(by_clip(base, c), by_clip(rows, c), 'ssim') for c in CLIPS]
        print(f"{name:15s} vmaf_neg={sum(neg)/len(neg):+5.1f}%  ssim={sum(ssim)/len(ssim):+5.1f}%  "
              f"time x{seconds(rows)/seconds(base):.2f} | " + ' '.join(f'{c}={v:+.1f}' for c, v in zip(CLIPS, neg)),
              flush=True)
