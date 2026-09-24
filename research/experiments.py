"""Runs x264 configurations over the corpus and reports BD-rate vs Pare's current setting (veryfast)."""
import json
import sys

from evaluate import CLIPS, bd_rate, sweep

CRFS = [16, 18, 20, 22, 24]
BASELINE = ['--preset', 'veryfast']
CONFIGS = {
    'faster': ['--preset', 'faster'],
    'fast': ['--preset', 'fast'],
    'medium': ['--preset', 'medium'],
    'faster+aq3': ['--preset', 'faster', '--aq-mode', '3'],
    'faster+film': ['--preset', 'faster', '--tune', 'film'],
    'faster+grain': ['--preset', 'faster', '--tune', 'grain'],
    'slow': ['--preset', 'slow'],
    'medium+aq3': ['--preset', 'medium', '--aq-mode', '3'],
    'medium+film': ['--preset', 'medium', '--tune', 'film'],
    # Hybrids: "faster" plus the parts of "medium" that should cost little time.
    'faster+la40': ['--preset', 'faster', '--rc-lookahead', '40'],
    'faster+subme6': ['--preset', 'faster', '--subme', '6'],
    'faster+ref3': ['--preset', 'faster', '--ref', '3'],
    'faster+wp2': ['--preset', 'faster', '--weightp', '2'],
    'faster+aqs0.8': ['--preset', 'faster', '--aq-strength', '0.8'],
    'faster+aqs1.2': ['--preset', 'faster', '--aq-strength', '1.2'],
    'faster+qcomp0.7': ['--preset', 'faster', '--qcomp', '0.7'],
}

# Pre-filters applied before encoding; quality is still measured against the untouched source.
FILTERED = {
    'faster+hqdn3d-light': (['--preset', 'faster'], 'hqdn3d=1:1:2:2'),
    'faster+hqdn3d-med': (['--preset', 'faster'], 'hqdn3d=2:1.5:3:2.25'),
}


def report(name, rows, base):
    by_clip = lambda rs, c: sorted([r for r in rs if r['clip'] == c], key=lambda r: r['bytes'])
    line = [f'{name:14s}']
    for metric in ('vmaf', 'vmaf_neg', 'ssim', 'psnr_y'):
        vals = [bd_rate(by_clip(base, c), by_clip(rows, c), metric) for c in CLIPS]
        line.append(f"{metric}={sum(vals)/len(vals):+6.1f}%")
    print('  '.join(line), '| per-clip vmaf_neg:',
          ' '.join(f"{c}={bd_rate(by_clip(base, c), by_clip(rows, c), 'vmaf_neg'):+.1f}" for c in CLIPS), flush=True)


if __name__ == '__main__':
    names = sys.argv[1:] or list(CONFIGS)
    base = sweep(BASELINE, CRFS)
    for name in names:
        if name in FILTERED:
            args, filters = FILTERED[name]
            report(name, sweep(args, CRFS, filters=filters), base)
        else:
            report(name, sweep(CONFIGS[name], CRFS), base)
