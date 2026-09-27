"""Checks a trimmed copy against its source: first frame, frame count and audio sync.

    python3 research/trimcheck.py source output start end

`start` and `end` are the part in the source's seconds (end exclusive). The source is a test clip with a moving picture
(every frame differs) and a 50 ms beep each second, for example:

    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=12 -f lavfi -i sine=frequency=1000:duration=12 \
      -filter_complex "[1:a]volume='if(lt(mod(t,1),0.05),1,0)':eval=frame[a]" -map 0:v -map "[a]" \
      -c:v libx264 -g 60 -keyint_min 60 -sc_threshold 0 -bf 2 -c:a aac sync_aac.mp4
"""
import json
import os
import subprocess
import sys

import numpy as np

FF = os.environ.get('FFMPEG', 'ffmpeg')
FP = os.path.join(os.path.dirname(FF), 'ffprobe') if os.path.dirname(FF) else 'ffprobe'
src, out, T, E = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
W, H = 160, 90


def probe(path):
    info = json.loads(subprocess.run([FP, '-v', 'error', '-count_frames', '-show_entries',
                                      'stream=codec_type,codec_name,start_time,duration,nb_read_frames:format=duration',
                                      '-of', 'json', path], capture_output=True, text=True).stdout)
    return info


def frames(path, skip=0.0, count=30):
    args = [FF, '-loglevel', 'error']
    if skip:
        args += ['-ss', str(skip)]
    args += ['-i', path, '-frames:v', str(count), '-vf', f'scale={W}:{H}', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']
    raw = subprocess.run(args, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float64)


def audio(path):
    raw = subprocess.run([FF, '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
                         capture_output=True).stdout
    return np.frombuffer(raw, np.float32)


def onsets(pcm, rate=48000):
    env = np.abs(pcm) > 0.1
    starts = []
    i = 0
    while i < len(env):
        if env[i]:
            starts.append(i / rate)
            i += int(0.5 * rate)
        else:
            i += 1
    return starts


info = probe(out)
report = {'streams': [{k: s.get(k) for k in ('codec_type', 'codec_name', 'start_time', 'duration', 'nb_read_frames')}
                      for s in info['streams']], 'format_duration': float(info['format']['duration'])}

# Source frames from T - 2 frames on (accurate seek decodes from the keyframe before), output frames from its start.
fps = 30
a = frames(src, 0, int((T + 1.2) * fps) + 5)
b = frames(out, 0, 30)
first = int(round(T * fps))
best = {}
for shift in range(-2, 3):
    ps = []
    for i in range(min(20, len(b))):
        j = first + shift + i
        if 0 <= j < len(a):
            mse = np.mean((a[j] - b[i]) ** 2)
            ps.append(99 if mse == 0 else 10 * np.log10(255 ** 2 / mse))
    best[shift] = round(float(np.mean(ps)), 2) if ps else None
report['psnr_by_frame_shift'] = best
report['aligned'] = max(best, key=lambda k: best[k] or 0) == 0

expected_frames = int(round((E - T) * fps))
vid = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
report['video_frames'] = int(vid['nb_read_frames']) if vid else None
report['expected_frames'] = expected_frames

if any(s['codec_type'] == 'audio' for s in info['streams']):
    beeps = onsets(audio(out))
    # The beeps start on the source's audio frames (the volume filter works a frame at a time), so they're measured there.
    expected = [s - T for s in onsets(audio(src)) if T <= s < E - 0.05]
    errors = []
    for e in expected:
        near = [b for b in beeps if abs(b - e) < 0.2]
        errors.append(round((near[0] - e) * 1000, 1) if near else None)
    report['beep_errors_ms'] = errors
    report['audio_seconds'] = round(len(audio(out)) / 48000, 3)
print(json.dumps(report))
