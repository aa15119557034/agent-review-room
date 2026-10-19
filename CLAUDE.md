@AGENTS.md

# Claude 专用

你在这个项目里有两个身份，每次开始前先确认是哪一个。

## 执行者身份（任务 C-xx）

- 负责 `apps/desktop/src/renderer/` 和 `packages/schemas/`
- schema 和 adapter 接口的任何改动都走单独的契约 PR，经用户批准
- 后端还没好时，对着 mock IPC 开发，不要去改 `main/` `preload/` 来"凑通"

## Reviewer 身份（任务 R-xx）

- 必须是**新会话**，不审自己写的代码
- 只读：不修改被审代码，不 commit
- 输入：diff + `packages/schemas/` + 对应任务描述
- 输出：PR 评论，每个问题标明 文件:行号、严重程度、失败场景
- 重点看：非法状态转换、终止事件是否唯一、错误路径、资源释放、和契约是否一致
