# 本地转写 sidecar（D-34b）

`transcribe.py` 是主控机上的本地语音转写进程（faster-whisper）。主进程用「一行一条 JSON」和它通信，
协议见脚本开头的注释。

**默认走 GPU（CUDA / float16）**：江浩 2026-11-02 明确「不要 CPU 版本」。`--device auto`（默认）在有 CUDA
时用 GPU；**没有可用 CUDA 会直接报错**，不会悄悄退回 CPU。真要临时用 CPU，在 `asr.json` 里写
`"device": "cpu"`（那时 `computeType` 默认 `int8`）。

## 准备（开发机）

```powershell
# 1. 一个装了 faster-whisper 的 Python（模型自带 av，不用系统装 ffmpeg）
python -m venv E:\AI\TTS\faster-whisper
E:\AI\TTS\faster-whisper\Scripts\pip install faster-whisper

# 2. CUDA 运行时 DLL（Windows 上 CTranslate2 需要；不装会报 Library cublas64_12.dll is not found）
E:\AI\TTS\faster-whisper\Scripts\pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12

# 3. 模型（small，约 461 MB，ModelScope: pengzhendong/faster-whisper-small）
#    目录里要有 model.bin / config.json / tokenizer.json

# 4. 告诉应用用哪个 python、哪个模型：userData/asr.json
```

`transcribe.py` 启动时会自己把 `site-packages/nvidia/*/bin` 加进 DLL 搜索路径（`os.add_dll_directory`），
不用改系统 PATH。

`asr.json`（放 Electron 的 userData 目录，和 `comfyui.json` 同级）：

```json
{
  "python": "E:\\AI\\TTS\\faster-whisper\\Scripts\\python.exe",
  "modelDir": "E:\\AI\\TTS\\models\\faster-whisper-small",
  "modelName": "faster-whisper-small",
  "script": "可选：显式指定 transcribe.py 的路径；默认用应用自带的",
  "device": "可选：auto（默认）/ cuda / cpu",
  "computeType": "可选：auto（cuda → float16、cpu → int8）/ float16 / int8 / float32"
}
```

没有 `asr.json` 时 `chat.voice.import` 会明确报「本地转写还没配好」，不会假装转写。

## 真机验证

直接跑脚本，喂两行 JSON（一行 probe、一行 transcribe）：

```powershell
@(
  '{"id":1,"cmd":"probe","path":"E:/AI/TTS/samples/B_cosyvoice2.wav"}',
  '{"id":2,"cmd":"transcribe","path":"E:/AI/TTS/samples/B_cosyvoice2.wav"}'
) -join "`n" | & 'E:\AI\TTS\faster-whisper\Scripts\python.exe' 'apps/desktop/python/transcribe.py' --model 'E:/AI/TTS/models/faster-whisper-small'
```

启动日志会写 `sidecar ready, device: cuda float16`。

## 实测（2026-11-02，7.64 秒音频）

| 设备 | 模型加载 | 第一次转写 | 第二次（热） |
|---|---|---|---|
| **cuda / float16** | 0.67 s | 0.83 s | **0.45 s** |
| cpu / int8（旧默认） | 1.06 s | 3.45 s | 3.43 s |

热转写 **0.45 s 对 3.43 s，约 7.6 倍**；第一次（含加载）1.5 s 对 4.5 s。
（2026-11-01 那次「6.4 秒」是 CPU 冷启动的旧数字，已作废。）
