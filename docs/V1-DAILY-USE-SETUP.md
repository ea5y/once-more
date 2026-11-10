# 日常试用环境整理

2026-10-24，用户已授权执行，录音来源明确选择留空，首次使用时配置；输出保留Downloads。

已完成：
- 构建正式标识app.oncemore.desktop最新应用，复制至.local/daily-use/Once More.app。
- 正式数据快照备份至.local/archives/daily-reset-2026-10-24，包括SQLite一致性备份（integrity_check通过、33条）、模型及工作目录。manifest.json记录原设置。
- 原始录音、提取文件和之前的备份均未删除。

尚未执行：
- 当前正式应用仍在运行，桌面控制连续超时，已请用户手动⌘Q退出。
- 退出确认后再归档原活动数据目录，创建空库，保留已下载模型、输出Downloads及停顿参数6秒；录音来源留空。
- 随后启动.local/daily-use/Once More.app核对空记录、空任务、配置和模型状态。

当前快照不代表活动数据库已切换。不得在未退出时覆盖活动数据库。

## 执行结果

用户确认退出后，进程核查已无Once More。原活动目录完整改名为：
/Users/luwanzhong/Library/Application Support/app.oncemore.desktop.archive-2026-10-24

新活动库已创建：0条片段，来源留空，输出/Users/luwanzhong/Downloads，停顿6秒。模型复制保留，SHA256核对一致，数据库完整性通过。未删除录音与提取文件。

新版启动工具仍超时，无法取得最终窗口截图；数据库结果已核验，UI实看未完成。日常入口为.local/daily-use/Once More.app。旧包尚未删除，避免打开旧版本写回示例。恢复时须退出应用，先归档新产生的数据，再恢复原目录，不能直接覆盖试用期间的新记录。

### 后续核对

2026-10-24再次连接日常版窗口仍超时。只读复核：正式库0条、队列0项、来源未设置、输出Downloads、参数6秒；日常版标识app.oncemore.desktop，可执行文件哈希与最新正式构建一致。不能据此将窗口视觉检查标为通过。待用户确认新版窗口显示全部0/收藏0、来源未选择、输出Downloads，并在“本地转写准备”看到已就绪。
