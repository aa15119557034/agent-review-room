# @room/reviewer-client — 负责：DeepSeek ｜ 审查：Claude
调用 Reviewer API（D-05）。只发送 snapshot.content 原文；发送前重新计算 hash，不一致就拒绝发送。
