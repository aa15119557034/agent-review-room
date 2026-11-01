"""秘书语音合成的独立进程（D-37b，IndexTTS2）。

主控端（Electron main）用 spawn 起它，走 stdin/stdout 的 JSON 行协议，一个进程只加载一次模型：

  启动完成 → stdout: {"type":"ready","engine":"indextts2","engineVersion":"...","loadMs":12345}
  请求     → stdin : {"type":"synth","id":"r1","text":"...","out":"C:/tmp/a.wav","speed":1.0,"voice":{"source":"reference","refAudio":"..."}}
  成功     → stdout: {"type":"done","id":"r1","ms":4321,"durationMs":7640,"sampleRate":22050}
  失败     → stdout: {"type":"failed","id":"r1","error":"..."}

约定：
- 不说话的时候什么都不输出（主控端按行读，不做超时判断以外的假设）
- 一次只处理一个请求（显卡一次只跑一个，主控端那边也是串行的）
- 合成结果是 16-bit PCM wav；语速不是 1.0 时用 librosa 做变调不变的时长伸缩
- 引擎不认识的东西一律报 failed，不要 print 到 stdout（日志走 stderr）
"""

import json
import os
import sys
import time
import traceback

MODEL_DIR = os.environ.get("INDEXTTS_MODEL_DIR", r"E:\AI\TTS\models\IndexTTS-2")
INDEXTTS_ROOT = os.environ.get("INDEXTTS_ROOT", r"E:\AI\TTS\index-tts")
ENGINE_VERSION = os.environ.get("INDEXTTS_ENGINE_VERSION", "indextts2-2.0.0")


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model():
    sys.path.insert(0, INDEXTTS_ROOT)
    import torch  # noqa: F401  (让日志里能看到用的是 cpu 还是 cuda)
    from indextts.infer_v2 import IndexTTS2

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    log(f">> loading IndexTTS2 on {device}")
    tts = IndexTTS2(
        cfg_path=os.path.join(MODEL_DIR, "config.yaml"),
        model_dir=MODEL_DIR,
        use_fp16=device.startswith("cuda"),
        device=device,
    )
    return tts


def wav_info(path):
    import wave

    with wave.open(path, "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate()
        return {"durationMs": int(round(frames * 1000 / rate)), "sampleRate": rate}


def apply_speed(path, speed):
    """语速不是 1.0 时做变调不变的时长伸缩（librosa），结果写回同一个文件。"""
    if abs(speed - 1.0) < 1e-3:
        return
    import librosa
    import numpy as np
    import soundfile as sf

    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = np.mean(data, axis=1)
    stretched = librosa.effects.time_stretch(mono, rate=float(speed))
    sf.write(path, stretched, rate, subtype="PCM_16")


def main():
    started = time.time()
    try:
        tts = load_model()
    except Exception as error:  # 模型加载失败也要让主控端看到明确原因
        log(traceback.format_exc())
        emit({"type": "failed", "id": None, "error": f"model_load_failed: {error}"})
        return 1
    emit(
        {
            "type": "ready",
            "engine": "indextts2",
            "engineVersion": ENGINE_VERSION,
            "loadMs": int((time.time() - started) * 1000),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"type": "failed", "id": None, "error": f"bad_request: {error}"})
            continue
        request_id = request.get("id")
        if request.get("type") == "shutdown":
            return 0
        if request.get("type") != "synth":
            emit({"type": "failed", "id": request_id, "error": "unknown_request"})
            continue

        try:
            text = request["text"]
            out_path = request["out"]
            speed = float(request.get("speed", 1.0))
            voice = request.get("voice") or {}
            ref_audio = voice.get("refAudio")
            started = time.time()
            if ref_audio:
                tts.infer(spk_audio_prompt=ref_audio, text=text, output_path=out_path, verbose=False)
            else:
                tts.infer(text=text, output_path=out_path, verbose=False)
            apply_speed(out_path, speed)
            info = wav_info(out_path)
            emit(
                {
                    "type": "done",
                    "id": request_id,
                    "ms": int((time.time() - started) * 1000),
                    **info,
                }
            )
        except Exception as error:
            log(traceback.format_exc())
            emit({"type": "failed", "id": request_id, "error": str(error) or error.__class__.__name__})

    return 0


if __name__ == "__main__":
    sys.exit(main())
