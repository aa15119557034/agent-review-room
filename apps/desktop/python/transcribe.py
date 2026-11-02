"""D-34b 本地转写 sidecar（ADR-004 转写一节）。

主进程用「一行一条 JSON」和这里通信：

    请求  {"id":1,"cmd":"probe","path":"C:/.../x.webm"}
    回复  {"id":1,"ok":true,"durationMs":8920}

    请求  {"id":2,"cmd":"transcribe","path":"C:/.../x.webm"}
    回复  {"id":2,"ok":true,"text":"...","language":"zh","durationMs":8920,"device":"cuda"}

出错时回 {"id":n,"ok":false,"error":"..."}。日志一律写 stderr，stdout 只放 JSON。

用法：
    python transcribe.py --model E:/AI/TTS/models/faster-whisper-small [--device auto|cuda|cpu] [--compute-type auto|float16|int8]

设备（江浩：不要 CPU 版本）：
    - 默认 --device auto：有 CUDA 就用 GPU（float16）；**没有可用 CUDA 直接报错**，不悄悄退回 CPU
    - 确实想用 CPU 时才显式写 --device cpu（compute-type 默认 int8）
    - Windows 上 CTranslate2 需要 cuBLAS / cuDNN 的 DLL；这里在导入前把 nvidia-*-cu12 的 bin 目录加进
      DLL 搜索路径（pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12）

模型只在第一次 transcribe 时加载；probe 只解码容器。
"""

import argparse
import json
import os
import sys
import traceback


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def add_nvidia_dll_dirs():
    """Windows：把 pip 装的 nvidia-*-cu12 的 bin/lib 目录加进 DLL 搜索路径。

    CTranslate2 用 LoadLibrary 按名字找 cublas64_12.dll / cudnn_*.dll，找不到就会报
    "Library cublas64_12.dll is not found"。装完 wheel 它们就在 site-packages/nvidia/*/bin。
    """
    if os.name != "nt":
        return
    try:
        import site
    except Exception:  # noqa: BLE001 - 拿不到就按系统 PATH 试
        return
    roots = []
    for base in list(site.getsitepackages()) + [site.getusersitepackages()]:
        if base and os.path.isdir(os.path.join(base, "nvidia")):
            roots.append(os.path.join(base, "nvidia"))
    for root in roots:
        for name in os.listdir(root):
            for sub in ("bin", "lib"):
                path = os.path.join(root, name, sub)
                if not os.path.isdir(path):
                    continue
                try:
                    os.add_dll_directory(path)
                except Exception:  # noqa: BLE001
                    pass
                os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def cuda_available():
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count()) > 0
    except Exception as error:  # noqa: BLE001
        log("cuda check failed:", error)
        return False


def resolve_device(device, compute_type):
    """auto = 有 CUDA 就 cuda，没有就直接报错（不悄悄用 CPU）。"""
    if device == "auto":
        if not cuda_available():
            raise RuntimeError('没有可用的 CUDA（要求走 GPU）；确实要用 CPU 请在 asr.json 里显式写 "device": "cpu"')
        device = "cuda"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


def probe_duration_ms(path):
    import av  # faster-whisper 的依赖，自带 FFmpeg

    with av.open(path) as container:
        duration = container.duration
        if duration is None:
            # 有些容器只在 stream 上给时长
            durations = [s.duration * s.time_base for s in container.streams if s.duration is not None]
            if not durations:
                raise RuntimeError("容器里没有时长")
            return int(round(max(float(d) for d in durations) * 1000))
        # av 的 container.duration 单位是 AV_TIME_BASE（微秒）
        return int(round(int(duration) / 1000))


class Whisper:
    def __init__(self, model_dir, device, compute_type):
        self.model_dir = model_dir
        self.device = device
        self.compute_type = compute_type
        self._model = None

    def model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            log("loading model", self.model_dir, "on", self.device, self.compute_type)
            self._model = WhisperModel(self.model_dir, device=self.device, compute_type=self.compute_type)
            log("model loaded")
        return self._model

    def transcribe(self, path):
        segments, info = self.model().transcribe(path, vad_filter=True)
        text = "".join(segment.text for segment in segments).strip()
        return {
            "text": text,
            "language": info.language or None,
            "durationMs": int(round(float(info.duration) * 1000)),
            "device": self.device,
        }


def main():
    # Windows 上 stdin/stdout 默认可能是 cp936；统一成 UTF-8，JSON 又用 ensure_ascii 兜一层
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    args = parser.parse_args()

    add_nvidia_dll_dirs()
    try:
        device, compute_type = resolve_device(args.device, args.compute_type)
    except Exception as error:  # noqa: BLE001 - 启动就告诉主进程，别等到第一条录音
        log("device resolve failed:", error)
        print(json.dumps({"ok": False, "error": str(error), "id": None}, ensure_ascii=True), flush=True)
        return 1

    log("sidecar ready, device:", device, compute_type)
    whisper = Whisper(args.model, device, compute_type)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            cmd = request.get("cmd")
            path = request.get("path")
            if cmd == "probe":
                reply = {"ok": True, "durationMs": probe_duration_ms(path)}
            elif cmd == "transcribe":
                result = whisper.transcribe(path)
                reply = {"ok": True, **result}
            else:
                raise RuntimeError(f"unknown cmd: {cmd!r}")
        except Exception as error:  # noqa: BLE001 - 任何错误都回给主进程
            log("request failed:", traceback.format_exc())
            reply = {"ok": False, "error": str(error)[:1000] or "failed"}
        reply["id"] = request_id
        print(json.dumps(reply, ensure_ascii=True), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
