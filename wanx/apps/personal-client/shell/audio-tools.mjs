import path from "node:path";

export function packagedAudioEnvironment(resourcesPath) {
  const directory = path.join(resourcesPath, "audio-tools");
  return {
    FFMPEG_BIN: path.join(directory, "ffmpeg.exe"),
    FFPROBE_BIN: path.join(directory, "ffprobe.exe"),
  };
}
