# FinPlanner QA — Agente de Teste via WhatsApp Web

## Sua missão

Você é um agente de QA do FinPlanner, bot de finanças pessoais no WhatsApp.
Use o WhatsApp Web aberto no navegador para testar o bot como um usuário real:
envie mensagens, leia as respostas, avalie se estão corretas e registre os resultados.

## Pré-condição

O chat com **FinPlanner IA** já está aberto no WhatsApp Web.
Tire um screenshot agora para confirmar que o chat está visível antes de começar.

## Como executar cada teste

1. Clique na caixa de digitação do WhatsApp Web
2. Digite a mensagem exata indicada
3. Pressione Enter
4. Aguarde a resposta (máximo 10 segundos)
5. Tire screenshot da resposta
6. Avalie: ✅ PASS / ❌ FAIL / ⚠️ PARCIAL com observação

Aguarde a resposta completa antes de enviar o próximo teste.
Se o bot não responder em 10s, registre como FAIL (timeout).

---

## Bloco 1 — Saudação e Menu

**T01 — Saudação básica**
Enviar: `oi`
Esperado: boas-vindas personalizada + lista de opções do menu
FAIL se: não responder ou não mostrar opções

**T02 — Solicitar menu**
Enviar: `menu`
Esperado: menu principal com opções (relatório, registrar, pendentes...)
FAIL se: "não entendi" ou resposta irrelevante

**T03 — Palavra aleatória (não deve virar saudação)**
Enviar: `farolandia`
Esperado: "não entendi" ou fallback para menu — NÃO deve responder como boas-vindas
FAIL se: responder "Olá!" ou cumprimentar

---

## Bloco 2 — Registrar Lançamentos

**T04 — Pagar com Uber**
Enviar: `paguei 50 uber`
Esperado: confirmação de registro, categoria Transporte, valor R$ 50,00
FAIL se: não registrar, valor ou categoria errados

**T05 — Valor com vírgula**
Enviar: `paguei 12,50 café`
Esperado: valor R$ 12,50 (não R$ 1.250,00)
FAIL se: valor distorcido

**T06 — Recebimento de salário**
Enviar: `recebi 3000 salário`
Esperado: tipo "recebimento", categoria Salário, valor R$ 3.000,00
FAIL se: classificar como pagamento

**T07 — Descrição com preposição no final**
Enviar: `paguei 80 aluguel de`
Esperado: descrição "Aluguel" (sem "de" no final)
FAIL se: mostrar "Aluguel De" ou "aluguel de" na confirmação

---

## Bloco 3 — Relatórios

**T08 — Relatório geral**
Enviar: `relatório`
Esperado: relatório do mês atual com categorias, valores e total
FAIL se: "não entendi" ou período errado

**T09 — Relatório por nome do mês**
Enviar: `relatório de janeiro`
Esperado: relatório de janeiro com categorias corretas
FAIL se: dados de mês errado ou erro de parse

**T10 — Só o nome do mês**
Enviar: `fevereiro`
Esperado: relatório de fevereiro sem precisar confirmar
FAIL se: "não entendi" ou pedir mais informações

**T11 — Relatório de despesas**
Enviar: `despesas do mês`
Esperado: apenas pagamentos/saídas, sem recebimentos
FAIL se: misturar entradas e saídas

**T12 — Relatório de recebimentos**
Enviar: `recebimentos`
Esperado: apenas entradas/recebimentos
FAIL se: mostrar despesas junto

---

## Bloco 4 — Contas Pendentes

**T13 — Listar pendentes**
Enviar: `contas a pagar`
Esperado: lista numerada de contas + hint "🗑️ Para excluir, envie: excluir [número]"
FAIL se: não mostrar o hint de exclusão ou lista vazia sem aviso

**T14 — Confirmar pendente pelo número**
[Após T13 mostrar a lista]
Enviar: `1`
Esperado: bot confirma pagamento da conta 1 e volta ao menu
FAIL se: "não entendi" ou entrar em loop

**T15 — Excluir pendente**
[Iniciar novo fluxo: enviar "contas a pagar", aguardar lista]
Enviar: `excluir 1`
Esperado: "🗑️ Conta excluída com sucesso." + menu principal
FAIL se: "não entendi" ou confirmar pagamento em vez de excluir

**T16 — Excluir sem informar número**
[Durante fluxo de pendentes]
Enviar: `quero excluir`
Esperado: bot pede o número ("Para excluir, informe o número. Ex: excluir 1")
FAIL se: "não entendi" ou ignorar a intenção

**T17 — Número inexistente**
[Durante fluxo de pendentes]
Enviar: `excluir 99`
Esperado: mensagem amigável informando que a conta 99 não existe
FAIL se: crash, erro genérico ou silêncio

---

## Bloco 5 — Escape de Fluxos

**T18 — Cancelar durante fluxo**
Enviar: `paguei 50` (inicia fluxo que pede descrição)
Aguardar resposta, depois enviar: `cancelar`
Esperado: sai do fluxo, confirma cancelamento ou mostra menu
FAIL se: continuar pedindo descrição

**T19 — Cancelar com frase parcial**
[Durante qualquer fluxo ativo]
Enviar: `quero cancelar`
Esperado: sai do fluxo normalmente
FAIL se: "não entendi" ou continuar o fluxo

**T20 — Sair com "voltar"**
[Durante qualquer fluxo ativo]
Enviar: `voltar`
Esperado: retorna ao menu principal
FAIL se: continuar o fluxo ou dar erro

---

## Bloco 6 — Edge Cases

**T21 — Emoji apenas**
Enviar: `🤔`
Esperado: resposta amigável (menu ou "não entendi") — não deve travar ou dar erro

**T22 — Número muito grande**
Enviar: `paguei 99999999 algo`
Esperado: registrar ou pedir confirmação — não deve crashar

**T23 — Caracteres especiais**
Enviar: `paguei 50 café & padaria!!!`
Esperado: registrar com descrição limpa — não deve dar erro de parsing

---

## Resultado Final

Após todos os testes, me mostre:

### Tabela de Resultados

| Teste | Mensagem enviada | Status | Observação |
|-------|-----------------|--------|------------|
| T01 | oi | ✅ PASS | ... |
| T02 | menu | ❌ FAIL | ... |
| ... | ... | ... | ... |

### Bugs Encontrados

Para cada bug:
- **Teste**: T__ | **Mensagem**: `...` | **Severidade**: Crítico / Médio / Baixo
- **Recebido**: (resposta exata do bot)
- **Esperado**: (o que deveria ter respondido)

### Sugestões de Melhoria

Com base nas respostas observadas:
1. Há mensagens confusas ou difíceis de entender?
2. Algum fluxo tem passos desnecessários?
3. Faltam atalhos ou comandos úteis?
4. A linguagem está adequada para o usuário final?
5. Existe alguma função importante que não foi testada?
