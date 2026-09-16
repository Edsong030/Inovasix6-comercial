# Inovasix6 Comercial IA

Plataforma comercial para centralizar CRM, leads, follow-ups, agenda e dashboard em um backend multi-tenant com autenticação segura, RBAC e isolamento de dados por Row Level Security (RLS) no PostgreSQL.

> Este README descreve o estado atual do código da branch `main`. Funcionalidades mockadas ou apenas estruturadas estão marcadas como tal — nada aqui é aspiracional.

---

## Sumário

1. [Resumo](#resumo)
2. [Status](#status)
3. [Visão do produto](#visão-do-produto)
4. [Funcionalidades](#funcionalidades)
5. [Arquitetura](#arquitetura)
6. [Stack tecnológica](#stack-tecnológica)
7. [Estrutura do repositório](#estrutura-do-repositório)
8. [Segurança e multi-tenancy](#segurança-e-multi-tenancy)
9. [Pré-requisitos](#pré-requisitos)
10. [Instalação](#instalação)
11. [Configuração de ambiente](#configuração-de-ambiente)
12. [Banco de dados / Prisma](#banco-de-dados--prisma)
13. [Executando localmente](#executando-localmente)
14. [Swagger / documentação da API](#swagger--documentação-da-api)
15. [Testes](#testes)
16. [Qualidade](#qualidade)
17. [CI](#ci)
18. [Fluxo de desenvolvimento](#fluxo-de-desenvolvimento)
19. [Troubleshooting](#troubleshooting)
20. [Estrutura preparada (não implementada)](#estrutura-preparada-não-implementada)

---

## Resumo

Monorepo npm com dois workspaces:

- **`apps/api`** — backend NestJS (TypeScript) expondo uma API REST em `/api`, com Prisma/PostgreSQL, autenticação JWT (access + refresh), RBAC e isolamento multi-tenant reforçado por RLS no banco.
- **`apps/web`** — frontend Next.js 15 (App Router, React 19) que consome a API acima para autenticação, CRM/leads, follow-ups, agenda e dashboard.

## Status

Última validação local, na branch `feature/rbac-leads`:

| Etapa | Resultado |
|---|---|
| Geração do Prisma Client | OK |
| Typecheck (`api` e `web`) | PASS |
| Testes | 140 aprovados, 0 falhas (API: 12 suites / 113 testes · Web: 5 suites / 27 testes) |
| Build (Nest + Next.js) | PASS (Next.js gerou 13/13 páginas estáticas) |
| CI (GitHub Actions) | aprovado |

Esses números refletem os testes **unitários** (`npm test`, o que a etapa `Test` do CI executa). A API também tem suítes de integração e um config de e2e — ver [Testes](#testes) para o que já existe e o que ainda depende de infraestrutura externa.

## Visão do produto

O Inovasix6 Comercial IA nasceu para reduzir tarefas manuais na operação comercial, conectando lead → qualificação → CRM → follow-up → negociação → venda em um único ambiente. Esta seção descreve a intenção de produto; a próxima seção diferencia o que já existe em código do que é apenas direção futura.

## Funcionalidades

Convenção usada abaixo:
- **Implementado** — endpoint(s)/tela com lógica de negócio real, testado.
- **Parcial** — existe endpoint/tela real, mas cobre só parte do fluxo (ex.: RBAC granular só em um módulo).
- **Preparado** — módulo/rota criada como esqueleto (`@Module({})` vazio ou tela com dado mockado), sem lógica de negócio.

| Capacidade | Estado | Onde |
|---|---|---|
| Autenticação (login por tenant/e-mail/senha, refresh, logout, logout-all) | Implementado | [`apps/api/src/modules/auth`](apps/api/src/modules/auth) |
| Leads / CRM (listar, criar, atualizar, mover de etapa, paginação/busca) | Implementado | [`apps/api/src/modules/leads`](apps/api/src/modules/leads), tela [`apps/web/components/crm/CrmBoard.tsx`](apps/web/components/crm/CrmBoard.tsx) |
| Pipelines (listagem com etapas ordenadas) | Implementado | [`apps/api/src/modules/pipelines`](apps/api/src/modules/pipelines) |
| Follow-ups (criar, listar, concluir, cancelar, reagendar, "hoje"/"atrasados") | Implementado | [`apps/api/src/modules/followups`](apps/api/src/modules/followups), tela [`apps/web/components/followups/FollowupsView.tsx`](apps/web/components/followups/FollowupsView.tsx) |
| Agenda / Calendar (criar, listar, atualizar, concluir, cancelar eventos) | Implementado | [`apps/api/src/modules/calendar`](apps/api/src/modules/calendar), tela [`apps/web/components/agenda/AgendaView.tsx`](apps/web/components/agenda/AgendaView.tsx) |
| Dashboard comercial (métricas, funil, follow-ups/agenda do dia, atividade recente) | Implementado | [`apps/api/src/modules/dashboard`](apps/api/src/modules/dashboard), telas em [`apps/web/components/dashboard`](apps/web/components/dashboard) |
| RBAC (guard + decorator `@Roles`) | Parcial | mecanismo genérico em [`apps/api/src/modules/auth/roles.guard.ts`](apps/api/src/modules/auth/roles.guard.ts), hoje aplicado só nas rotas de **Leads**; Pipelines/Follow-ups/Agenda/Dashboard exigem apenas login (`JwtAuthGuard`), sem restrição por papel ainda |
| Multi-tenancy + RLS | Implementado | ver [Segurança e multi-tenancy](#segurança-e-multi-tenancy) |
| Health check (`GET /api/health`) | Implementado | [`apps/api/src/health`](apps/api/src/health) |
| Inbox (conversas WhatsApp/IA) | Preparado (UI com dado mockado) | [`apps/web/components/inbox/InboxView.tsx`](apps/web/components/inbox/InboxView.tsx) lê de [`lib/mock/data.ts`](apps/web/lib/mock/data.ts); backend (`Conversations`, `Messages`, `Whatsapp`, `Ai`) são módulos NestJS vazios |
| Base de conhecimento (Knowledge) | Preparado (UI com dado mockado) | [`apps/web/components/knowledge/KnowledgeView.tsx`](apps/web/components/knowledge/KnowledgeView.tsx); backend (`Knowledge`) é módulo vazio |
| Gestão de equipe (Team) | Preparado (UI com dado mockado) | [`apps/web/components/team/TeamView.tsx`](apps/web/components/team/TeamView.tsx) — comentário no próprio código confirma que não há endpoint de usuários ainda; backend (`Users`) é módulo vazio |
| Settings | Preparado (UI estática) | [`apps/web/components/settings/SettingsView.tsx`](apps/web/components/settings/SettingsView.tsx), sem integração com API além de `useAuth` |
| Automações comerciais / IA / integrações externas | Planejado | módulos `apps/api/src/modules/{ai,integrations,files,audit,tenants,contacts}` existem só como `@Module({})` vazio, sem controller/service |

## Arquitetura

```
┌─────────────────┐        HTTPS / fetch          ┌──────────────────────┐
│  apps/web        │ ─────────────────────────────▶│  apps/api             │
│  Next.js 15 (App │   Bearer access token +        │  NestJS 11            │
│  Router, React19)│   cookie HttpOnly (refresh)    │  /api/*                │
└─────────────────┘ ◀───────────────────────────── └──────────┬───────────┘
                                                                │ Prisma Client
                                                                │ (SET LOCAL app.current_tenant_id)
                                                                ▼
                                                     ┌──────────────────────┐
                                                     │  PostgreSQL           │
                                                     │  RLS FORCE por tabela │
                                                     └──────────────────────┘
```

- O backend expõe todas as rotas sob o prefixo global `/api` (`app.setGlobalPrefix('api')` em [`apps/api/src/main.ts`](apps/api/src/main.ts)).
- O acesso ao Prisma é centralizado em [`PrismaService`](apps/api/src/prisma/prisma.service.ts): módulos de negócio nunca instanciam `PrismaClient` diretamente; consultas tenant-scoped rodam via `runWithTenant()`, que abre uma transação e executa `SET LOCAL app.current_tenant_id` **na mesma conexão** antes das queries — condição necessária para a RLS do Postgres funcionar corretamente com connection pooling.
- O frontend não guarda o access token em `localStorage`: ele fica em memória (ver [`lib/auth/token-store.ts`](apps/web/lib/auth/token-store.ts)); o refresh token viaja só em cookie `HttpOnly`/`SameSite=Strict` restrito a `/api/auth`.

## Stack tecnológica

**Backend (`apps/api`)** — NestJS 11, Prisma 6 (`@prisma/client`), PostgreSQL, `@nestjs/jwt`, `@nestjs/throttler`, `@nestjs/swagger` + `swagger-ui-express`, `helmet`, `argon2` (hash de senha), `class-validator`/`class-transformer`, `joi` (validação de env), `nestjs-pino` (logs estruturados com redaction), `cookie-parser`. Testes com Jest + `ts-jest` + Supertest.

**Frontend (`apps/web`)** — Next.js 15 (App Router), React 19, TypeScript, CSS Modules. Sem biblioteca de state management ou data-fetching externa: `fetch` nativo encapsulado em [`lib/auth/api.ts`](apps/web/lib/auth/api.ts) e [`lib/api/resources.ts`](apps/web/lib/api/resources.ts).

**Infra local** — `docker-compose.yml` sobe apenas `postgres` (imagem `pgvector/pgvector:pg16`) e `redis:7-alpine`. Node.js `>=22`, npm `>=10` (ver `engines` em [`package.json`](package.json)).

> Observação sobre o Redis: a variável `REDIS_URL` é validada e obrigatória no boot ([`env.validation.ts`](apps/api/src/config/env.validation.ts)), e o serviço sobe no `docker-compose`, mas nenhum módulo do backend hoje o usa para cache/fila — é infraestrutura provisionada, ainda sem consumidor no código.

## Estrutura do repositório

```
Inovasix6-comercial/
├── apps/
│   ├── api/                       # Backend NestJS
│   │   ├── prisma/
│   │   │   ├── schema.prisma      # Modelos: Tenant, User, Role, Lead, Pipeline, FollowUp, CalendarEvent, ...
│   │   │   ├── migrations/        # Inclui a migration que ativa RLS em todas as tabelas tenant-owned
│   │   │   └── seed.ts            # Seed de desenvolvimento (idempotente, nunca roda em produção)
│   │   ├── src/
│   │   │   ├── common/tenant/     # TenantContext, guard e serviço anti-IDOR (404 para "não existe" e "de outro tenant")
│   │   │   ├── config/            # AppConfigService + validação Joi das env vars
│   │   │   ├── health/            # GET /api/health
│   │   │   ├── prisma/            # PrismaService (runWithTenant / RLS)
│   │   │   └── modules/
│   │   │       ├── auth/          # login, refresh, logout, JwtAuthGuard, RolesGuard
│   │   │       ├── leads/         # Implementado + RBAC
│   │   │       ├── pipelines/     # Implementado
│   │   │       ├── followups/     # Implementado
│   │   │       ├── calendar/      # Implementado
│   │   │       ├── dashboard/     # Implementado
│   │   │       └── ai|audit|contacts|conversations|files|integrations|knowledge|messages|tenants|users|whatsapp/
│   │   │                          # Módulos vazios (@Module({})) — ver "Estrutura preparada"
│   │   ├── docs/auth.md           # Design detalhado do fluxo de autenticação
│   │   └── test/                  # Suítes de integração (RLS, auth, leads, follow-ups, agenda) + config de e2e
│   └── web/                       # Frontend Next.js
│       ├── app/(app)/             # Rotas autenticadas: page (dashboard), crm, leads, followups, agenda, inbox, knowledge, team, settings
│       ├── app/login/             # Tela de login
│       ├── components/            # Um diretório por área (dashboard, crm, followups, agenda, inbox, knowledge, team, settings, ui)
│       └── lib/                   # auth/ (token store, api client, contexto) e api/ (client de recursos + tipos)
├── infra/postgres/                # Scripts SQL de provisionamento de roles, grants e RLS (ver seção de segurança)
├── docker-compose.yml             # Postgres + Redis apenas
├── .github/workflows/ci.yml       # Pipeline de CI
└── package.json                   # Workspaces npm (apps/*)
```

## Segurança e multi-tenancy

Mecanismos confirmados em código (não é uma lista de intenções):

- **JWT access + refresh**: `TokenService` ([`apps/api/src/modules/auth/token.service.ts`](apps/api/src/modules/auth/token.service.ts)) assina o access token com `JWT_ACCESS_SECRET` (claims `sub`, `tenantId`, `roleCodes`, `sessionId`) e o refresh com `JWT_REFRESH_SECRET` (+ `jti` aleatório). Só o **hash SHA-256** do refresh token é persistido em `auth_sessions`, nunca o token em si.
- **Cookie do refresh token**: `HttpOnly`, `SameSite=Strict`, `Secure` em produção, escopado a `path=/api/auth`. O access token nunca vai para cookie; o frontend o mantém em memória.
- **`JwtAuthGuard`**: valida o Bearer token e popula `request.tenantContext` **somente** a partir das claims assinadas — nunca de body/query/header arbitrários (ver comentário de invariante em [`tenant-context.ts`](apps/api/src/common/tenant/tenant-context.ts)).
- **RBAC**: `RolesGuard` + decorator `@Roles(...)` checam os `roleCodes` do token contra os papéis exigidos pela rota. Papéis existentes no schema: `ADMIN`, `GESTOR`, `COMERCIAL`, `ATENDENTE`. Hoje aplicado apenas ao módulo **Leads** (ver tabela de funcionalidades).
- **Isolamento multi-tenant em duas camadas**:
  1. **Aplicação** — todo predicado de query inclui `tenantId`; `TenantResourceService.assertBelongsToTenant()` responde **404** tanto para recurso inexistente quanto para recurso de outro tenant, de propósito, para não permitir enumeração de IDs (nunca 403).
  2. **Banco** — migration `20260908194359_add_multi_tenant_rls` habilita `ENABLE`/`FORCE ROW LEVEL SECURITY` em todas as tabelas com `tenant_id` e cria políticas `USING/WITH CHECK tenant_id = current_setting('app.current_tenant_id', true)::uuid`. Sem contexto de tenant definido, o predicado falha fechado (zero linhas).
  3. Chaves estrangeiras compostas `[tenantId, id]` (ex.: `Lead.owner`, `FollowUp.lead`) impedem, a nível de schema, que um registro filho referencie um pai de outro tenant.
- **Três papéis de banco** ([`infra/postgres/README.md`](infra/postgres/README.md)): `inovasix_owner` (DDL/migrations, `NOBYPASSRLS`), `inovasix_app` (runtime, DML mínimo, `NOBYPASSRLS`) e `inovasix_auth_definer` (único papel com `BYPASSRLS`, `NOLOGIN`, dono apenas da função `auth_lookup_login()` usada para resolver o login antes de existir um contexto de tenant).
- **Helmet** aplicado globalmente (`app.use(helmet())`).
- **Rate limiting**: `ThrottlerModule` global (120 req/60s) e um limite mais estrito de 5 tentativas/60s especificamente em `POST /auth/login`.
- **Validação de entrada**: `ValidationPipe` global com `whitelist`, `forbidNonWhitelisted` e `transform` habilitados; DTOs usam `class-validator`.
- **Secrets**: validados via Joi no boot (`env.validation.ts`) — em produção, `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` são obrigatórios, com no mínimo 32 caracteres, e não podem ser iguais entre si; em desenvolvimento/teste aceitam um default local. Nenhum secret é logado — `nestjs-pino` redige `authorization`, `cookie`, `password`, `passwordHash`, tokens e `DATABASE_URL`/`REDIS_URL` dos logs.

## Pré-requisitos

- Node.js `>= 22` e npm `>= 10` (ver `engines` em [`package.json`](package.json))
- Docker + Docker Compose (para Postgres/Redis locais) — ou uma instância PostgreSQL acessível
- Acesso a um shell capaz de rodar `psql` para os scripts de provisionamento em `infra/postgres/`

## Instalação

```bash
git clone https://github.com/Edsong030/Inovasix6-comercial.git
cd Inovasix6-comercial
npm ci
```

`npm ci` instala as dependências dos dois workspaces (`apps/api`, `apps/web`) a partir do `package-lock.json` da raiz.

## Configuração de ambiente

Copie os exemplos e preencha com valores locais — nunca commite `.env`:

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
```

### Raiz (`.env`) — consumido pela API e pelo `docker-compose.yml`

| Variável | Aplicação | Obrigatória | Finalidade |
|---|---|---|---|
| `POSTGRES_DB` | docker-compose | Sim | Nome do banco criado pelo container Postgres |
| `POSTGRES_USER` | docker-compose | Sim | Usuário do container Postgres |
| `POSTGRES_PASSWORD` | docker-compose | Sim | Senha do container Postgres |
| `POSTGRES_PORT` | docker-compose | Não (default `5432`) | Porta exposta do Postgres |
| `REDIS_PORT` | docker-compose | Não (default `6379`) | Porta exposta do Redis |
| `API_PORT` | api | Não (default `3001`) | Porta HTTP da API |
| `WEB_ORIGIN` | api | Sim | Lista de origens (separadas por vírgula) liberadas no CORS |
| `DATABASE_URL` | api (runtime) | Sim | Connection string usada pela API — deve apontar para o papel `inovasix_app` (RLS reforçada) |
| `DATABASE_URL_OWNER` | migrations | Sim | Connection string para `prisma migrate` — papel `inovasix_owner` |
| `DATABASE_URL_APP` | testes de integração | Sim (para `test:integration`) | Conexão como `inovasix_app`, para exercitar a RLS de verdade nos testes |
| `REDIS_URL` | api | Sim | Validada e exigida no boot; hoje sem consumidor no código (ver nota na seção Stack) |
| `JWT_ACCESS_SECRET` | api | Sim (obrigatória e forte em produção) | Chave de assinatura do access token |
| `JWT_REFRESH_SECRET` | api | Sim (obrigatória, forte e diferente da anterior em produção) | Chave de assinatura do refresh token |
| `LOG_LEVEL` | api | Não (default `info`) | Nível de log do Pino |
| `NODE_ENV` | api | Não (default `development`) | `development` \| `test` \| `production` |
| `SEED_ADMIN_PASSWORD` | seed (`apps/api/prisma/seed.ts`) | Sim, só para rodar o seed | Senha do usuário admin de demonstração criado pelo seed |

### `apps/web/.env.local`

| Variável | Aplicação | Obrigatória | Finalidade |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | web | Não (default `http://localhost:3001`) | Origem da API Nest; precisa constar em `WEB_ORIGIN` da API para as requisições com cookie funcionarem |

Nenhum valor de exemplo acima é uma credencial real — todos são placeholders.

## Banco de dados / Prisma

O schema (`apps/api/prisma/schema.prisma`) e as migrations vivem em `apps/api/prisma/`. Fluxo completo, incluindo os três papéis de banco e a RLS, está documentado com o passo a passo autoritativo em [`infra/postgres/README.md`](infra/postgres/README.md); resumo para um ambiente local novo:

```bash
# 1. Sobe Postgres + Redis
docker compose up -d

# 2. Gera o Prisma Client (necessário após clone/checkout ou mudança de schema)
npm run prisma:generate --workspace=@inovasix-flow/api

# 3. Provisiona os papéis de banco (inovasix_owner / inovasix_app / inovasix_auth_definer)
psql -h localhost -U <admin> -d inovasix_flow \
  -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -v owner_createdb=CREATEDB \
  -f infra/postgres/provision-roles.sql

# 4. Roda as migrations como owner (cria tabelas, ativa RLS e a função de login)
DATABASE_URL="$DATABASE_URL_OWNER" npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

# 5. Ownership + grants de mínimo privilégio para inovasix_app
psql -h localhost -U <admin> -d inovasix_flow -f infra/postgres/configure-ownership-and-grants.sql

# 6. Ativa a função de login (SECURITY DEFINER) — sem este passo o login retorna 0 linhas
psql -h localhost -U <admin> -d inovasix_flow -f infra/postgres/configure-auth-definer.sql

# 7. (opcional) Seed de demonstração — nunca roda em NODE_ENV=production
SEED_ADMIN_PASSWORD="uma-senha-local" npm run seed:dev --workspace=@inovasix-flow/api
```

O seed cria o tenant `inovasix-demo`, um admin (`edson@demo.local`), um pipeline "Comercial" com 7 etapas e leads fictícios — útil para o CRM e o Dashboard renderizarem dados reais sem depender de cadastro manual.

## Executando localmente

Backend e frontend rodam como processos independentes (o script `dev` da raiz executa os workspaces em sequência, então para os dois ao mesmo tempo use dois terminais):

```bash
# terminal 1 — API em http://localhost:3001 (rotas sob /api)
npm run dev --workspace=@inovasix-flow/api

# terminal 2 — Web em http://localhost:3000
npm run dev --workspace=@inovasix-flow/web
```

## Swagger / documentação da API

A API expõe OpenAPI/Swagger em **`/api/docs`** (ex.: `http://localhost:3001/api/docs`), configurado em [`apps/api/src/main.ts`](apps/api/src/main.ts) com autenticação Bearer habilitada na UI, permitindo testar rotas protegidas diretamente pelo navegador após um login.

O design detalhado do fluxo de autenticação (cookies, rotação de refresh token, etc.) está em [`apps/api/docs/auth.md`](apps/api/docs/auth.md).

## Testes

```bash
npm test                       # unitário: todos os workspaces (é o que o CI roda)
npm run test:integration --workspace=@inovasix-flow/api   # requer Postgres com RLS provisionada (DATABASE_URL_APP)
npm run test:e2e --workspace=@inovasix-flow/api            # config Jest dedicada (jest.e2e.json); nenhum arquivo *.e2e-spec.ts existe hoje
```

- **Unitários** — `apps/api` usa `jest --runInBand` sobre `src/**/*.spec.ts` (12 suites); `apps/web` usa `jest --passWithNoTests` sobre os `*.spec.ts` de `lib/` e `components/` (5 suites). Total validado: **140 testes, 0 falhas**.
- **Integração** (`apps/api/test/*.integration-spec.ts`) — cobrem auth, leads, follow-ups, agenda e a RLS propriamente dita (ver [`apps/api/test/rls.integration-spec.ts`](apps/api/test/rls.integration-spec.ts) e o plano em [`apps/api/test/RLS-INTEGRATION-PLAN.md`](apps/api/test/RLS-INTEGRATION-PLAN.md)). Precisam de um banco real conectado como `inovasix_app` (`DATABASE_URL_APP`) — **não fazem parte do job de CI atual**.
- **E2e** — existe config (`apps/api/test/jest.e2e.json`) e o script `test:e2e`, mas nenhum arquivo `*.e2e-spec.ts` foi encontrado no repositório; é infraestrutura de teste preparada, sem suítes ainda.

## Qualidade

Sequência completa de validação usada localmente e no CI:

```bash
npm run prisma:generate --workspace=@inovasix-flow/api   # gera os tipos do Prisma Client a partir do schema
npm run lint       --workspaces --if-present              # ESLint em api e web
npm run typecheck  --workspaces --if-present              # tsc --noEmit em api e web
npm run test       --workspaces --if-present               # suítes unitárias (Jest) em api e web
npm run build      --workspaces --if-present                # nest build + next build
```

- **Prisma generate** garante que os tipos usados por controllers/services/DTOs existam antes de qualquer checagem de tipo.
- **Lint** aplica as regras ESLint (flat config, `eslint.config.mjs`) de cada workspace.
- **Typecheck** roda `tsc --noEmit` isoladamente em `apps/api` e `apps/web`.
- **Test** executa as suítes unitárias descritas acima.
- **Build** compila o backend (`nest build`, saída em `apps/api/dist`) e gera o build de produção do frontend (`next build`).

## CI

O workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) roda em todo `pull_request` e em `push` para `main`, em um único job (`quality`, `ubuntu-latest`, Node 24):

```
npm ci
  → prisma:generate (workspace @inovasix-flow/api)
  → lint
  → typecheck
  → test
  → build
```

Isto é **CI (integração/validação contínua)**: garante que o código instala, gera os tipos do Prisma, passa no lint/typecheck/testes unitários e builda. **Não há etapa de deploy (CD)** neste workflow — nenhum job publica artefato, imagem ou faz deploy para qualquer ambiente.

## Fluxo de desenvolvimento

- Branch atual de trabalho neste snapshot: `feature/rbac-leads`; a branch de integração é `main`.
- Histórico de commits segue o padrão Conventional Commits (`feat(escopo): descrição`), como em `feat(crm): integra leads e pipeline com backend`.
- Fluxo recomendado: branch a partir de `main` → commits pequenos e no padrão acima → PR contra `main` → CI (`quality`) precisa passar antes do merge.

## Troubleshooting

**Tipos do Prisma "somem" depois de `npm ci` ou de alterar o schema**
Sintomas: erros de typecheck/build citando enums ou propriedades de model do Prisma que "não existem" (ex.: `Property 'lead' does not exist on type 'PrismaClient'`). O Prisma Client é gerado a partir do schema e não é commitado — regenere:
```bash
npm run prisma:generate --workspace=@inovasix-flow/api
```

**Login retorna vazio/erro mesmo com dados no banco**
A função `auth_lookup_login()` só funciona depois que `infra/postgres/configure-auth-definer.sql` transfere sua ownership para o papel `inovasix_auth_definer` (o único com `BYPASSRLS`). Se esse passo do bootstrap (seção [Banco de dados / Prisma](#banco-de-dados--prisma)) não rodou, a função existe mas devolve zero linhas.

**Aviso do Next.js sobre múltiplos `package-lock.json`**
Se você tiver um `package-lock.json` em um diretório acima do projeto (ex.: na pasta de usuário do Windows), o Next.js pode avisar sobre lockfiles duplicados ao inferir a raiz do workspace. É um aviso informativo sobre a detecção de root do monorepo — não indica falha de build; a causa raiz é a existência de outro `package-lock.json` fora do repositório, na árvore de diretórios acima dele.

**`npm run seed:dev` falha com "Set SEED_ADMIN_PASSWORD"**
O seed exige a variável `SEED_ADMIN_PASSWORD` explicitamente (não tem default) e se recusa a rodar com `NODE_ENV=production`.

## Estrutura preparada (não implementada)

Os diretórios abaixo existem em `apps/api/src/modules/` apenas como `@Module({})` vazio (sem controller, service ou rota) e já estão registrados em [`ModulesModule`](apps/api/src/modules/modules.module.ts): `ai`, `audit`, `contacts`, `conversations`, `files`, `integrations`, `knowledge`, `messages`, `tenants`, `users`, `whatsapp`. Eles representam esqueleto de arquitetura para expansão futura (atendimento/WhatsApp, IA, base de conhecimento, gestão de usuários/tenants, auditoria, integrações, upload de arquivos) — não uma funcionalidade disponível hoje. No frontend, as telas de Inbox, Base de conhecimento e Equipe já existem visualmente mas renderizam dados mockados de [`apps/web/lib/mock/data.ts`](apps/web/lib/mock/data.ts), à espera desses módulos de backend.
