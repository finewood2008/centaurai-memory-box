const status = document.getElementById("status");
const refresh = document.getElementById("refresh");

async function showStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: "status" });
    if (!response?.connected) { status.textContent = "尚未连接到 半人马AI 私人记忆盒子。请先打开 半人马AI 私人记忆盒子。"; return; }
    const paused = response.pausedTabCount || 0;
    refresh.textContent = paused ? "重新连接" : "重新检查";
    if (paused) {
      status.textContent = `你关闭了浏览器顶部的调试提示，半人马AI 私人记忆盒子 已停止操作 ${paused} 个网页。点击“重新连接”即可恢复。`;
      return;
    }
    const count = response.controllableTabCount || 0;
    if (count) {
      status.textContent = `已连接到 半人马AI 私人记忆盒子，${count} 个网页可以操作。半人马AI 私人记忆盒子 执行任务时浏览器顶部会显示调试提示，任务结束后自动消失。`;
      return;
    }
    const issue = response.tabStatuses?.find(tab => tab.status === "protected") || response.tabStatuses?.[0];
    status.textContent = `已连接到 半人马AI 私人记忆盒子，当前没有可操作网页。${issue?.reason || "请打开普通网页后重新检查。"}`;
  } catch { status.textContent = "尚未连接到 半人马AI 私人记忆盒子。请先打开 半人马AI 私人记忆盒子。"; }
}

refresh.addEventListener("click", async () => {
  refresh.disabled = true; status.textContent = "正在检查浏览器页面…";
  try {
    const response = await chrome.runtime.sendMessage({ action: "refresh" });
    if (response?.ok) await showStatus();
    else status.textContent = response?.error || "无法重新连接，请确认 半人马AI 私人记忆盒子 已打开。";
  } catch { status.textContent = "无法重新连接，请确认 半人马AI 私人记忆盒子 已打开。"; }
  finally { refresh.disabled = false; }
});
void showStatus();
