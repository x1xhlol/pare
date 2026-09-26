"""Turns scored benchmark runs (research/score.py output) into the Markdown tables in BENCHMARKS.md: one row per video
with the previous build's time and quality next to the current one's.

    python3 research/report.py scored.jsonl [old-tag new-tag]
"""
import json
import os
import sys

NAMES = {
    'gopro.mp4': 'Camera footage, 1080p30, 10 s',
    'screen.mp4': 'Screen recording, 1080p30, 8 s',
    'bbb30.mp4': 'Big Buck Bunny, 1080p30, 10 s',
    'phone_pcm.mov': 'Phone clip with PCM audio, 1080p25, 20 s',
    'mix.mp4': 'Phone clips, 1080p50, 20 s',
    'town.mp4': 'town, 25 Mbps re-encode, 1080p50, 5 s',
    'tree.mp4': 'tree, same, 5 s',
    'noisy.mp4': 'noisy, same, 5 s',
    'jelly.mp4': 'Jellyfish, already 4.2 Mbps, 1080p30, 10 s',
    'park.mp4': 'park, 25 Mbps re-encode, 5 s',
    'ducks.mp4': 'ducks (rippling water), same, 5 s',
    'long.mp4': 'Phone clips, 1080p50, 2 min',
    'hdr-hlg.mp4': 'HDR test clip (HLG), 10-bit, 1080p30, 5 s',
    'hdr-pq.mp4': 'HDR test clip (PQ), 10-bit, 1080p30, 5 s',
}


def main():
    rows = [json.loads(line) for line in open(sys.argv[1])]
    old_tag, new_tag = sys.argv[2:4] if len(sys.argv) > 3 else ('final-old', 'final-new')
    by = {(r['tag'], os.path.basename(r['source'])): r for r in rows}
    clips = [c for c in NAMES if (new_tag, c) in by]
    print('| Video | Original | Now: size | Format | Time, before → now | VMAF NEG, before → now | Worst frame, now |')
    print('| --- | --- | --- | --- | --- | --- | --- |')
    totals = {'old': 0.0, 'new': 0.0, 'duration': 0.0}
    for c in clips:
        new, old = by[(new_tag, c)], by.get((old_tag, c))
        fmt = new['kicker'].split('·')[-1].strip() if '·' in new['kicker'] else ''
        time = f"{old['seconds']:.1f} → {new['seconds']:.1f} s" if old else f"{new['seconds']:.1f} s"
        vmaf = f"{old['vmaf_neg']:.1f} → {new['vmaf_neg']:.1f}" if old else f"{new['vmaf_neg']:.1f}"
        print(f"| {NAMES[c]} | {new['original'] / 1e6:.1f} MB | {new['bytes'] / 1e6:.2f} MB ({-100 * new['reduction']:.0f}%) | "
              f"{fmt} | {time} | {vmaf} | {new['vmaf_neg_min']:.1f} |")
        if old:
            totals['old'] += old['seconds']
            totals['new'] += new['seconds']
            totals['duration'] += new['duration']
    if totals['old']:
        change = 100 * (1 - totals['new'] / totals['old'])
        print(f"\nAll videos together: {totals['old']:.0f} s before, {totals['new']:.0f} s now "
              f"({abs(change):.0f}% {'less' if change >= 0 else 'more'}), for {totals['duration']:.0f} s of video.")


if __name__ == '__main__':
    main()
