# CarryOn · 隐私与署名复核

日期：2026-10-09，`1.0.0-beta.3`。

## 公开内容

复核范围为所有 Git 跟踪文件、全部公开提交、发布附件和文档截图。真实本机数据目录没有读取、迁移或上传。公开树只包含源码、配置、测试、明确标注的合成材料和文档；不包含运行库、私人聊天、模型凭据、日志缓存或原工程私人 Git 历史。

公开文本检索没有发现私人机器路径、个人邮箱或原私人远程地址。测试里的 `apiKey`、`Authorization`、`synthetic@example.invalid`、故障域名和假凭据是合成输入或代码字段，不是使用者的真实配置。文档图片来自隔离浏览器测试，正文为合成资料，PNG 不携带私人图片来源。

发布前运行跟踪文件门禁、Gitleaks 的源码与公开历史扫描，并匿名下载发布附件进行 SHA-256 和逐文件核对。扫描结果未发现凭据泄漏；扫描不能保证未知问题为零。发现新泄漏请按 [SECURITY.md](../SECURITY.md) 私下报告，勿把秘密贴到公开 Issue。

## 正确归属与 noreply

仓库所有者和版权署名为公开账号 **bigu1**。上一版通用的 `Xushang contributors` 是发布时设置的 Git 提交身份，不是另一位参与者的证明。由发布代理创建的两笔公开提交已纠正归属；原本机仓库历史不重写。

GitHub 依据提交邮箱关联账户。公开提交使用本账号的 GitHub 提供的隐私地址，格式为 `ID+USERNAME@users.noreply.github.com`。其中 `noreply` 表示不接收邮件的地址类型，不表示账号由另一个叫 noreply 的人拥有；真实邮箱不需要公开。参见 [GitHub 邮箱说明](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)。

许可证版权行使用 `bigu1`。GitHub 的 Contributors 列表属于平台依据提交生成的统计，不是项目共同所有权声明；统计刷新可能晚于提交作者关联。

## 品牌与兼容标识

英文品牌 **CarryOn**，中文名 **续上**。页面、README、服务标识、包名和最新发行一致。保留的 `xushang.db`、`xushang-backup`、Cookie、CSRF 头和 `XUSHANG_*` 是已有数据和协议的兼容名称。没有为改名而读取私人库、修改全局设置或重启使用者实例。

## 验证边界

81 项集成回归、14 项浏览器测试，类型检查和构建通过；三视口截图已更新为 CarryOn。真实模型 A05–A10、私人聊天价值实验及 Linux 启停现场仍未验证。本次更名和署名修正不扩大这些授权。
