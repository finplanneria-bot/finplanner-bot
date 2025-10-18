# 💼 FinPlanner IA  
**Assistente financeira inteligente no WhatsApp**

A **FinPlanner IA** é uma automação financeira conectada ao **WhatsApp Cloud API**, com integração ao **Google Sheets**.  
Ela organiza seus **pagamentos, recebimentos e relatórios financeiros** de forma automática e simples, respondendo mensagens em linguagem natural.

---

## 🚀 Funcionalidades principais

✅ **Registro automático de gastos e ganhos**  
✅ **Detecção inteligente de intenção e status (pago / pendente)**  
✅ **Lembretes automáticos de vencimentos via WhatsApp**  
✅ **Botões interativos para confirmar pagamentos e copiar Pix / boletos**  
✅ **Relatórios mensais, trimestrais e personalizados (até 1 ano)**  
✅ **Cálculo de saldo mensal e atualização automática**  
✅ **Integração completa com Google Sheets**  

---

## ⚙️ Requisitos

- Node.js 18+  
- Conta ativa na **Meta Developers (WhatsApp Cloud API)**  
- Projeto no **Google Cloud com chave de serviço (Service Account)**  
- Planilha no Google Sheets com aba `finplanner`

---

## 🔧 Variáveis de ambiente (`.env` ou Render)

| Variável | Descrição |
|-----------|------------|
| `WA_TOKEN` | Token de acesso do WhatsApp Cloud API |
| `WA_PHONE_NUMBER_ID` | ID do número do WhatsApp Business |
| `SHEETS_ID` | ID da planilha do Google Sheets |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | E-mail da service account |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Chave privada da service account (substitua `\n` por quebras de linha) |
| `OPENAI_API_KEY` | Chave da OpenAI (opcional, para interpretação IA) |
| `USE_OPENAI` | `true` para ativar IA, `false` para heurística local |
| `WEBHOOK_VERIFY_TOKEN` | Token de verificação do webhook Meta |
| `PORT` | Porta do servidor (padrão: 3000) |

---

## 💬 Exemplos de uso no WhatsApp

### 🧾 Registrar pagamentos
