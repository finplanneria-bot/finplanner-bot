#!/bin/bash
# analyze-logs.sh — Análise semanal do NLU em produção
# Uso: bash scripts/analyze-logs.sh [dias]
# Ex:  bash scripts/analyze-logs.sh 7

DAYS=${1:-7}
LOG_FILE="$HOME/.pm2/logs/finplanner-bot-out.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "❌ Log não encontrado: $LOG_FILE"
  echo "   Tente: pm2 logs finplanner-bot --nostream --lines 5000 > /tmp/fp.log"
  echo "   E rode: bash scripts/analyze-logs.sh /tmp/fp.log"
  LOG_FILE="${2:-/tmp/fp.log}"
  [ ! -f "$LOG_FILE" ] && exit 1
fi

echo ""
echo "══════════════════════════════════════════════════"
echo "  FinPlanner NLU Health Report — últimos ${DAYS} dias"
echo "══════════════════════════════════════════════════"

echo ""
echo "── Total de mensagens parseadas pelo NLU ─────────"
grep -c "\[NLU_TRACE\]" "$LOG_FILE" 2>/dev/null || echo "0"

echo ""
echo "── Distribuição de intents ────────────────────────"
grep "\[NLU_TRACE\]" "$LOG_FILE" 2>/dev/null \
  | grep -o '"intent":"[^"]*"' \
  | sed 's/"intent":"//;s/"//' \
  | sort | uniq -c | sort -rn | head -15

echo ""
echo "── Confidence baixa < 0.6 (candidatos a bug) ─────"
grep "\[NLU_TRACE\]" "$LOG_FILE" 2>/dev/null \
  | python3 -c "
import sys, json
for line in sys.stdin:
  try:
    idx = line.index('[NLU_TRACE]')
    obj = json.loads(line[idx+11:].strip())
    c = float(obj.get('confidence', 1))
    if c < 0.6:
      print(f'  conf={c:.2f}  intent={obj.get(\"intent\",\"?\")}  entries={obj.get(\"n_entries\",0)}')
  except: pass
" 2>/dev/null | head -20

echo ""
echo "── Divergências NLU vs Heurística (possíveis bugs)─"
grep "\[NLU_DIVERGE\]" "$LOG_FILE" 2>/dev/null \
  | python3 -c "
import sys, json
for line in sys.stdin:
  try:
    idx = line.index('[NLU_DIVERGE]')
    obj = json.loads(line[idx+13:].strip())
    print(f'  nlu={obj.get(\"nlu\",\"?\")}  heur={obj.get(\"heuristic\",\"?\")}  conf={obj.get(\"confidence\",\"?\")}  input={repr(obj.get(\"input\",\"\")[:60])}')
  except: pass
" 2>/dev/null | head -20

echo ""
echo "── Taxa de fallback (NLU falhou → heurística) ─────"
TOTAL=$(grep -c "\[NLU_TRACE\]" "$LOG_FILE" 2>/dev/null || echo 1)
FALLBACK=$(grep -c "\[NLU\] erro:" "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$TOTAL" -gt 0 ]; then
  PCT=$(python3 -c "print(f'{100*$FALLBACK/$TOTAL:.1f}%')" 2>/dev/null || echo "?")
  echo "  $FALLBACK / $TOTAL calls falharam ($PCT)"
  if [ "$FALLBACK" -gt 0 ] && [ "$(python3 -c "print(1 if 100*$FALLBACK/$TOTAL > 5 else 0)" 2>/dev/null)" = "1" ]; then
    echo "  ⚠️  Taxa > 5% — investigar"
  fi
fi

echo ""
echo "── Multi-entry registrados ────────────────────────"
grep "\[NLU_TRACE\]" "$LOG_FILE" 2>/dev/null \
  | python3 -c "
import sys, json
total = 0
multi = 0
for line in sys.stdin:
  try:
    idx = line.index('[NLU_TRACE]')
    obj = json.loads(line[idx+11:].strip())
    if obj.get('intent') == 'register':
      total += 1
      if obj.get('n_entries', 0) > 1:
        multi += 1
  except: pass
print(f'  {multi} multi-entry de {total} registros ({100*multi//max(total,1)}%)')
" 2>/dev/null

echo ""
echo "══════════════════════════════════════════════════"
echo "  Próximo passo: node scripts/blind-test.js"
echo "══════════════════════════════════════════════════"
echo ""
