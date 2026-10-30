---
name: docker
description: Debugging Docker containers (crashes, restarts, networking, volumes) and writing Dockerfiles and compose files.
---

# Docker: debugging containers and writing Dockerfiles

Tools: `docker_ps`, `docker_logs` and `docker_inspect` only read. `docker_compose` starts and stops things, so it asks first. Commands that delete (`docker rm`, `docker rmi`, `docker system prune`, `docker volume rm`, `compose down -v`) always ask for confirmation through `bash`; only suggest them when the user wants data gone.

## Debugging a container

Work from the outside in:

1. `docker_ps` with `all: true`. Look at the status: `Exited (1)`, `Restarting`, `(unhealthy)`.
2. `docker_logs` with `tail: 200`. The last lines before an exit usually name the problem. Add `since: "10m"` for busy containers.
3. `docker_inspect` the container: `State.ExitCode`, `State.OOMKilled`, `State.Health`, `RestartCount`, `Config.Env`, `Mounts`, `NetworkSettings.Ports`.

Common exit codes:
- `0`: the main process finished. A container lives only as long as its PID 1; a server started in the background (`service x start`, `&`) leaves nothing in the foreground.
- `1` / `2`: the app failed. Read the logs.
- `126` / `127`: the command isn't executable or wasn't found. Check `CMD`/`ENTRYPOINT`, the shebang, Windows line endings in scripts, and missing `chmod +x`.
- `137`: killed (SIGKILL), often out of memory (`OOMKilled: true`) or a stop timeout.
- `139`: segfault, often an image built for another CPU (arm64 vs amd64). Check `--platform`.
- `143`: SIGTERM. A normal stop.

Networking:
- Inside a container, `localhost` is the container itself. Reach another compose service by its service name (`db:5432`), and the host by `host.docker.internal` (Docker Desktop; on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]`).
- A server must listen on `0.0.0.0`, not `127.0.0.1`, to be reachable through a published port.
- `ports: "8080:80"` is host:container.

Volumes and files:
- A bind mount hides whatever the image had at that path (a common cause of "node_modules missing").
- Permission errors on bind mounts on Linux: the container user's uid differs from the host's. Match it with `user:` or fix ownership.

## Writing a Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

- Pin a base image version (`node:22-slim`, `python:3.12-slim`), not `latest`.
- Copy dependency manifests and install before copying the source, so code edits don't redo the install.
- Use multi-stage builds to keep compilers and dev dependencies out of the final image.
- Write `CMD`/`ENTRYPOINT` in exec form (JSON array) so signals reach the app and it stops cleanly.
- Run as a non-root user where the image has one.
- Add a `.dockerignore` with `.git`, `node_modules`, build output and `.env` files. Never bake secrets into an image.
- Combine `apt-get update && apt-get install -y --no-install-recommends ... && rm -rf /var/lib/apt/lists/*` in one `RUN`.

## Writing a compose file

```yaml
services:
  web:
    build: .
    ports: ["3000:3000"]
    environment:
      DATABASE_URL: postgres://app:app@db:5432/app
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
    volumes: [db-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes:
  db-data:
```

- The file is `compose.yaml` (or `docker-compose.yml`); the top-level `version:` key is obsolete.
- `depends_on` only orders startup. Add a `healthcheck` and `condition: service_healthy` when a service must wait for another to be ready.
- Keep secrets in an `.env` file next to the compose file (and out of git), referenced as `${VAR}`.
- After editing, `docker_compose` with `action: up` rebuilds what changed. Then check `docker_compose` `ps` and `docker_logs`.
