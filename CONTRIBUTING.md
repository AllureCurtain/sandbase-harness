# Contributing to managed-agents

Thanks for helping make managed-agents better. This project is intentionally a single-package TypeScript runtime, so the local workflow should stay boring and reliable.

## Development Workflow

1. Fork the repository.
2. Create a feature branch from `main`: `git checkout -b feat/my-feature`.
3. Install dependencies: `npm ci`.
4. Make your changes.
5. Run the release checks locally:

```bash
npm run typecheck
npm test
npm run build
```

6. Commit with a conventional commit message.
7. Push and open a pull request against `main`.

## Project Structure

```text
managed-agents/
├── src/
│   ├── api/        # Hono HTTP routes
│   ├── core/       # agents, sessions, events, memory, templates
│   ├── model/      # model provider registry
│   ├── sandbox/    # local, docker, self-hosted sandbox providers
│   ├── strategy/   # execution strategies
│   └── types/      # protocol and runtime types
├── tests/
├── examples/
└── docs/spec/
```

## Checks

The current required checks are:

- `npm run typecheck`
- `npm test`
- `npm run build`

`npm run typecheck` runs two programs: `typecheck:src` for `src/`, and
`typecheck:tests` for the runtime test suite. They are separate because the root
config scopes build output to `src`, and vitest transpiles tests without
checking their types — so a breaking change to an internal interface would
otherwise type-check clean while every test call site was already wrong. Tests
that import Console components are excluded for now; `apps/console` has its own
unchecked type debt, tracked in BACKLOG.md.

`npm run lint` currently aliases type checking. ESLint and Prettier are not configured yet; do not add lint-only requirements to CI until the matching dependencies and config are committed.

## Sandbox Tests That Need External Transports

Some sandbox suites skip unless their backend is reachable, so a green local run
does not necessarily mean they ran.

- Docker: `tests/integration/docker-sandbox.test.ts` skips without a running
  daemon and a locally cached image.
- Kubernetes: `tests/integration/kubernetes-sandbox*.test.ts` skip unless
  `kubectl` can reach a cluster. They create and delete Pods in the target
  namespace, so point them at a throwaway cluster.

Any cluster works. A single-node one is enough:

```bash
kind create cluster --name ma-sandbox-test

# busybox has the /bin/sh, find, and tar the provider needs.
KUBECONFIG=~/.kube/config \
MANAGED_AGENTS_TEST_K8S_NAMESPACE=default \
MANAGED_AGENTS_TEST_K8S_IMAGE=busybox:stable \
  npx vitest run tests/integration/kubernetes-sandbox

kind delete cluster --name ma-sandbox-test
```

If the cluster cannot reach Docker Hub, preload the image into the node's
container runtime and pass its local tag through
`MANAGED_AGENTS_TEST_K8S_IMAGE`. Session Pods are labeled
`app.kubernetes.io/managed-by=managed-agents`, so an interrupted run can be
reaped with:

```bash
kubectl delete pods -l app.kubernetes.io/managed-by=managed-agents
```

## Code Standards

- Keep TypeScript strict-mode clean.
- Prefer existing project patterns over new abstractions.
- Keep public APIs stable unless the change is explicitly API work.
- Add focused tests when changing runtime behavior, protocol handling, sandboxing, or session lifecycle.
- Public documentation should be written in English and stay focused on release-facing project behavior.

## Commit Message Format

```text
<type>(<scope>): <description>

[optional body]
[optional footer]
```

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

## Pull Request Requirements

- All CI checks must pass.
- PR title should follow conventional commit format.
- Keep PRs focused. Large refactors are welcome when they are motivated by a clear boundary or testability improvement.
