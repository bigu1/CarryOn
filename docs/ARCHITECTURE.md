# 规则所在与首版范围

续上的首版目标是找回、整理和交接。原文与资料修订留在 SQLite；卡片是人工概括或模型待核对候选。用户确认概括不等于现实事件被验证。没有模型时核心功能完整可用。

| 规则 | 位置 |
| --- | --- |
| 输入格式、预览、校正、去重 | `importers/`、`server/routes/sources.ts`、`storage/db.ts` |
| 卡片审核、角色依据与历史引用 | `domain/review.ts`、`storage/db.ts` |
| 中文短词、字面符号、范围与分页 | `search/search.ts` |
| 十二类卡片及确定性交接 | `domain/types.ts`、`domain/handoff.ts` |
| 模型范围、预览指纹、预算、迟到结果 | `ai/jobs.ts` |
| HTTP 模型协议、地址、输出与取消 | `ai/client.ts` |
| 删除与备份白名单 | `storage/db.ts`、`storage/backup.ts` |
| 本机 Host / Origin / CSRF 与请求上限 | `server/protect.ts`、`server/app.ts` |
| 页面对照原文、编辑与反馈 | `client/pages/`、`client/ui/` |

十二种卡片保留信息区分，界面按六组组织；本轮没有证据支持减少类型。短交接保留决定、约束、尝试和问题，无法带全的内容明确列出，不静默截断。来源变化后的旧版引用保留历史提示；来源删除则清除正文。

当前不做自动读取其他 AI 私有库、账号、云同步、多人、公网服务、执行聊天命令或手机原生应用。开源仓库发布不改变这个运行边界。
