"""D-34b 本地转写 sidecar（ADR-004 转写一节）。

主进程用「一行一条 JSON」和这里通信：

    请求  {"id":1,"cmd":"probe","path":"C:/.../x.webm"}
    回复  {"id":1,"ok":true,"durationMs":8920}

    请求  {"id":2,"cmd":"transcribe","path":"C:/.../x.webm"}
    回复  {"id":2,"ok":true,"text":"...","language":"zh","durationMs":8920}

出错时回 {"id":n,"ok":false,"error":"..."}。日志一律写 stderr，stdout 只放 JSON。

用法：
    python transcribe.py --model E:/AI/TTS/models/faster-whisper-small [--device cpu] [--compute-type int8]

模型只在第一次 transcribe 时加载；probe 只解码容器。
"""

import argparse
import json
import sys
import traceback


def log(*args):
    print(*args, file=sys.stderr, flush=True)


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

            log("loading model", self.model_dir)
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
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()

    whisper = Whisper(args.model, args.device, args.compute_type)
    log("sidecar ready")

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


if __name__ == "__main__":
    main()

