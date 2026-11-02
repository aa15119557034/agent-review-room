# 本地转写 sidecar（D-34b）

`transcribe.py` 是主控机上的本地语音转写进程（faster-whisper，CPU int8）。主进程用「一行一条 JSON」和它通信，
协议见脚本开头的注释。

## 准备（开发机）

```powershell
# 1. 一个装了 faster-whisper 的 Python（模型自带 av，不用系统装 ffmpeg）
python -m venv E:\AI\TTS\faster-whisper
E:\AI\TTS\faster-whisper\Scripts\pip install faster-whisper

# 2. 模型（small，约 461 MB，ModelScope: pengzhendong/faster-whisper-small）
#    目录里要有 model.bin / config.json / tokenizer.json

# 3. 告诉应用用哪个 python、哪个模型：userData/asr.json
```

`asr.json`（放 Electron 的 userData 目录，和 `comfyui.json` 同级）：

```json
{
  "python": "E:\\AI\\TTS\\faster-whisper\\Scripts\\python.exe",
  "modelDir": "E:\\AI\\TTS\\models\\faster-whisper-small",
  "modelName": "faster-whisper-small",
  "script": "可选：显式指定 transcribe.py 的路径；默认用应用自带的"
}
```

没有 `asr.json` 时 `chat.voice.import` 会明确报「本地转写还没配好」，不会假装转写。

## 真机验证

直接跑脚本，喂两行 JSON（一行 probe、一行 transcribe）：

```powershell
cd E:\agent-review-room\dev
@(
  '{"id":1,"cmd":"probe","path":"E:/AI/TTS/samples/B_cosyvoice2.wav"}',
  '{"id":2,"cmd":"transcribe","path":"E:/AI/TTS/samples/B_cosyvoice2.wav"}'
) -join "`n" | & 'E:\AI\TTS\faster-whisper\Scripts\python.exe' 'apps/desktop/python/transcribe.py' --model 'E:/AI/TTS/models/faster-whisper-small'
```

2026-11-01 实测：probe 8920 ms；transcribe 第一次 6.4 秒（含模型加载），之后约 2 秒；文字正确（同音字错误和 spike 记录一致）。

实测（2026-10-28）：8.92 秒音频 CPU 转写 2.23 秒，实时率约 0.18；错字都是同音字。

