# Demonstração do Inovasix6 Comercial

Este pacote adapta o frontend enviado em inova flow.zip. Extraia o conteúdo na raiz do projeto, junto ao package.json, aceitando a substituição dos arquivos listados abaixo. Não precisa aplicar o pacote Docker de homologação anterior.

## Funcionamento

- Abre diretamente com um visitante fictício, sem conta ou senha real.
- Dashboard, leads, funil CRM, follow-ups e agenda usam dados fictícios no navegador.
- É possível criar leads, mover etapas, criar e concluir/cancelar atividades e compromissos.
- As alterações desses módulos ficam em sessionStorage, por aba. Recarregar mantém os dados; Reiniciar demonstração restaura a amostra. Se o navegador bloquear armazenamento, usa memória.
- Inbox, conhecimento, equipe e configurações preservam as simulações visuais já existentes no projeto. Não enviam mensagens, não treinam IA nem conectam serviços reais.
- O aviso de demonstração permanece visível. Não digite dados reais.
- Sair abre a tela com o botão Entrar na demonstração.
- O modo só é ativado com NEXT_PUBLIC_DEMO_MODE=true durante o build. Sem essa variável, o fluxo original de API/autenticação é preservado.

## Publicar pelo GitHub Actions

1. No PowerShell, dentro do projeto, confira seu trabalho e crie uma branch demo a partir da versão funcional:

```powershell
cd 'C:\Users\user\Desktop\inova flow'
git status
git switch -c demo
```

Se a branch demo já existir, use `git switch demo` depois de guardar eventuais alterações pendentes. Não descarte seu trabalho.

2. Extraia este ZIP na raiz dessa cópia do projeto. Depois:

```powershell
git add .github/workflows/demo-pages.yml apps/web/next.config.ts apps/web/lib/demo/api.ts apps/web/lib/auth/api.ts apps/web/lib/auth/auth-context.tsx apps/web/components/auth/LoginForm.tsx apps/web/components/DemoBanner.tsx apps/web/app/layout.tsx apps/web/app/globals.css DEMO-GITHUB-PAGES.md
git diff --cached --stat
git commit -m "feat: adiciona demonstracao estatica para GitHub Pages"
```

3. No GitHub, abra Settings > Pages. Em Build and deployment, selecione Source: GitHub Actions. Em Settings > Environments > github-pages, confira que as regras de publicação permitem a branch demo, se houver restrições.

4. Envie a branch:

```powershell
git push -u origin demo
```

O workflow Publicar demonstracao é disparado pelo push na branch demo. Não precisa alterar main. workflow_dispatch também está definido, mas o botão manual normalmente só aparece quando o workflow existe na branch padrão; use o disparo por push para essa primeira publicação.

5. Acompanhe Actions > Publicar demonstracao. Após a etapa de deploy ficar verde, copie a URL exibida no ambiente github-pages.

Endereço esperado para este repositório, sem domínio personalizado:
https://edsong030.github.io/Inovasix6-comercial/

Esse endereço é uma previsão, não comprovação de publicação. O workflow atual usa o nome do repositório como basePath. Para domínio próprio ou repositório usuario.github.io, ajuste NEXT_PUBLIC_BASE_PATH para vazio e recompile.

Cada novo push na branch demo republica a demonstração. O workflow não publica backend, banco, .env ou código-fonte: envia somente apps/web/out.

## Build local opcional

Na raiz do projeto, com Node 22 e dependências instaladas:

```powershell
$env:NEXT_PUBLIC_DEMO_MODE='true'
$env:NEXT_PUBLIC_BASE_PATH=''
npm run build --workspace=@inovasix-flow/web
```

Sirva apps/web/out com um servidor HTTP estático. Não abra os HTMLs diretamente por file://. Para voltar ao modo normal, remova as variáveis e recompile:

```powershell
Remove-Item Env:NEXT_PUBLIC_DEMO_MODE -ErrorAction SilentlyContinue
Remove-Item Env:NEXT_PUBLIC_BASE_PATH -ErrorAction SilentlyContinue
```

## Validação realizada

- Build Next.js com exportação estática, lint e tipos: aprovado.
- Dez rotas exportadas e 17 recursos CSS/JS referenciados na home encontrados com o prefixo /Inovasix6-comercial.
- Exercício do adaptador demo: listagem, filtro, criação de lead, mudança para ganho, follow-up concluído, compromisso cancelado e atualização do total de vendas: aprovado.
- Validação visual/navegador não concluída: Chromium não estava disponível e o download excedeu o tempo limite.
- Workflow ainda não executado no GitHub. A conexão consultada tinha apenas permissão de leitura; nenhum commit ou push remoto foi realizado.

Após publicar, verifique home, CRM, criação de lead, navegação, refresh de uma rota interna, sair/entrar e reiniciar demonstração. Não deve haver chamadas de rede a localhost:3001 ou a uma API.

## Arquivos

Novos: .github/workflows/demo-pages.yml, lib/demo/api.ts, components/DemoBanner.tsx e este guia.
Alterados em apps/web: next.config.ts, lib/auth/api.ts, lib/auth/auth-context.tsx, components/auth/LoginForm.tsx, app/layout.tsx, app/globals.css.

## Referências oficiais

https://nextjs.org/docs/pages/api-reference/config/next-config-js/basePath
https://nextjs.org/docs/app/guides/static-exports
https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
