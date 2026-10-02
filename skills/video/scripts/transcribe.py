#!/usr/bin/env python3
"""transcribe.py: speech to words with exact times, on this computer, with faster-whisper. transcribe.mjs runs it.

Usage:
  python transcribe.py <media> -o words.json [--language he] [--script script.txt] [--model REPO]
                       [--model-dir DIR] [--device auto|cpu|cuda] [--threads N] [--beam 5] [--vad] [--no-holes]
                       [--ffmpeg PATH]

  <media>       any audio or video file
  -o            the words file: [{ "text": "...", "start": 0.42, "end": 0.80 }], in seconds
  --language    he (default), en, ar, ...
  --script      a text the speaker read; its names and numbers go to the recogniser as a spelling hint
  --model       a faster-whisper model on Hugging Face. Default: ivrit-ai/whisper-large-v3-turbo-ct2 for Hebrew,
                mobiuslabsgmbh/faster-whisper-large-v3-turbo for every other language
  --model-dir   a folder that holds a converted model (model.bin) is used as it is; any other folder is where
                models are downloaded to. Default: ~/.focus-motion/models
  --device      auto (default) uses an NVIDIA card when its libraries load, else the processor with int8
  --vad         drop stretches without speech before recognising (for long or noisy recordings)
  --no-holes    skip the second pass over stretches that hold speech but came back empty
  --ffmpeg      the ffmpeg program that decodes the sound (default: ffmpeg on the PATH)

Example:
  python transcribe.py "audio/voice.wav" -o "audio/words.json" --language he

Prints one JSON line on stdout. Progress goes to stderr. Exit codes: 0 ok, 1 failed, 2 usage, 3 a missing library.
"""
import argparse
import json
import os
import sys
import time

HEBREW_MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"
OTHER_MODEL = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
RATE = 16000


def note(*parts):
    print(*parts, file=sys.stderr, flush=True)


def finish(result, code=0):
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(code)


def home_dir():
    return os.path.abspath(os.environ.get("FOCUS_MOTION_HOME") or os.path.join(os.path.expanduser("~"), ".focus-motion"))


def add_nvidia_libraries():
    """pip installs the NVIDIA libraries under site-packages/nvidia/<name>/bin (Windows) or /lib (Linux).
    They are not on the search path there, so add them before the model loads."""
    try:
        import nvidia
    except Exception:
        return
    for root in list(getattr(nvidia, "__path__", [])):
        for name in sorted(os.listdir(root)):
            folder = os.path.join(root, name, "bin" if os.name == "nt" else "lib")
            if not os.path.isdir(folder):
                continue
            if os.name == "nt":
                try:
                    os.add_dll_directory(folder)
                except OSError:
                    pass
                os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
            else:
                import ctypes
                import glob
                for lib in sorted(glob.glob(os.path.join(folder, "*.so*"))):
                    try:
                        ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass


def resolve_model(args):
    """The folder of the model. Downloads it by name on first use."""
    given = args.model_dir
    if given and os.path.isfile(os.path.join(given, "model.bin")):
        return os.path.abspath(given), os.path.basename(os.path.normpath(given))
    repo = args.model or (HEBREW_MODEL if args.language == "he" else OTHER_MODEL)
    root = os.path.abspath(given) if given else os.path.join(home_dir(), "models")
    folder = os.path.join(root, repo.replace("/", "--"))
    if not (os.path.isfile(os.path.join(folder, "model.bin")) and os.path.isfile(os.path.join(folder, ".complete"))):
        note("downloading the speech model %s (one time, the Hebrew model is about 1.6 GB)" % repo)
        from faster_whisper.utils import download_model
        os.makedirs(folder, exist_ok=True)
        download_model(repo, output_dir=folder)
        with open(os.path.join(folder, ".complete"), "w", encoding="utf8") as f:
            f.write(repo + "\n")
    return folder, repo


def cuda_libraries():
    """True when cuBLAS 12 loads. Without it the card fails at the first word, after a slow model load."""
    import ctypes
    names = ["cublas64_12.dll"] if os.name == "nt" else ["libcublas.so.12", "libcublas.so"]
    for name in names:
        try:
            ctypes.CDLL(name)
            return True
        except OSError:
            pass
    return False


def load_model(folder, device, threads):
    """Returns (model, device, compute type). The card first when asked for or available, then the processor."""
    from faster_whisper import WhisperModel
    if device in ("auto", "cuda"):
        try:
            import ctranslate2
            cards = ctranslate2.get_cuda_device_count()
        except Exception:
            cards = 0
        if cards > 0:
            add_nvidia_libraries()
            if not cuda_libraries():
                note("an NVIDIA card is present but its libraries are not installed (transcribe.mjs setup --gpu adds them)")
            else:
                try:
                    return WhisperModel(folder, device="cuda", compute_type="int8_float16"), "cuda", "int8_float16"
                except Exception as e:
                    note("the graphics card could not be used (%s)" % str(e).splitlines()[0])
        if device == "cuda":
            raise RuntimeError("no usable NVIDIA card: the card or its libraries (cuBLAS, cuDNN) were not found")
    extra = {"cpu_threads": threads} if threads else {}
    # int8 can fail to allocate when memory is short. Without the packed matrix buffers it needs less; float32 last.
    last = None
    for compute, packed in (("int8", None), ("int8", "0"), ("float32", "0")):
        if packed is not None:
            os.environ["CT2_USE_EXPERIMENTAL_PACKED_GEMM"] = packed
        try:
            return WhisperModel(folder, device="cpu", compute_type=compute, **extra), "cpu", compute
        except RuntimeError as e:
            last = e
            note("%s did not load (%s)" % (compute, str(e).splitlines()[0]))
    raise last


def hint_words(path):
    """Names and numbers of the script: the words a recogniser is most likely to spell differently."""
    import re
    with open(path, encoding="utf-8-sig") as f:
        text = f.read()
    seen, picked = set(), []
    for token in text.split():
        word = token.strip(".,!?:;()[]\"'`\u05f4\u05f3\u201c\u201d\u2018\u2019")
        if not word or not re.search(r"[A-Za-z0-9]", word):
            continue
        key = word.lower()
        if key not in seen:
            seen.add(key)
            picked.append(word)
        if len(picked) >= 60:
            break
    return " ".join(picked)


class Recogniser:
    def __init__(self, args, folder):
        self.args = args
        self.folder = folder
        self.model, self.device, self.compute = load_model(folder, args.device, args.threads)
        self.hint = hint_words(args.script) if args.script else ""

    def _run(self, audio, offset, progress_total):
        options = dict(language=self.args.language, word_timestamps=True, vad_filter=self.args.vad, beam_size=self.args.beam,
                       condition_on_previous_text=False)
        if self.hint:
            options["hotwords"] = self.hint
        try:
            segments, _ = self.model.transcribe(audio, **options)
        except TypeError:                      # an older faster-whisper without hotwords
            options.pop("hotwords", None)
            segments, _ = self.model.transcribe(audio, **options)
        spaced = self.args.language not in ("zh", "ja", "th", "lo", "my", "yue")
        words, shown = [], -1
        for seg in segments:
            first = True
            for w in seg.words or []:
                text = w.word.strip()
                if not text:
                    continue
                if spaced and not first and words and not w.word[:1].isspace():
                    # no space before it: a piece of the word before ("5" then ".5")
                    words[-1]["text"] += text
                    words[-1]["end"] = round(w.end + offset, 3)
                else:
                    words.append({"text": text, "start": round(w.start + offset, 3), "end": round(w.end + offset, 3)})
                first = False
            if progress_total:
                pct = int(min(100, 100 * seg.end / progress_total) // 10 * 10)
                if pct > shown:
                    shown = pct
                    note("  %d%%" % pct)
        return words

    def words(self, audio, offset=0.0, progress_total=0.0):
        """audio: 16 kHz float32 samples. Returns [{text, start, end}], times shifted by offset."""
        try:
            return self._run(audio, offset, progress_total)
        except RuntimeError as e:
            if self.device != "cuda" or self.args.device == "cuda":
                raise
            # the card was found but a library is missing at run time: continue on the processor
            note("the graphics card failed while recognising (%s), continuing on the processor" % str(e).splitlines()[0])
            self.model, self.device, self.compute = load_model(self.folder, "cpu", self.args.threads)
            return self._run(audio, offset, progress_total)


def read_audio(media, ffmpeg):
    """The sound of any media file as 16 kHz mono float samples. ffmpeg decodes it, so the result does not depend
    on the audio library that happens to be installed next to faster-whisper."""
    import subprocess
    import numpy as np
    command = [ffmpeg or "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", media, "-map", "0:a:0", "-vn",
               "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"]
    try:
        done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError:
        done = None
    if done is not None and done.returncode == 0:
        return np.frombuffer(done.stdout, dtype="<f4")
    if done is not None and b"matches no streams" in done.stderr:
        raise RuntimeError("the file has no sound track")
    from faster_whisper import decode_audio        # no ffmpeg program: the library's own decoder
    return decode_audio(media, sampling_rate=RATE)


def speech_mask(samples, hop=0.02):
    """True for every 20 ms that is clearly louder than the quiet parts of this recording."""
    import numpy as np
    n = int(hop * RATE)
    frames = len(samples) // n
    if frames < 5:
        return np.zeros(0, dtype=bool), hop
    rms = np.sqrt(np.mean(samples[: frames * n].reshape(frames, n) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    return db > np.percentile(db, 10) + 14, hop


def fill_holes(rec, samples, words):
    """Whisper sometimes skips a sentence, most often one that is spoken twice, or stretches one word over it.
    Such a stretch shows as a gap in the words that still holds speech. Each one is recognised again on its own."""
    total = len(samples) / RATE
    mask, hop = speech_mask(samples)
    if not len(mask):
        return words, []

    def speech_in(a, b):
        return float(mask[int(a / hop): int(b / hop)].sum()) * hop

    for w in words:                                  # a very long word hides a skipped stretch: keep its head only
        if w["end"] - w["start"] > 1.1:
            w["end"] = round(w["start"] + 0.55, 3)
    bounds = [0.0] + [v for w in words for v in (w["start"], w["end"])] + [total]
    found, added = [], []
    for k in range(0, len(bounds) - 1, 2):
        a, b = bounds[k], bounds[k + 1]
        if b - a > 0.7 and speech_in(a, b) > 0.35:
            a0, b0 = max(0.0, a - 0.08), min(total, b + 0.08)
            got = [g for g in rec.words(samples[int(a0 * RATE): int(b0 * RATE)], a0) if g["start"] >= a - 0.05 and g["start"] < b]
            if got:
                found.append({"from": round(a, 2), "to": round(b, 2), "text": " ".join(g["text"] for g in got)})
                added += got
    if not added:
        return words, found
    merged = sorted(words + added, key=lambda w: w["start"])
    kept = [w for k, w in enumerate(merged) if k == 0 or abs(w["start"] - merged[k - 1]["start"]) > 0.02]
    return kept, found


def tidy(words, total):
    """Times in order, inside the recording, and no word running into the next one."""
    words = sorted(words, key=lambda w: w["start"])
    for k, w in enumerate(words):
        w["start"] = round(min(max(0.0, w["start"]), total), 3)
        limit = words[k + 1]["start"] if k + 1 < len(words) else total
        w["end"] = round(max(w["start"] + 0.02, min(w["end"], max(limit, w["start"] + 0.02))), 3)
    return words


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("media", nargs="?")
    parser.add_argument("-o", "--out")
    parser.add_argument("--language", default="he")
    parser.add_argument("--script")
    parser.add_argument("--model")
    parser.add_argument("--model-dir", dest="model_dir")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    parser.add_argument("--threads", type=int, default=0)
    parser.add_argument("--beam", type=int, default=5)
    parser.add_argument("--vad", action="store_true")
    parser.add_argument("--no-holes", dest="holes", action="store_false")
    parser.add_argument("--ffmpeg")
    parser.add_argument("-h", "--help", action="store_true")
    args = parser.parse_args()
    if args.help or not args.media or not args.out:
        sys.stdout.write(__doc__)
        sys.exit(0 if args.help else 2)
    if not os.path.isfile(args.media):
        finish({"ok": False, "error": "file not found: %s" % args.media}, 2)
    if args.script and not os.path.isfile(args.script):
        finish({"ok": False, "error": "script not found: %s" % args.script}, 2)
    args.language = (args.language or "he").lower()

    try:
        import faster_whisper
    except Exception as e:
        finish({"ok": False, "error": "faster-whisper is not installed in this Python (%s)" % e, "missing": "faster-whisper"}, 3)

    started = time.time()
    try:
        folder, model_name = resolve_model(args)
    except Exception as e:
        finish({"ok": False, "error": "the speech model could not be downloaded: %s" % str(e).splitlines()[0]}, 1)
    try:
        rec = Recogniser(args, folder)
    except Exception as e:
        reason = str(e).splitlines()[0] if str(e) else type(e).__name__
        if "alloc" in reason.lower() or isinstance(e, MemoryError):
            reason = "not enough free memory (%s). Close other programs and run it again" % reason
        finish({"ok": False, "error": "the speech model could not be loaded: %s" % reason}, 1)
    loaded = time.time()
    try:
        samples = read_audio(args.media, args.ffmpeg)
    except Exception as e:
        finish({"ok": False, "error": "no sound could be read from this file (%s)" % (str(e).splitlines()[0] if str(e) else type(e).__name__)}, 1)
    total = len(samples) / RATE
    if total < 0.1:
        finish({"ok": False, "error": "the file holds no sound"}, 1)
    note("recognising %.1f s of sound on %s (%s)" % (total, rec.device, rec.compute))

    try:
        words = rec.words(samples, 0.0, total)
        holes = []
        if args.holes and words:
            words, holes = fill_holes(rec, samples, words)
    except Exception as e:
        finish({"ok": False, "error": "recognition failed: %s" % str(e).splitlines()[0]}, 1)
    words = tidy(words, total)
    done = time.time()

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf8") as f:
        json.dump(words, f, ensure_ascii=False, indent=1)
        f.write("\n")
    seconds = max(done - loaded, 1e-6)
    finish({
        "ok": True, "out": out.replace("\\", "/"), "words": len(words), "duration": round(total, 2),
        "language": args.language, "model": model_name, "device": rec.device, "compute": rec.compute,
        "faster_whisper": getattr(faster_whisper, "__version__", "?"),
        "load_seconds": round(loaded - started, 1), "seconds": round(seconds, 1), "speed": round(total / seconds, 2),
        "holes": holes, "hint": rec.hint, "text": " ".join(w["text"] for w in words),
    })


if __name__ == "__main__":
    main()
