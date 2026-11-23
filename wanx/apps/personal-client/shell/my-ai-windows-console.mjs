import { closeSync, fstatSync, openSync } from "node:fs";
import { isatty, ReadStream, WriteStream } from "node:tty";

// Windows GUI-subsystem runtimes can print to a console while fd 0 still points
// to NUL. Reopen the attached console for both review and the CLI's inherited
// handles. Preserve genuine redirected input (pipes/files), including EOF.
export function reconnectWindowsConsole() {
  if (process.platform !== "win32") return;
  try { if (!fstatSync(0).isCharacterDevice()) return; }
  catch (error) { if (error.code !== "EBADF") throw error; }
  const descriptors = [];
  let input, output;
  const close = () => {
    input?.destroy(); output?.destroy();
    for (const fd of descriptors.splice(0)) { try { closeSync(fd); } catch {} }
  };
  try {
    const read = openSync("\\\\.\\CONIN$", "r+"); descriptors.push(read);
    const forwardedRead = openSync("\\\\.\\CONIN$", "r+"); descriptors.push(forwardedRead);
    const write = openSync("\\\\.\\CONOUT$", "r+"); descriptors.push(write);
    if (!isatty(read) || !isatty(write)) { close(); return; }
    input = new ReadStream(read);
    descriptors.splice(descriptors.indexOf(read), 1); // The stream owns this fd.
    output = new WriteStream(write);
    descriptors.splice(descriptors.indexOf(write), 1);
    return { input, output, stdio: [forwardedRead, write, write], close,
      async releaseInput() {
        // Pausing a Windows TTY can leave a pending native console read. Close
        // that reader before starting the CLI so it cannot steal CLI keystrokes.
        await new Promise(resolve => { input.once("close", resolve); input.destroy(); });
      },
    };
  } catch { close(); }
}
