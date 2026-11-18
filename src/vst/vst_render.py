# -*- coding: utf-8 -*-
"""SoundBin 的 VST3 离线渲染器。

由 Electron 主进程以 sidecar 方式调用：

    python.exe vst_render.py --job "<json 文件路径>"

job JSON：
{
  "mode": "params" | "render",
  "plugin": "C:/Program Files/Common Files/VST3/xxx.vst3",
  "in":     "C:/temp/in.wav",       # render 必填
  "out":    "C:/temp/out.wav",      # render 必填
  "paramValues": {"参数名": 0.5},   # 可选
  "tailSeconds": 1.5                # 可选，给混响类收尾
}

输出：stdout 打印一行 JSON（result 字段），出错时 ok=false + error。
"""
import json
import sys
import traceback


def emit(payload):
    # Windows 下默认 stdout 是 GBK，直接写中文会乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def load_board(plugin_path, param_values, plugin_name=None):
    from pedalboard import Pedalboard
    import pedalboard

    # 壳插件（比如 Waves WaveShell）一个 .vst3 里装了好几百个，必须指定具体哪一个
    if plugin_name:
        plugin = pedalboard.load_plugin(plugin_path, plugin_name=plugin_name)
    else:
        plugin = pedalboard.load_plugin(plugin_path)
    if param_values:
        for name, value in param_values.items():
            try:
                setattr(plugin, name, float(value))
            except Exception:
                pass
    return Pedalboard([plugin]), plugin


def describe(plugin):
    params = []
    for name in getattr(plugin, "parameters", {}).keys():
        api = plugin.parameters[name]
        item = {"name": name}
        try:
            item["value"] = float(getattr(plugin, name))
        except Exception:
            item["value"] = None
        for attr in ("min_value", "max_value"):
            try:
                item[attr] = float(getattr(api, attr))
            except Exception:
                pass
        try:
            item["label"] = str(api.label)
        except Exception:
            pass
        try:
            item["is_discrete"] = bool(api.is_discrete) if hasattr(api, "is_discrete") else False
        except Exception:
            pass
        params.append(item)
    return params


def main():
    job_path = None
    for i, arg in enumerate(sys.argv):
        if arg == "--job" and i + 1 < len(sys.argv):
            job_path = sys.argv[i + 1]
    if not job_path:
        emit({"ok": False, "error": "缺少 --job 参数"})
        return 2

    with open(job_path, "r", encoding="utf-8") as fh:
        job = json.load(fh)

    plugin_path = job.get("plugin")
    if not plugin_path:
        emit({"ok": False, "error": "缺少 plugin 路径"})
        return 2

    try:
        board, plugin = load_board(
            plugin_path, job.get("paramValues") or {}, job.get("pluginName") or None
        )
    except Exception as exc:
        emit({"ok": False, "error": "加载插件失败：%s" % exc, "stage": "load"})
        return 3

    if job.get("mode") == "names":
        from pedalboard import VST3Plugin

        try:
            names = VST3Plugin.get_plugin_names_for_file(plugin_path)
            emit({"ok": True, "names": names})
        except Exception as exc:
            emit({"ok": False, "error": "\u8bfb\u53d6\u58f3\u63d2\u4ef6\u5b50\u63d2\u4ef6\u5931\u8d25\uff1a%s" % exc})
            return 4
        return 0

    if job.get("mode") == "params":
        try:
            emit({
                "ok": True,
                "name": getattr(plugin, "name", ""),
                "params": describe(plugin),
            })
        except Exception as exc:
            emit({"ok": False, "error": "读取参数失败：%s" % exc, "stage": "params"})
            return 4
        return 0

    try:
        import numpy as np
        from pedalboard.io import AudioFile

        with AudioFile(job["in"]) as f:
            sr = f.samplerate
            audio = f.read(f.frames)

        # 很多效果器（比如 CLA-76 Stereo）只接立体声，单声道料先复制一份
        if audio.ndim == 2 and audio.shape[0] == 1:
            audio = np.repeat(audio, 2, axis=0)

        tail = float(job.get("tailSeconds") or 0.0)
        if tail > 0:
            pad = np.zeros((audio.shape[0], int(sr * tail)), dtype=audio.dtype)
            audio = np.concatenate([audio, pad], axis=1)

        out = board(audio, sr)

        with AudioFile(job["out"], "w", sr, out.shape[0]) as f:
            f.write(out)

        emit({"ok": True, "out": job["out"], "samplerate": sr, "frames": int(out.shape[1])})
        return 0
    except Exception as exc:
        detail = traceback.format_exc(limit=3).splitlines()[-1]
        emit({"ok": False, "error": "渲染失败：%s" % exc, "detail": detail, "stage": "render"})
        return 5


if __name__ == "__main__":
    import os

    # 部分 VST3 在解释器退出时会崩（返回 0xC0000005），这里直接硬退出
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code if isinstance(code, int) else 0)
