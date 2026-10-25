#!/usr/bin/env python3
"""
End-to-end test of the editor behind the Studio tab (AudioMass multitrack), in a real Chromium.

It serves app/server/audio-editor as it is, then does what the Studio does: puts two audio files on two tracks, sets the tempo,
mixes the timeline down, saves the session and loads it back into a fresh page. No server, no account, no GPU needed.

    pip install playwright && playwright install chromium
    python3 app/e2e/studio_editor_e2e.py
"""
import base64, functools, http.server, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent / "server" / "audio-editor"

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

# A stereo 16-bit WAV of a sine wave, built inside the page and handed to the editor like the Studio does.
MAKE_FILE = """([name, seconds, freq]) => {
  const rate = 22050, n = Math.round(seconds * rate), buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { const x = Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000); v.setInt16(44 + i * 4, x, true); v.setInt16(46 + i * 4, x, true); }
  const file = new File([buf], name, { type: 'audio/wav' });
  window.PKAudioEditor.fireEvent('RequestAddTrackFile', file, 0);
  return true;
}"""

fails = []
def check(cond, label):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond: fails.append(label)

def open_editor(browser, base):
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"{base}/index.html?multitrack=1")
    page.wait_for_function("window.PKAudioEditor && window.PKAudioEditor.multitrack && window.PKAudioEditor.multitrack.GetBeat", timeout=30000)
    return page, errors

def main():
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page, errors = open_editor(browser, base)

        # 1. Two files, added one after the other, land on two different tracks.
        page.evaluate(MAKE_FILE, ["bass.wav", 2, 110])
        page.wait_for_function("window.PKAudioEditor.multitrack.ListClips().length === 1", timeout=20000)
        page.evaluate(MAKE_FILE, ["lead.wav", 3, 440])
        page.wait_for_function("window.PKAudioEditor.multitrack.ListClips().length === 2", timeout=20000)
        clips = page.evaluate("window.PKAudioEditor.multitrack.ListClips().map(c => ({ name: c.name, start: c.start, duration: c.duration }))")
        names = sorted(c["name"] for c in clips)
        check(len(names) == 2 and len(set(names)) == 2, f"two distinct clips ({names})")
        check(all(c["start"] == 0 for c in clips), "both clips start at 0")
        tracks = page.evaluate("new Set(window.PKAudioEditor.multitrack.getState().clips.map(c => c.track)).size")
        check(tracks == 2, "the two clips are on two different tracks")

        # 2. Tempo and signature.
        page.evaluate("window.PKAudioEditor.multitrack.SetBeat(90, '3/4')")
        beat = page.evaluate("window.PKAudioEditor.multitrack.GetBeat()")
        check(beat == {"bpm": 90, "sig": "3/4"}, f"tempo set ({beat})")

        # 3. Mixdown: as long as the longest clip, and not silent.
        mix = page.evaluate("""() => new Promise((resolve) => window.PKAudioEditor.multitrack.MixdownAsync(null, (b) => {
          if (!b) return resolve(null);
          const ch = b.getChannelData ? b.getChannelData(0) : b.channels[0];
          let peak = 0; for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
          resolve({ duration: b.duration, peak });
        }))""")
        check(mix is not None and abs(mix["duration"] - 3) < 0.15, f"mixdown lasts about 3 s ({mix and mix['duration']})")
        check(mix is not None and mix["peak"] > 0.1, f"mixdown is not silent (peak {mix and mix['peak']})")

        # 4. Save the session...
        b64 = page.evaluate("""() => new Promise((resolve) => {
          const blob = window.PKAudioEditor.multitrack.GetSessionBlob();
          if (!blob) return resolve(null);
          const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(blob);
        })""")
        check(bool(b64), "the session can be saved")
        page.close()

        # 5. ...and load it into a fresh page.
        page, errors2 = open_editor(browser, base)
        ok = page.evaluate("""async (b64) => {
          const bin = atob(b64), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return window.PKAudioEditor.multitrack.LoadSessionBuffer(bytes.buffer, 'project.amss');
        }""", b64)
        check(ok is not False, "the saved session loads")
        try:
            page.wait_for_function("window.PKAudioEditor.multitrack.ListClips().length === 2", timeout=20000)
            check(True, "the reopened project has its two clips")
        except Exception:
            check(False, "the reopened project has its two clips")
        names2 = sorted(page.evaluate("window.PKAudioEditor.multitrack.ListClips().map(c => c.name)"))
        check(names2 == names, f"same clip names after reopening ({names2})")
        beat2 = page.evaluate("window.PKAudioEditor.multitrack.GetBeat()")
        check(beat2["bpm"] == 90, f"tempo kept after reopening ({beat2})")
        check(not errors and not errors2, f"no script error in the page ({(errors + errors2)[:2]})")
        browser.close()
    srv.shutdown()
    if fails:
        print(f"\n{len(fails)} check(s) failed"); sys.exit(1)
    print("\nAll good")

if __name__ == "__main__":
    main()
