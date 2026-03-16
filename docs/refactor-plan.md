# Plano de Refatoração

## Objetivo
Reduzir o acoplamento de index.js e evoluir o bot para uma arquitetura modular, previsível e testável, sem parar o funcionamento atual.

## Estado Atual
- Um arquivo central concentra bootstrap, schemas, utilitários, regras de negócio, renderização e comandos.
- O fluxo de comandos mistura parsing, permissão, banco, integração externa e formatação de resposta.
- Há domínios claros já prontos para separação: moderação, perfil/RG, comunidade, badges, auto respostas e mail.

## Estratégia
A refatoração deve ser incremental. Cada fase precisa manter o bot funcionando em produção.

## Fase 1
Extrair blocos estáveis e de baixo risco:
- modelos Mongoose
- utilitários de identidade, JID e telefone
- utilitários de texto e data puros
- renderizadores de RG e helpers visuais

## Fase 2
Criar serviços por domínio:
- ModerationService
- CommunityService
- BadgeService
- ProfileService
- AutoReplyService
- MailService
- MediaService

Cada serviço deve concentrar regra de negócio e acesso a dados relacionados ao seu domínio.

## Fase 3
Criar um sistema de comandos modular:
- CommandContext
- CommandRegistry
- handlers por categoria
- middlewares de permissão

Sugestão de estrutura:
- src/app/BotApplication.js
- src/app/CommandRegistry.js
- src/app/CommandContext.js
- src/commands/moderation
- src/commands/profile
- src/commands/community
- src/commands/system
- src/commands/media

## Fase 4
Migrar comandos críticos primeiro:
1. kick, adv, rmadv, autoban
2. perfil, rgperfil, nickname, bio
3. badges e honrarias
4. comunidade
5. respostas automáticas

## Fase 5
Adicionar classes e contratos explícitos
Classes sugeridas:
- BotApplication
- CommandDispatcher
- BaseCommand
- ModerationService
- ProfileService
- CommunityService
- BadgeService

## Regras de Migração
- não mudar assinatura pública dos comandos sem necessidade
- manter mensagens e permissões existentes enquanto possível
- mover primeiro, reescrever depois
- validar sintaxe após cada extração
- evitar refatoração cosmética durante migração funcional

## Entregas Iniciais
Já iniciadas nesta etapa:
- extração dos models para src/models
- extração dos helpers de identidade para src/utils/identity

## Próximo Passo Recomendado
Extrair o bloco de moderação para:
- src/services/ModerationService.js
- src/commands/moderation/kick.js
- src/commands/moderation/adv.js
- src/commands/moderation/rmadv.js
