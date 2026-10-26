#!/usr/bin/env python3
"""
Audio tools without ffmpeg, for the machines where Windows (Smart App Control) refuses ffmpeg's DLLs.

Run by the server with the engine's Python, only when ffmpeg has failed. Needs numpy, scipy and soundfile, which the engine installs.
It does not copy ffmpeg's filters one for one: it does the same job with the same settings, close enough to be used in its place.

    audio_fallback.py mix       --source A --stem B --out OUT(.flac|.mp3) --level 80
    audio_fallback.py stretch   --input IN --out OUT.wav --ratio 1.2
    audio_fallback.py loudnorm  --input IN --out OUT.wav --target-i -14 --target-tp -1 [--warmth 0..100 --harmonics 0..100 --tone -100..100 --glue 0..100 --width 0..100]

`loudnorm` prints {"original": LUFS, "result": LUFS} as JSON on its last line.
"""
import argparse
import json
import math
import sys

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

OUT_RATE = 48000


# ---------------------------------------------------------------- reading and writing

def read(path):
    data, rate = sf.read(path, always_2d=True, dtype='float32')
    return data, rate


def to_stereo(x):
    if x.shape[1] == 1:
        return np.repeat(x, 2, axis=1)
    return x[:, :2]


def resample(x, rate_in, rate_out):
    if rate_in == rate_out:
        return x
    g = math.gcd(int(rate_in), int(rate_out))
    return signal.resample_poly(x, rate_out // g, rate_in // g, axis=0).astype('float32')


def write(path, data, rate):
    low = path.lower()
    data = np.clip(data, -1.0, 1.0)
    if low.endswith('.mp3'):
        try:
            sf.write(path, data, rate, format='MP3', bitrate_mode='VARIABLE', compression_level=0.1)
        except TypeError:
            sf.write(path, data, rate, format='MP3')
    elif low.endswith('.flac'):
        sf.write(path, data, rate, format='FLAC', subtype='PCM_16')
    else:
        sf.write(path, data, rate, format='WAV', subtype='PCM_16')


# ---------------------------------------------------------------- loudness (ITU-R BS.1770-4)

def k_weighting(x, rate):
    """The K-weighting filter of BS.1770 (a high shelf, then a 38 Hz high pass), computed for any sample rate."""
    g, q, fc = 3.999843853973347, 0.7071752369554196, 1681.9744509555319
    k = math.tan(math.pi * fc / rate)
    vh = 10 ** (g / 20)
    vb = vh ** 0.4996667741545416
    a0 = 1 + k / q + k * k
    b1s = [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0]
    a1s = [1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
    q2, fc2 = 0.5003270373238773, 38.13547087613982
    k2 = math.tan(math.pi * fc2 / rate)
    d = 1 + k2 / q2 + k2 * k2
    a2s = [1, 2 * (k2 * k2 - 1) / d, (1 - k2 / q2 + k2 * k2) / d]
    y = signal.lfilter(b1s, a1s, x, axis=0)
    return signal.lfilter([1, -2, 1], a2s, y, axis=0)


def integrated_loudness(x, rate):
    """Integrated loudness in LUFS (400 ms blocks, 75 % overlap, absolute gate -70, relative gate -10 LU). -inf when silent."""
    if x.shape[0] < int(0.4 * rate):
        pad = np.zeros((int(0.4 * rate) - x.shape[0], x.shape[1]), dtype=x.dtype)
        x = np.concatenate([x, pad])
    z = k_weighting(x.astype('float64'), rate) ** 2
    block, step = int(round(0.4 * rate)), int(round(0.1 * rate))
    cs = np.concatenate([np.zeros((1, z.shape[1])), np.cumsum(z, axis=0)])
    starts = np.arange(0, z.shape[0] - block + 1, step)
    means = (cs[starts + block] - cs[starts]) / block          # blocks x channels
    power = means.sum(axis=1)                                   # channel weights are 1 for L and R
    with np.errstate(divide='ignore'):
        loud = -0.691 + 10 * np.log10(power)
    gated = loud > -70
    if not gated.any():
        return float('-inf')
    rel = -0.691 + 10 * math.log10(power[gated].mean()) - 10
    keep = gated & (loud > rel)
    if not keep.any():
        return float('-inf')
    return -0.691 + 10 * math.log10(power[keep].mean())


def true_peak_db(x, rate):
    """The highest peak in dBTP, found on a signal sampled four times as often."""
    over = signal.resample_poly(x, 4, 1, axis=0)
    peak = float(np.max(np.abs(over))) if over.size else 0.0
    return 20 * math.log10(peak) if peak > 0 else float('-inf')


# ---------------------------------------------------------------- limiter, filters

def limit(x, ceiling, rate, lookahead_ms=5.0):
    """A look-ahead peak limiter: the gain falls before a peak arrives and comes back after it, so nothing goes above `ceiling`."""
    peak = np.max(np.abs(x), axis=1)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    if need.min() >= 1.0:
        return x
    n = max(1, int(rate * lookahead_ms / 1000))
    held = minimum_filter1d(need, size=2 * n + 1, mode='nearest')
    smooth = uniform_filter1d(held, size=n + 1, mode='nearest')
    smooth = np.minimum(smooth, need)                           # the average can leave a peak a little high: never above what is needed
    return (x * smooth[:, None]).astype('float32')


def shelf(x, rate, gain_db, freq, high):
    """An RBJ shelving filter (high or low), slope 1."""
    a = 10 ** (gain_db / 40)
    w0 = 2 * math.pi * freq / rate
    cw, sw = math.cos(w0), math.sin(w0)
    alpha = sw / 2 * math.sqrt(2)                               # S = 1
    sq = 2 * math.sqrt(a) * alpha
    if high:
        b = [a * ((a + 1) + (a - 1) * cw + sq), -2 * a * ((a - 1) + (a + 1) * cw), a * ((a + 1) + (a - 1) * cw - sq)]
        c = [(a + 1) - (a - 1) * cw + sq, 2 * ((a - 1) - (a + 1) * cw), (a + 1) - (a - 1) * cw - sq]
    else:
        b = [a * ((a + 1) - (a - 1) * cw + sq), 2 * a * ((a - 1) - (a + 1) * cw), a * ((a + 1) - (a - 1) * cw - sq)]
        c = [(a + 1) + (a - 1) * cw + sq, -2 * ((a - 1) + (a + 1) * cw), (a + 1) + (a - 1) * cw - sq]
    return signal.lfilter(np.array(b) / c[0], np.array(c) / c[0], x, axis=0)


def highpass(x, rate, freq, order=2):
    sos = signal.butter(order, freq, 'highpass', fs=rate, output='sos')
    return signal.sosfilt(sos, x, axis=0)


def compressor(x, rate, threshold_db, ratio, attack_ms, release_ms, knee_db=6.0):
    """A soft-knee compressor with no make-up gain. The level is followed on a control rate of about 1 kHz."""
    hop = max(1, rate // 1000)
    n = x.shape[0] // hop * hop
    if n == 0:
        return x
    level = np.max(np.abs(x[:n]), axis=1).reshape(-1, hop).max(axis=1)
    db = 20 * np.log10(np.maximum(level, 1e-6))
    over = db - threshold_db
    out = np.where(over <= -knee_db / 2, 0.0,
                   np.where(over >= knee_db / 2, over * (1 - 1 / ratio), (1 - 1 / ratio) * (over + knee_db / 2) ** 2 / (2 * knee_db)))
    target = -out                                               # wanted gain reduction (dB, positive)
    att = math.exp(-1.0 / (attack_ms))                          # one control sample is 1 ms
    rel = math.exp(-1.0 / (release_ms))
    red = np.empty_like(target)
    cur = 0.0
    for i, t in enumerate(target):                              # attack when the reduction grows, release when it falls
        coef = att if t > cur else rel
        cur = coef * cur + (1 - coef) * t
        red[i] = cur
    gain = 10 ** (-red / 20)
    pos = (np.arange(x.shape[0]) - hop / 2) / hop
    full = np.interp(pos, np.arange(len(gain)), gain)
    return (x * full[:, None]).astype('float32')


def master(x, rate, s):
    """The mastering chain of services/mastering.ts: high pass, tone, warmth, harmonics, glue, width."""
    y = highpass(x.astype('float64'), rate, 25)
    if abs(s['tone']) >= 1:
        y = shelf(y, rate, s['tone'] * 0.03, 6000, True)
        y = shelf(y, rate, -s['tone'] * 0.015, 120, False)
    if s['warmth'] >= 1:
        drive = 2 + s['warmth'] * 0.08
        wet = (s['warmth'] / 100) * 0.5
        gain = 10 ** (drive / 20)
        sat = np.tanh(y * gain) / gain
        y = (1 - wet) * y + wet * sat
    if s['harmonics'] >= 1:
        amount = max(0.1, (s['harmonics'] / 100) * 3)
        # An exciter: the highs are soft-clipped and what the clipping adds (the harmonics) is mixed back in, below 16 kHz.
        hp = highpass(y, rate, 7500, 2)
        drive = 8.5
        added = np.tanh(hp * drive) / drive - hp
        low_pass = signal.butter(2, min(16000, rate * 0.45), 'lowpass', fs=rate, output='sos')
        y = y + signal.sosfilt(low_pass, added, axis=0) * amount * 8
    y = y.astype('float32')
    if s['glue'] >= 1:
        g = s['glue'] / 100
        y = compressor(y, rate, -12 - g * 10, 1.4 + g * 1.6, 30, 250)
    if s['width'] >= 1 and y.shape[1] >= 2:
        m = 1 + (s['width'] / 100) * 0.4
        avg = (y[:, 0] + y[:, 1]) / 2
        y = np.stack([avg + (y[:, 0] - avg) * m, avg + (y[:, 1] - avg) * m], axis=1).astype('float32')
    return y


def mastering_active(s):
    return s['harmonics'] >= 1 or s['warmth'] >= 1 or abs(s['tone']) >= 1 or s['glue'] >= 1 or s['width'] >= 1


# ---------------------------------------------------------------- commands

def cmd_mix(a):
    src, r1 = read(a.source)
    stem, r2 = read(a.stem)
    src = resample(to_stereo(src), r1, OUT_RATE)
    stem = resample(to_stereo(stem), r2, OUT_RATE) * (max(0.0, min(150.0, a.level)) / 100.0)
    n = max(len(src), len(stem))
    mix = np.zeros((n, 2), dtype='float32')
    mix[:len(src)] += src
    mix[:len(stem)] += stem
    write(a.out, limit(mix, 0.95, OUT_RATE), OUT_RATE)


def cmd_stretch(a):
    x, rate = read(a.input)
    r = a.ratio
    if not (0.25 <= r <= 4):
        raise SystemExit('ratio must be between 0.25 and 4')
    write(a.out, np.stack([phase_vocoder(x[:, c], r) for c in range(x.shape[1])], axis=1), rate)


def phase_vocoder(x, ratio, n_fft=2048, hs=512):
    """Plays the signal `ratio` times as fast without changing its pitch (phase vocoder)."""
    n = len(x)
    if n < n_fft:
        return np.interp(np.linspace(0, n - 1, max(1, int(n / ratio))), np.arange(n), x).astype('float32')
    win = np.hanning(n_fft).astype('float32')
    frames_out = int(math.ceil((n / ratio) / hs))
    pos = np.minimum(np.round(np.arange(frames_out) * hs * ratio).astype(np.int64), n - n_fft)
    pad = np.concatenate([x.astype('float32'), np.zeros(n_fft, dtype='float32')])
    idx = pos[:, None] + np.arange(n_fft)[None, :]
    spec = np.fft.rfft(pad[idx] * win, axis=1).astype('complex64')
    mag, ph = np.abs(spec), np.angle(spec)
    omega = 2 * np.pi * np.arange(n_fft // 2 + 1) / n_fft
    real_hop = np.diff(pos, prepend=pos[0]).astype('float64')
    real_hop[0] = hs * ratio
    dphi = np.diff(ph, axis=0, prepend=ph[:1]) - omega[None, :] * real_hop[:, None]
    dphi = dphi - 2 * np.pi * np.round(dphi / (2 * np.pi))     # wrapped to -pi..pi
    freq = omega[None, :] + dphi / np.maximum(real_hop[:, None], 1)
    out_ph = ph[0][None, :] + np.cumsum(freq * hs, axis=0) - freq[0][None, :] * hs
    frames = np.fft.irfft(mag * np.exp(1j * out_ph), n=n_fft, axis=1) * win
    out = np.zeros(frames_out * hs + n_fft, dtype='float64')
    norm = np.zeros_like(out)
    w2 = (win ** 2).astype('float64')
    for k in range(frames_out):                                 # overlap-add
        out[k * hs:k * hs + n_fft] += frames[k]
        norm[k * hs:k * hs + n_fft] += w2
    out = out / np.maximum(norm, 1e-6)
    return out[:int(n / ratio)].astype('float32')


def cmd_loudnorm(a):
    x, rate = read(a.input)
    x = to_stereo(x) if x.shape[1] > 2 else x
    s = {'harmonics': a.harmonics, 'warmth': a.warmth, 'tone': a.tone, 'glue': a.glue, 'width': a.width}
    original = integrated_loudness(x, rate)
    y = master(x, rate, s) if mastering_active(s) else x
    measured = integrated_loudness(y, rate)
    if not math.isfinite(measured):
        raise SystemExit('the audio is silent: nothing to normalise')
    y = resample(y, rate, OUT_RATE)
    gain_db = a.target_i - measured
    ceiling = 10 ** (a.target_tp / 20)
    if mastering_active(s):
        y = limit(y * (10 ** (gain_db / 20)), min(1.0, max(0.0625, ceiling)), OUT_RATE)
    else:
        # Linear normalisation like loudnorm's: the gain stops where the true peak would pass the ceiling.
        tp = true_peak_db(y, OUT_RATE)
        if math.isfinite(tp):
            gain_db = min(gain_db, a.target_tp - tp)
        y = (y * (10 ** (gain_db / 20))).astype('float32')
    write(a.out, y, OUT_RATE)
    print(json.dumps({'original': None if not math.isfinite(original) else round(original, 2), 'result': round(integrated_loudness(y, OUT_RATE), 2)}))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    m = sub.add_parser('mix'); m.add_argument('--source', required=True); m.add_argument('--stem', required=True)
    m.add_argument('--out', required=True); m.add_argument('--level', type=float, default=80)
    t = sub.add_parser('stretch'); t.add_argument('--input', required=True); t.add_argument('--out', required=True)
    t.add_argument('--ratio', type=float, required=True)
    l = sub.add_parser('loudnorm'); l.add_argument('--input', required=True); l.add_argument('--out', required=True)
    l.add_argument('--target-i', type=float, default=-14); l.add_argument('--target-tp', type=float, default=-1.0)
    for name, default in (('harmonics', 0), ('warmth', 0), ('tone', 0), ('glue', 0), ('width', 0)):
        l.add_argument('--' + name, type=float, default=default)
    a = p.parse_args()
    {'mix': cmd_mix, 'stretch': cmd_stretch, 'loudnorm': cmd_loudnorm}[a.cmd](a)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # a clear last line for the server
        print(f'audio_fallback: {type(e).__name__}: {e}', file=sys.stderr)
        sys.exit(1)
