"""Native encodes of a corpus clip matched to a target video-stream size, scored like research/score.py: how Pare's
output compares with the same encoder run natively and with slower ones, at the same size.

python3 research/native_gap.py CLIP TARGET_VIDEO_BYTES PARE_VMAF_NEG CONFIG [CONFIG ...] >> results.jsonl

TARGET_VIDEO_BYTES is the video stream of Pare's output (ffprobe), PARE_VMAF_NEG its score from research/score.py.
CONFIG: x264pare | x264superfast | x264veryslow | x265slow | av1p8 | av1p4 | ffdefault
Each config: one encode at the target size (2-pass for x264/x265, CRF search for SVT-AV1), scored; then more encodes
at other sizes until Pare's VMAF NEG is bracketed, to estimate the size the encoder needs for Pare's quality.
"""
import json, math, os, resource, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import score as vmaf_score, FFMPEG, FFPROBE  # noqa: E402

WORK = os.environ.get('WORK', '/tmp/native-gap')
os.makedirs(WORK, exist_ok=True)


def vbytes(path):
    out = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size',
                          '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout
    return sum(int(x) for x in out.split() if x.strip())


def probe(path):
    out = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries',
                          'stream=nb_read_packets,r_frame_rate,width,height', '-of', 'json', path],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    return int(s['nb_read_packets']), int(n) / int(d), s['width'], s['height']


def run(cmd):
    """Runs a command; returns (wall seconds, child CPU seconds)."""
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode:
        sys.stderr.write(p.stderr[-3000:])
        raise RuntimeError('command failed: ' + ' '.join(cmd))
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    return time.time() - t0, (r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)


BASE = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y']

X264 = {
    # Pare's x264 options (src/lib/x264.ts): faster + weightp=2, me=dia, partitions=i8x8,i4x4, rc-lookahead=40 at 1080p
    'x264pare': ['-c:v', 'libx264', '-preset', 'faster',
                 '-x264-params', 'weightp=2:me=dia:partitions=i8x8,i4x4:rc-lookahead=40'],
    # Pare's superfast path: the preset with Pare's additions dropped
    'x264superfast': ['-c:v', 'libx264', '-preset', 'superfast'],
    'x264veryslow': ['-c:v', 'libx264', '-preset', 'veryslow'],
}


class Clip:
    def __init__(self, src):
        self.src = src
        self.name = os.path.splitext(os.path.basename(src))[0]
        self.frames, self.fps, self.w, self.h = probe(src)
        self.duration = self.frames / self.fps


def two_pass(clip, cfg, kbps, tag, stats):
    out = f'{WORK}/{clip.name}-{cfg}-{tag}.mp4'
    wall = cpu = 0.0
    if cfg.startswith('x264'):
        common = BASE + ['-i', clip.src, '-an', *X264[cfg], '-b:v', f'{kbps}k', '-passlogfile', stats]
        if not os.path.exists(stats + '-0.log'):
            w, c = run(common + ['-pass', '1', '-f', 'null', '/dev/null'])
            wall += w; cpu += c
        w, c = run(common + ['-pass', '2', out])
    else:  # x265 slow
        def cmd(p):
            return BASE + ['-i', clip.src, '-an', '-c:v', 'libx265', '-preset', 'slow', '-b:v', f'{kbps}k',
                           '-x265-params', f'pass={p}:stats={stats}.log:log-level=error']
        if not os.path.exists(stats + '.log'):
            w, c = run(cmd(1) + ['-f', 'null', '/dev/null'])
            wall += w; cpu += c
        w, c = run(cmd(2) + [out])
    return out, wall + w, cpu + c


def encode_at_size(clip, cfg, target, tag, tol=0.02):
    """2-pass to the target video size, retrying pass 2 with a corrected bitrate. Returns the encode record."""
    stats = f'{WORK}/{clip.name}-{cfg}-stats'
    kbps = target * 8 / clip.duration / 1000
    tries = []
    for _ in range(4):
        out, wall, cpu = two_pass(clip, cfg, round(kbps, 1), tag, stats)
        size = vbytes(out)
        tries.append({'kbps': round(kbps, 1), 'bytes': size, 'wall': wall, 'cpu': cpu})
        if abs(size / target - 1) <= tol:
            break
        kbps *= target / size
    return {'path': out, 'bytes': size, 'kbps_asked': round(kbps, 1), 'tries': tries,
            'wall': sum(t['wall'] for t in tries), 'cpu': sum(t['cpu'] for t in tries)}


def av1_encode(clip, preset, crf, tag):
    out = f'{WORK}/{clip.name}-av1p{preset}-{tag}.mp4'
    wall, cpu = run(BASE + ['-i', clip.src, '-an', '-c:v', 'libsvtav1', '-preset', str(preset), '-pix_fmt', 'yuv420p',
                            '-svtav1-params', f'crf={crf:.2f}:enable-qm=1:keyint=10s', out])
    return out, vbytes(out), wall, cpu


def q(crf):
    return max(1.0, min(63.0, round(crf * 4) / 4))


def av1_search(clip, preset, target, start, tag, tol=0.02, keep_near=None):
    """CRF search (quarter steps, as SVT-AV1 maps CRF to qindex) for the target size."""
    pts = []  # (crf, bytes, path, wall, cpu)
    crf = q(start)
    slope = math.log(1 - 0.075)
    for _ in range(7):
        if any(p[0] == crf for p in pts):
            break
        path, size, wall, cpu = av1_encode(clip, preset, crf, f'{tag}-crf{crf:.2f}')
        pts.append((crf, size, path, wall, cpu))
        if abs(size / target - 1) <= tol:
            break
        if len(pts) >= 2:
            a, b = sorted(pts, key=lambda p: abs(math.log(p[1] / target)))[:2]
            if a[0] != b[0] and a[1] != b[1]:
                slope = (math.log(a[1]) - math.log(b[1])) / (a[0] - b[0])
        crf = q(crf + math.log(target / size) / slope)
    best = min(pts, key=lambda p: abs(math.log(p[1] / target)))
    for p in pts:
        if p is not best:
            os.remove(p[2])
    return {'path': best[2], 'bytes': best[1], 'crf': best[0], 'wall': sum(p[3] for p in pts),
            'cpu': sum(p[4] for p in pts), 'search': [(p[0], p[1]) for p in pts], 'slope': slope}


def scored(clip, rec):
    m = vmaf_score(rec['path'], clip.src)
    os.remove(rec['path'])
    rec = {k: v for k, v in rec.items() if k != 'path'}
    return {**rec, **m}


def equal_quality_bytes(points, v):
    """Log-linear interpolation of size against VMAF NEG between the two points around v (or the two nearest)."""
    pts = sorted(points, key=lambda p: p['vmaf_neg'])
    lo = [p for p in pts if p['vmaf_neg'] <= v]
    hi = [p for p in pts if p['vmaf_neg'] >= v]
    if lo and hi:
        a, b, kind = lo[-1], hi[0], 'interpolated'
    else:
        a, b = (pts[:2] if not lo else pts[-2:])
        kind = 'extrapolated'
    if a['vmaf_neg'] == b['vmaf_neg']:
        return a['bytes'], kind
    t = (v - a['vmaf_neg']) / (b['vmaf_neg'] - a['vmaf_neg'])
    return math.exp(math.log(a['bytes']) + t * (math.log(b['bytes']) - math.log(a['bytes']))), kind


def main():
    src, target, pare_v = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    configs = sys.argv[4:]
    clip = Clip(src)
    av1_start = {'av1p8': float(os.environ.get('CRF8', 30)), 'av1p4': float(os.environ.get('CRF4', 30))}
    for cfg in configs:
        if cfg == 'ffdefault':
            out = f'{WORK}/{clip.name}-ffdefault.mp4'
            wall, cpu = run(BASE + ['-i', src, out])  # ffmpeg's own defaults: libx264 medium CRF 23 (+AAC if audio)
            rec = {'path': out, 'bytes': vbytes(out), 'file_bytes': os.path.getsize(out), 'wall': wall, 'cpu': cpu}
            print(json.dumps({'clip': clip.name, 'config': cfg, 'point': 'default', 'original': os.path.getsize(src),
                              **scored(clip, rec)}), flush=True)
            continue
        points = []
        # 1. the target size
        if cfg.startswith('av1'):
            preset = int(cfg[4:])
            rec = av1_search(clip, preset, target, av1_start[cfg], 'target')
            if cfg == 'av1p8':
                av1_start['av1p4'] = rec['crf']
        else:
            rec = encode_at_size(clip, cfg, target, 'target')
        r = scored(clip, rec)
        r.update(clip=clip.name, config=cfg, point='target', target=target, off=r['bytes'] / target - 1)
        print(json.dumps(r), flush=True)
        points.append(r)
        # 2. more sizes until Pare's VMAF NEG is bracketed (at most 2 more), for the equal-quality size
        for i in range(2):
            vs = [p['vmaf_neg'] for p in points]
            if min(vs) <= pare_v <= max(vs) and len(points) >= 2:
                break
            if len(points) >= 2:
                est, _ = equal_quality_bytes(points, pare_v)
                sizes = [p['bytes'] for p in points]
                # the slow reference encoders get a third point only when the extrapolation would be long
                if cfg in ('x264veryslow', 'x265slow') and min(sizes) / 1.25 <= est <= max(sizes) * 1.25:
                    break
                ratio = est / points[0]['bytes']
                ratio = ratio * (0.93 if ratio < 1 else 1.07)  # aim a little past it so it gets bracketed
            else:
                gap = r['vmaf_neg'] - pare_v  # ~6 VMAF NEG points per doubling near 90
                ratio = 2 ** (-gap / 6) * (0.93 if gap > 0 else 1.07)
            ratio = max(0.35, min(2.5, ratio))
            want = points[0]['bytes'] * ratio
            if cfg.startswith('av1'):
                crf = q(points[0]['crf'] + math.log(ratio) / rec['slope'])
                if any(p.get('crf') == crf for p in points):
                    crf = q(crf + (0.25 if ratio > 1 else -0.25) * -1)
                path, size, wall, cpu = av1_encode(clip, preset, crf, f'pt{i}')
                rec2 = {'path': path, 'bytes': size, 'crf': crf, 'wall': wall, 'cpu': cpu}
            else:
                rec2 = encode_at_size(clip, cfg, want, f'pt{i}', tol=0.08)
            r2 = scored(clip, rec2)
            r2.update(clip=clip.name, config=cfg, point=f'extra{i}', ratio_asked=ratio)
            print(json.dumps(r2), flush=True)
            points.append(r2)
        eq, kind = equal_quality_bytes(points, pare_v)
        print(json.dumps({'clip': clip.name, 'config': cfg, 'point': 'equal_quality', 'pare_vmaf_neg': pare_v,
                          'target': target, 'bytes_for_pare_quality': eq, 'ratio_to_pare': eq / target,
                          'kind': kind, 'n_points': len(points)}), flush=True)
        for f in os.listdir(WORK):
            if 'stats' in f and f.startswith(f'{clip.name}-{cfg}'):
                os.remove(f'{WORK}/{f}')


if __name__ == '__main__':
    main()
