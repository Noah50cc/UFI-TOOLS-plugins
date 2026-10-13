# UFI-TOOLS 插件合集（飞猫 U20）

自用插件仓库：为**飞猫 U20（新版，展锐平台）**的 Android 宿主编写的
UFI-TOOLS 高级后台网页插件。

> 适用对象：飞猫 U20 高级后台用户。插件通过 UFI-TOOLS 的 `/api/root_shell`
> 等通道执行命令，需要设备已 Root。

## 插件列表

| 插件 | 版本 | 说明 | 状态 |
|---|---|---|---|
| 内存清理 | V2.0.2 | 状态页展示 /proc/meminfo、Swap、ZRAM（压缩比）、SELinux；一键 `sync` + `drop_caches` + `compact_memory`；多路 shell 接口兜底，20 秒超时，非 root 自动禁用按钮 | 待真机验证 |
| 深度清理 | V1.0.2 | 应用缓存清理（`pm trim-caches`，前后 `df /data` 对比）+ 结束无用进程（仅应用 UID，system/root 不碰，UFI-TOOLS 自身进程自动保护，需二次确认） | 待真机验证 |
| Magisk 管理器 | V1.0.0 | 状态检测 / 模块启停 / 卸载 / 重启，走 `/api/root_shell`，不依赖 kano 库的备选方案 | 备选，未真机验证 |
| TProxy | 1.5 刘玥优化版 | Mihomo（猫猫）管理插件：在 1.4 的 7 项修复基础上，新增安装确认框关闭兜底、saveConfig 先备份再校验内核配置、内核路径兼容 mihomo 改名 | 未真机验证；Nikki 路线下暂时用不上 |

## 安装

1. 打开 UFI-TOOLS 高级后台 → 插件管理
2. 导入对应的 `.js` 文件
3. 按插件页面提示操作（清理类插件建议先点"诊断连接"确认通道正常）

## 说明

- 所有插件只针对 U20 的 **Android 宿主**，MiniKano OpenWrt 虚拟机里的东西（如 Nikki）不在此列。
- 新版 U20 确认展锐平台，cpufreq governor 为 `uscfreq`；旧版按高通方案写的推测已作废。
- 温控降温路线已终止：真机验证结论是设备原本干净，无残留、无需恢复，故不收录。

## 版本记录

- 2026-10-10：内存清理 V2.0.2、深度清理 V1.0.2、Magisk 管理器 V1.0.0、TProxy 1.5 首版归档
