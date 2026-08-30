# SandBase Harness 场景展示

当 Agent 需要持久化运行时边界，而不只是一次模型请求时，SandBase
Harness 可以从下面三个场景开始使用。

## 发现和验证项目

- [当前版本：v0.3.8](https://github.com/sandbaseai/sandbase-harness/releases/tag/v0.3.8)
- [官方 MCP Registry 条目](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.sandbaseai%2Fsandbase-harness)
- [已验证的 dshbase 条目](https://dshbase.com/plugins/sandbase-harness/)
- [SandBase Agent Runtime 生态地图](https://github.com/sandbaseai/awesome-agent-runtime)

## 1. 可审计的 Coding Agent

使用持久化会话、事件流、产物、快照和回放，检查长时间运行的 Agent 做过
什么。

```bash
node ../sandbase-harness/dist/index.js init
node ../sandbase-harness/dist/index.js start
```

打开 `http://127.0.0.1:3000/dashboard`，创建 Agent 并启动会话。在 Console
时间线或会话事件接口中查看工具调用、工具结果、状态变化和 token 用量。

适合：编码辅助、研究任务、文档生成，以及需要人工审核或恢复的工作流。

## 2. 把 DeepSeek Harness 作为前端

将 Harness 作为独立的托管 Agent Runtime 运行，再通过内置 stdio MCP Bridge
连接 DeepSeek Harness。DSH 可以调用 Agent 列表、创建会话、运行流式回合、
查看产物和取消任务。

完整步骤见[DeepSeek Harness 集成示例](../examples/deepseek-harness/README.md)。
当前版本为 v0.3.8；跨平台安装请使用 HTTPS Git 地址。

## 3. 受控执行生成代码

按照信任边界选择沙箱：

| 场景 | Provider | 边界 |
| --- | --- | --- |
| 可信本地开发 | `local` | 当前操作系统用户；没有隔离 |
| 不可信或模型生成代码 | `docker` | 每会话容器和资源限制 |
| 集群托管任务 | `kubernetes` | Pod 与 RBAC 边界 |
| 独立执行服务 | `self_hosted` / `remote` | Worker 队列和异机执行 |

对外提供服务前，请开启 Bearer 认证，使用持久化数据目录，在 TLS 反向代理
后运行，并将模型凭据放入环境变量或密钥管理器。参见[部署示例](deployment.md)。

## 反馈问题时请提供

请提供 Harness、Node.js、操作系统、模型 Provider、沙箱 Provider、相关接口或
命令，以及完整错误信息。请删除 API Key、凭据、个人路径和私有会话内容。

参考：[安装](installation.md)、[使用指南](usage.md)、[DeepSeek Harness 集成](../examples/deepseek-harness/README.md)、
[GitHub Discussions](https://github.com/sandbaseai/sandbase-harness/discussions)。
